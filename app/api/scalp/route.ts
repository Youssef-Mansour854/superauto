import { NextResponse } from 'next/server';
import axios from 'axios';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import { fetchBinanceKlines, Candle } from '@/lib/binance';
import { fetchTwelveData5mKlines } from '@/lib/twelvedata';
import { fetchYahoo5mKlines } from '@/lib/yfinance';
import { calculateScalpIndicators, formatPrice } from '@/lib/indicators';
import { generateGroqArabicAlert, validateTradeConfluenceWithGroq } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';
import {
  calculatePositionSize,
  calculateDetailedPnL,
  getLiveAccountBalance,
  getLiveRiskPercent,
  getSymbolSpec,
} from '@/config/accountConfig';
import { getLiveAccountState, applyTradeResultToAccount } from '@/lib/account';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface ScalpWatchlistItem {
  symbol: string;
  source: string;
  enabled: boolean;
  notes?: string;
}

// Watchlist symbols for 5-minute High-Frequency Scalper Engine (September 9 Strategy)
export const SCALP_WATCHLIST: ScalpWatchlistItem[] = [
  { symbol: 'XAU/USD', source: 'TWELVEDATA', enabled: true },
  {
    symbol: 'EUR/USD',
    source: 'TWELVEDATA',
    enabled: false,
    notes: 'PAUSED: marginal edge even after best tuning found (session filter + TP 3.0x ATR), still net negative (-40 pips / PF 0.94 over 71 days). Revisit only with a different entry strategy (mean-reversion, not trend-following).'
  },
  {
    symbol: 'QQQ',
    source: 'TWELVEDATA',
    enabled: false,
    notes: 'DISABLED: 100% focus exclusively on Gold (XAU/USD) per trader request.'
  },
  {
    symbol: 'BTC/USD',
    source: 'TWELVEDATA',
    enabled: false,
    notes: 'REJECTED: 61.8% win rate in backtests, negative net expectancy. Strictly disabled from live engine.'
  }
];

function normalizeSymbol(symbol: string): { symbol: string; source: string } {
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD' || symbol === 'XAU/USD' || symbol === 'GOLD') {
    return { symbol: 'XAU/USD', source: 'TWELVEDATA' };
  }
  if (symbol === 'EURUSD=X' || symbol === 'EURUSD' || symbol === 'EUR/USD') {
    return { symbol: 'EUR/USD', source: 'TWELVEDATA' };
  }
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD' || symbol === 'BTC/USD') {
    return { symbol: 'BTC/USD', source: 'TWELVEDATA' };
  }
  if (symbol === '^IXIC' || symbol === 'IXIC' || symbol === 'QQQ') {
    return { symbol: 'QQQ', source: 'TWELVEDATA' };
  }
  const matching = SCALP_WATCHLIST.find(i => i.symbol === symbol);
  return matching ? { symbol: matching.symbol, source: matching.source } : { symbol, source: 'TWELVEDATA' };
}

// Per-symbol Session Filter (Africa/Cairo Time)
interface SessionFilterConfig {
  enabled: boolean;
  startHourCairo: number;
  endHourCairo: number;
}

const SESSION_FILTERS: Record<string, SessionFilterConfig> = {
  'EUR/USD': { enabled: true, startHourCairo: 0, endHourCairo: 8 },  // Block Asian session 00:00 - 08:00 Cairo
  'XAU/USD': { enabled: false, startHourCairo: 0, endHourCairo: 24 }, // 24h baseline for Gold
  'QQQ': { enabled: false, startHourCairo: 16.5, endHourCairo: 23.0 }  // Active for QQQ
};

function isSessionAllowed(symbol: string, date: Date = new Date()): boolean {
  const norm = normalizeSymbol(symbol).symbol;
  const filter = SESSION_FILTERS[norm];
  if (!filter || !filter.enabled) return true;

  const utcHours = date.getUTCHours();
  const utcMinutes = date.getUTCMinutes();
  const cairoDecimalHour = ((utcHours + 3) % 24) + (utcMinutes / 60);

  if (norm === 'EUR/USD') {
    // BLOCK_BETWEEN 00:00 and 08:00
    return !(cairoDecimalHour >= filter.startHourCairo && cairoDecimalHour < filter.endHourCairo);
  }
  // ALLOW_BETWEEN
  return cairoDecimalHour >= filter.startHourCairo && cairoDecimalHour < filter.endHourCairo;
}

function isCryptoPair(symbol: string): boolean {
  const norm = (symbol || '').toUpperCase();
  return norm.includes('BTC') || norm.includes('ETH') || norm.includes('SOL');
}

function isMarketWeekend(symbol: string, date: Date = new Date()): boolean {
  const utcDay = date.getUTCDay();
  // Saturday (6) or Sunday (0)
  if (utcDay !== 0 && utcDay !== 6) return false;
  // Crypto trades 24/7/365, never restricted on weekends
  if (isCryptoPair(symbol)) return false;
  // Forex, Metals, Indices are closed on weekends
  return true;
}

function isForexPair(symbol: string): boolean {
  const norm = symbol.toUpperCase();
  if (norm.includes('XAU') || norm.includes('XAG') || norm.includes('GOLD')) {
    return false;
  }
  if (norm.startsWith('^') || norm.includes('IXIC') || norm.includes('US30') || norm.includes('SPX') || norm.includes('NAS') || norm.includes('NDX') || norm.includes('GER') || norm.includes('DAX')) {
    return false;
  }
  if (norm.includes('BTC') || norm.includes('ETH') || norm.includes('SOL')) {
    return false;
  }
  return true;
}

async function fetchYahooGold5mCandles(): Promise<Candle[]> {
  try {
    const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=2d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000
    });
    const result = res.data?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp;
    const quotes = result.indicators?.quote?.[0];
    if (!Array.isArray(timestamps) || !quotes) return [];

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quotes.close?.[i];
      if (close !== null && close !== undefined && !isNaN(close)) {
        const timeMs = timestamps[i] * 1000;
        const open = quotes.open?.[i] || close;
        const high = quotes.high?.[i] || Math.max(open, close);
        const low = quotes.low?.[i] || Math.min(open, close);
        const volume = quotes.volume?.[i] || 0;
        candles.push({
          openTime: timeMs,
          open,
          high,
          low,
          close,
          volume,
          closeTime: timeMs + 300000
        });
      }
    }
    return candles.slice(-250);
  } catch (err: any) {
    console.warn('[Data Feed] Yahoo GC=F fetch failed:', err?.message || err);
    return [];
  }
}

async function fetchBitfinex5mKlines(): Promise<Candle[]> {
  try {
    const res = await axios.get('https://api-pub.bitfinex.com/v2/candles/trade:5m:tXAUT:USD/hist?limit=250', { timeout: 6000 });
    if (!Array.isArray(res.data) || res.data.length < 50) return [];
    return res.data.slice().reverse().map((c: any[]) => ({
      openTime: c[0],
      open: c[1],
      close: c[2],
      high: c[3],
      low: c[4],
      volume: c[5] || 0,
      closeTime: c[0] + 300000
    }));
  } catch (err: any) {
    console.warn('[Data Feed] Bitfinex fetch failed:', err?.message || err);
    return [];
  }
}

async function fetchKraken5mKlines(): Promise<Candle[]> {
  try {
    const res = await axios.get('https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=5', { timeout: 6000 });
    const pairKey = Object.keys(res.data?.result || {}).find(k => k !== 'last');
    if (!pairKey) return [];
    const rawCandles = res.data.result[pairKey];
    if (!Array.isArray(rawCandles) || rawCandles.length < 50) return [];
    return rawCandles.slice(-250).map((c: any[]) => ({
      openTime: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
      closeTime: (c[0] * 1000) + 300000
    }));
  } catch (err: any) {
    console.warn('[Data Feed] Kraken fetch failed:', err?.message || err);
    return [];
  }
}

interface CandleFetchResponse {
  candles: Candle[];
  feedSource: string;
}

async function fetchAsset5mCandles(symbol: string, source: string): Promise<CandleFetchResponse> {
  const isGold = symbol.includes('XAU') || symbol.includes('GOLD') || symbol === 'GC=F' || symbol === 'PAXGUSDT' || symbol === 'PAXGUSD';

  // 1. Primary Benchmark Feed for Gold: Real Interbank Spot Gold via Twelve Data (100% Institutional Match)
  if (isGold || source === 'TWELVEDATA') {
    const tdSymbol = isGold ? 'XAU/USD' : symbol;
    const result = await fetchTwelveData5mKlines(tdSymbol, '5min', 250);
    if (result?.candles && result.candles.length >= 100) {
      return { candles: result.candles, feedSource: 'TWELVEDATA (Interbank Spot XAU/USD Benchmark)' };
    }
  }

  // 2. Secondary Spot Gold Feed: Kraken (Spot Cash Gold PAXG/USD)
  if (isGold) {
    const krakenCandles = await fetchKraken5mKlines();
    if (krakenCandles && krakenCandles.length >= 100) {
      return { candles: krakenCandles, feedSource: 'KRAKEN (Spot Cash Gold PAXG/USD)' };
    }

    // 3. Tertiary Spot Gold Feed: Bitfinex (XAUT/USD Tether Gold Spot Cash)
    const bitfinexCandles = await fetchBitfinex5mKlines();
    if (bitfinexCandles && bitfinexCandles.length >= 100) {
      return { candles: bitfinexCandles, feedSource: 'BITFINEX (Spot Cash Gold XAUT/USD)' };
    }
  }

  // 4. High-speed Binance Feed
  if (source === 'BINANCE' || isGold) {
    try {
      const binanceSymbol = isGold ? 'PAXGUSDT' : symbol;
      const binanceCandles = await fetchBinanceKlines(binanceSymbol, '5m', 250);
      if (binanceCandles && binanceCandles.length >= 100) {
        return { candles: binanceCandles, feedSource: 'BINANCE (PAXGUSDT)' };
      }
    } catch (binanceErr: any) {
      console.warn(`[Data Feed] Binance fetch failed for ${symbol}: ${binanceErr?.message || binanceErr}`);
    }
  }

  return { candles: [], feedSource: 'NONE' };
}

async function runScalperEngine() {
  const logs: string[] = [];
  logs.push(`Starting 5m Multi-Asset Scalper Engine Cycle (September 9 Strategy) at ${new Date().toISOString()}`);

  // Market Day Filter: Per-symbol weekend check (Crypto 24/7, Forex/Indices/Gold pause on Sat/Sun)
  const currentUtcDay = new Date().getUTCDay();
  const isWeekendNow = (currentUtcDay === 0 || currentUtcDay === 6);
  logs.push(`Market Day Check: UTC day ${currentUtcDay} (Weekend: ${isWeekendNow}). Per-symbol weekend filtering active.`);

  let dbConnected = false;
  let accountState: any = null;
  let currentLiveBal = getLiveAccountBalance();

  try {
    const db = await connectToDatabase();
    if (db) {
      dbConnected = true;
      accountState = await getLiveAccountState();
      if (accountState && typeof accountState.currentBalance === 'number') {
        currentLiveBal = accountState.currentBalance;
      }
    }
  } catch (err: any) {
    logs.push(`MongoDB warning: ${err?.message || err}`);
  }

  // 1. Evaluate Pending Trades in Database (tradeType: 'SCALP')
  // Strictly query active 'ALERT_SENT' trades so archived trades are never re-evaluated
  if (dbConnected) {
    try {
      const pendingTrades = await Trade.find({ status: 'ALERT_SENT', tradeType: 'SCALP' });
      if (pendingTrades.length > 0) {
        logs.push(`Evaluating ${pendingTrades.length} pending scalp trade(s)...`);
        for (const trade of pendingTrades) {
          const matchingItem = normalizeSymbol(trade.symbol);
          if (isMarketWeekend(matchingItem.symbol)) {
            logs.push(`[${matchingItem.symbol}] Market closed (weekend), skipping pending evaluation.`);
            continue;
          }
          const fetchRes = await fetchAsset5mCandles(matchingItem.symbol, matchingItem.source);
          const candles = fetchRes.candles;
          if (!candles || candles.length === 0) {
            logs.push(`[Pending Evaluation] Could not fetch candles for ${trade.symbol} (${fetchRes.feedSource}). Will retry next cycle.`);
            continue;
          }

          if (candles && candles.length > 0) {
            const entryTimeMs = trade.timestamp ? new Date(trade.timestamp).getTime() : 0;

            // 1. فحص جميع الشموع التي تكونت منذ لحظة فتح الصفقة وحتى الآن (وليس فقط آخر شمعة!)
            // لضمان عدم تفويت أي ذيل لمس الهدف في أي دقيقة سابقة
            const candlesSinceEntry = candles.filter(c => {
              const candleCloseTime = c.closeTime || (c.openTime + 300000);
              return candleCloseTime >= (entryTimeMs - 60000);
            });
            const evalCandles = candlesSinceEntry.length > 0 ? candlesSinceEntry : [candles[candles.length - 1]];

            const currentCandle = candles[candles.length - 1];
            const currentPrice = currentCandle.close;
            const candleHigh = currentCandle.high !== undefined ? currentCandle.high : currentPrice;
            const candleLow = currentCandle.low !== undefined ? currentCandle.low : currentPrice;

            // أعلى وأدنى سعر سُجل في أي لحظة عبر جميع الشموع منذ فتح الصفقة:
            const highestHighSinceEntry = Math.max(...evalCandles.map(c => c.high !== undefined ? c.high : c.close));
            const lowestLowSinceEntry = Math.min(...evalCandles.map(c => c.low !== undefined ? c.low : c.close));

            // هامش تفاوت فيد السحابة وبروكر MT5 (0.50 نقطة):
            const isGold = matchingItem.symbol.includes('XAU') || matchingItem.symbol.includes('GOLD');
            // الهدف يجب أن يُلمس فعلياً بالكامل لمطابقة أوامر Limit في MT5 بدون أي أهداف وهمية:
            const tpTolerance = 0.0;

            logs.push(`[Pending Trade ${trade.symbol}] Current: ${formatPrice(currentPrice)} | High: ${formatPrice(candleHigh)} (Max since entry: ${formatPrice(highestHighSinceEntry)}) | Low: ${formatPrice(candleLow)} (Min since entry: ${formatPrice(lowestLowSinceEntry)}) | TP: ${formatPrice(trade.tp)} | SL: ${formatPrice(trade.sl)}`);
            let newStatus: 'WIN' | 'LOSS' | 'BREAKEVEN' | null = null;
            let exitPrice = currentPrice;

            // HYBRID SAFETY NET LOGIC (Enhanced Baseline Strategy):
            // 1. Take Profit (Wick on High/Low across ALL candles since entry + Tolerance)
            // 2. Breakeven Stop: if breakeven/profit lock applied, triggers at trade.sl
            // 3. Soft Stop (1.5x ATR): triggers ONLY on candle CLOSE before breakeven
            // 4. Hard Catastrophic Stop (3.0x ATR): triggers on candle wick to protect against flash crashes
            const isQQQ = matchingItem.symbol.includes('QQQ') || matchingItem.symbol.includes('IXIC');
            const hardSlMult = isQQQ ? 2.5 : 3.0;
            const atrVal = trade.atr || (Math.abs(trade.sl - trade.entryPrice) / 1.5);

            if (trade.action === 'BUY') {
              // فحص لمس الهدف عبر جميع الشموع منذ الدخول مع هامش التفاوت
              const tpHit = (highestHighSinceEntry + tpTolerance) >= trade.tp;

              if (tpHit) {
                newStatus = 'WIN';
                exitPrice = trade.tp;
              } else if (trade.breakevenApplied) {
                // إذا تم تأمين الصفقة (بريك إيفن بسيط أو كبير): يخرج عند لمس الوقف المؤمن trade.sl
                const beSlHit = candleLow <= trade.sl || currentPrice <= trade.sl;
                if (beSlHit) {
                  newStatus = 'BREAKEVEN';
                  exitPrice = trade.sl;
                }
              } else {
                // صفقة عادية قبل التأمين:
                const hardSl = trade.entryPrice - (atrVal * hardSlMult);
                const hardSlHit = candleLow <= hardSl;
                const softSlHit = currentPrice <= trade.sl; // إغلاق شمعة الـ 5 دقائق تحت الوقف

                if (hardSlHit) {
                  newStatus = 'LOSS';
                  exitPrice = hardSl;
                } else if (softSlHit) {
                  newStatus = 'LOSS';
                  exitPrice = trade.sl;
                }
              }
            } else if (trade.action === 'SELL') {
              // فحص لمس الهدف عبر جميع الشموع منذ الدخول مع هامش التفاوت
              const tpHit = (lowestLowSinceEntry - tpTolerance) <= trade.tp;

              if (tpHit) {
                newStatus = 'WIN';
                exitPrice = trade.tp;
              } else if (trade.breakevenApplied) {
                // إذا تم تأمين الصفقة (بريك إيفن بسيط أو كبير): يخرج عند لمس الوقف المؤمن trade.sl
                const beSlHit = candleHigh >= trade.sl || currentPrice >= trade.sl;
                if (beSlHit) {
                  newStatus = 'BREAKEVEN';
                  exitPrice = trade.sl;
                }
              } else {
                // صفقة عادية قبل التأمين:
                const hardSl = trade.entryPrice + (atrVal * hardSlMult);
                const hardSlHit = candleHigh >= hardSl;
                const softSlHit = currentPrice >= trade.sl; // إغلاق شمعة الـ 5 دقائق فوق الوقف

                if (hardSlHit) {
                  newStatus = 'LOSS';
                  exitPrice = hardSl;
                } else if (softSlHit) {
                  newStatus = 'LOSS';
                  exitPrice = trade.sl;
                }
              }
            }

            if (newStatus) {
              const closedAt = new Date();
              const indExit = candles.length >= 100 ? calculateScalpIndicators(candles) : null;

              // Calculate PnL (points and USD with fees)
              const pnlPoints = trade.action === 'BUY'
                ? exitPrice - trade.entryPrice
                : trade.entryPrice - exitPrice;
              const lotSize = trade.suggestedLotSize || 0.01;
              const isBe = newStatus === 'BREAKEVEN';
              const detailed = calculateDetailedPnL(pnlPoints, lotSize, trade.symbol, isBe);

              // Update live account balance in MongoDB
              const accountUpdate = await applyTradeResultToAccount(
                detailed.netPnLUSD,
                newStatus,
                trade._id.toString()
              );
              currentLiveBal = accountUpdate.newBalance;

              // Move trade to TradeHistory archive collection for ML/AI retention
              await TradeHistory.create({
                tradeId: trade._id.toString(),
                symbol: trade.symbol,
                action: trade.action,
                tradeType: trade.tradeType,
                entryPrice: trade.entryPrice,
                exitPrice,
                sl: trade.sl,
                tp: trade.tp,
                status: newStatus,
                suggestedLotSize: lotSize,
                pnlPoints: Number(pnlPoints.toFixed(4)),
                grossPnLUSD: detailed.grossPnLUSD,
                tradingFeeUSD: detailed.tradingFeeUSD,
                netPnLUSD: detailed.netPnLUSD,
                balanceAfterTrade: accountUpdate.newBalance,
                rsi: trade.rsi,
                ema20: trade.ema20,
                ema100: trade.ema100 || trade.ema200,
                atr: trade.atr,
                exitRsi: indExit ? indExit.currentRsi : undefined,
                exitEma20: indExit ? indExit.currentEma20 : undefined,
                exitEma100: indExit ? indExit.currentEma100 : undefined,
                exitAtr: indExit ? indExit.currentAtr : undefined,
                groqAnalysis: trade.groqAnalysis,
                entryTimestamp: trade.timestamp,
                closedAt
              });

              // Update active trade status to ARCHIVED so it is removed from pending list
              trade.status = 'ARCHIVED';
              trade.exitPrice = exitPrice;
              trade.closedAt = closedAt;
              trade.pnlPoints = Number(pnlPoints.toFixed(4));
              trade.netPnLUSD = detailed.netPnLUSD;
              trade.balanceAfterTrade = accountUpdate.newBalance;
              await trade.save();

              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) archived with result ${newStatus} (Net: ${detailed.netPnLUSD.toFixed(2)} USD)`);

              let outcomeText = '';
              if (newStatus === 'WIN') {
                outcomeText = `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: ${formatPrice(exitPrice)}\nالربح المحقق: +${pnlPoints.toFixed(2)} نقطة (+${detailed.netPnLUSD.toFixed(2)} دولار)\nرصيد الحساب الجديد: ${accountUpdate.newBalance.toFixed(2)} دولار`;
              } else if (newStatus === 'BREAKEVEN') {
                const pnlSign = detailed.netPnLUSD >= 0 ? '+' : '';
                const isBigBe = pnlPoints >= 1.5;
                const beTitle = isBigBe ? '🔒 **إغلاق بتأمين أرباح متقدم (Breakeven كبير)!** 💵' : '🛡 **إغلاق على تأمين الدخول (BREAKEVEN)!** ⚖️';
                outcomeText = `${beTitle}\nالرمز: ${trade.symbol}\nسعر الخروج: ${formatPrice(exitPrice)}\nالربح المحقق: +${pnlPoints.toFixed(2)} نقطة (${pnlSign}${detailed.netPnLUSD.toFixed(2)} دولار صافي بعد السبريد)\nرصيد الحساب: ${accountUpdate.newBalance.toFixed(2)} دولار`;
              } else {
                outcomeText = `📉 **ضرب وقف الخسارة! (LOSS)** 🛡\nالرمز: ${trade.symbol}\nسعر الخروج: ${formatPrice(exitPrice)}\nالخسارة: ${pnlPoints.toFixed(2)} نقطة (${detailed.netPnLUSD.toFixed(2)} دولار)\nرصيد الحساب: ${accountUpdate.newBalance.toFixed(2)} دولار`;
              }
              await sendTelegramNotification(outcomeText);

              // Risk Alert: Check for 4+ consecutive losses today (Monitoring only, no automated blocking)
              if (newStatus === 'LOSS') {
                try {
                  const startOfDay = new Date();
                  startOfDay.setUTCHours(0, 0, 0, 0);

                  const recentToday = await TradeHistory.find({
                    closedAt: { $gte: startOfDay }
                  }).sort({ closedAt: -1 }).limit(10);

                  let consecLosses = 0;
                  for (const t of recentToday) {
                    if (t.status === 'LOSS') consecLosses++;
                    else break;
                  }

                  if (consecLosses >= 4) {
                    const warningMsg = `⚠️ **تحذير إدارة المخاطر**: تم تسجيل ${consecLosses} خسائر متتالية اليوم!\nيرجى توخي الحذر ومتابعة حالة السوق.`;
                    await sendTelegramNotification(warningMsg);
                    logs.push(warningMsg);
                  }
                } catch (lossErr: any) {
                  console.error('Error checking consecutive losses:', lossErr?.message || lossErr);
                }
              }
            } else {
              // -------------------------------------------------------------
              // Trade Management: Enhanced Breakeven & Smart Time Stop (Baseline Strategy)
              // -------------------------------------------------------------

              // 1. Enhanced Breakeven Activation (50% Target) & Major Profit Lock (80% Target):
              const totalTargetPoints = Math.abs(trade.tp - trade.entryPrice);
              const isBuy = trade.action === 'BUY';

              // أ. المستوى الأول (50% من مسار الهدف): تأمين الدخول بربح بسيط (+0.50 نقطة) لتصبح صفقة خالية من المخاطرة 100%
              if (!trade.breakevenApplied) {
                const target50 = isBuy
                  ? trade.entryPrice + 0.5 * totalTargetPoints
                  : trade.entryPrice - 0.5 * totalTargetPoints;

                const is50PercentReached = isBuy
                  ? (highestHighSinceEntry >= target50 || currentPrice >= target50)
                  : (lowestLowSinceEntry <= target50 || currentPrice <= target50);

                if (is50PercentReached) {
                  const isGold = matchingItem.symbol.includes('XAU') || matchingItem.symbol.includes('GOLD');
                  const beBuffer = isGold ? 0.50 : 0.0;
                  const newSl = isBuy
                    ? Number((trade.entryPrice + beBuffer).toFixed(2))
                    : Number((trade.entryPrice - beBuffer).toFixed(2));

                  trade.sl = newSl;
                  trade.breakevenApplied = true;
                  await trade.save();

                  const breakevenMsg = `🛡️ تأمين الصفقة بربح بسيط (Enhanced Breakeven) 🎯\n- الأصل: ${trade.symbol}\n- وصول السعر إلى 50% من مسار الهدف!\n- تم رفع الوقف إلى ${formatPrice(newSl)} لحجز ربح +${beBuffer} نقطة وتغطية السبريد بالكامل (صفقة خالية من المخاطرة 100%)!`;
                  logs.push(breakevenMsg);
                  console.log(breakevenMsg);
                  await sendTelegramNotification(breakevenMsg);
                }
              }

              // بعد تأمين الصفقة: تفعيل مستويات حجز الأرباح التدريجية لضمان عدم ضياع الأرباح عند الارتداد المفاجئ:
              if (trade.breakevenApplied) {
                const currentFloatingPoints = isBuy ? (highestHighSinceEntry - trade.entryPrice) : (trade.entryPrice - lowestLowSinceEntry);
                const progressRatio = totalTargetPoints > 0 ? (currentFloatingPoints / totalTargetPoints) : 0;
                let candidateSl: number | null = null;
                let lockMsgType = '';
                let lockedPoints = 0;

                // ب. المستوى الثالث (80% من مسار الهدف أو ربح >= 5.0 نقاط): Breakeven كبير لحجز 65% من أرباح الهدف كاش
                if (progressRatio >= 0.80 || currentFloatingPoints >= 5.0) {
                  lockedPoints = Number((totalTargetPoints * 0.65).toFixed(2));
                  candidateSl = isBuy
                    ? Number((trade.entryPrice + lockedPoints).toFixed(2))
                    : Number((trade.entryPrice - lockedPoints).toFixed(2));
                  lockMsgType = '🔒 تأمين أرباح كبير (Breakeven كبير 80%) 🎯';
                }
                // ج. المستوى الثاني (65% من مسار الهدف أو ربح >= 3.5 نقاط): حجز 40% من أرباح الهدف (أو 2.5 نقطة على الأقل) كاش
                else if (progressRatio >= 0.65 || currentFloatingPoints >= 3.5) {
                  lockedPoints = Math.max(2.50, Number((totalTargetPoints * 0.40).toFixed(2)));
                  candidateSl = isBuy
                    ? Number((trade.entryPrice + lockedPoints).toFixed(2))
                    : Number((trade.entryPrice - lockedPoints).toFixed(2));
                  lockMsgType = '🔒 تأمين أرباح متقدم (Tier 2 Profit Lock) 💵';
                }

                if (candidateSl !== null) {
                  const isImprovement = isBuy ? candidateSl > trade.sl : candidateSl < trade.sl;
                  if (isImprovement) {
                    trade.sl = candidateSl;
                    await trade.save();

                    const lotSize = trade.suggestedLotSize || 0.01;
                    const approxCashUSD = (lockedPoints * lotSize * (matchingItem.symbol.includes('XAU') ? 100 : 1)).toFixed(2);
                    const progressPct = (progressRatio * 100).toFixed(0);
                    const lockMsg = `${lockMsgType}\n- الأصل: ${trade.symbol}\n- تقدمت الصفقة بنسبة ${progressPct}% (+ ${currentFloatingPoints.toFixed(2)} نقطة)!\n- تم رفع الوقف إلى ${formatPrice(candidateSl)} لحجز +${lockedPoints} نقطة كاش (+${approxCashUSD}$ ربح مضمون 100%)!\n- الصفقة مستمرة بكامل حريتها لاقتناص كامل الهدف 100% 🚀`;
                    logs.push(lockMsg);
                    console.log(lockMsg);
                    await sendTelegramNotification(lockMsg);
                  }
                }
              }

              // 2. Smart Time Stop Logic (120 min max holding time: move SL to Breakeven if in profit, close if floating in loss)
              const entryTime = trade.timestamp ? new Date(trade.timestamp).getTime() : 0;
              const timeElapsedMs = Date.now() - entryTime;

              if (entryTime > 0 && timeElapsedMs >= 7200000) { // 120 minutes
                const isProfit = trade.action === 'BUY'
                  ? currentPrice > trade.entryPrice
                  : currentPrice < trade.entryPrice;

                if (isProfit) {
                  if (!trade.breakevenApplied || trade.sl !== trade.entryPrice) {
                    const isGold = matchingItem.symbol.includes('XAU') || matchingItem.symbol.includes('GOLD');
                    const beBuffer = isGold ? 0.50 : 0.0;
                    const newSl = trade.action === 'BUY'
                      ? Number((trade.entryPrice + beBuffer).toFixed(2))
                      : Number((trade.entryPrice - beBuffer).toFixed(2));
                    trade.sl = newSl;
                    trade.breakevenApplied = true;
                    await trade.save();

                    const timeStopMsg = `⏱️ **(SMART TIME STOP)**\nمرور 120 دقيقة والصفقة رابحة! تم تحريك الستوب إلى تأمين الدخول (Breakeven +${beBuffer} نقطة) لرمز ${trade.symbol}.`;
                    logs.push(timeStopMsg);
                    console.log(timeStopMsg);
                    await sendTelegramNotification(timeStopMsg);
                  }
                } else {
                  // Floating in loss - close trade at market price
                  const closedAt = new Date();
                  const indExit = candles.length >= 100 ? calculateScalpIndicators(candles) : null;
                  const pnlPoints = trade.action === 'BUY' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
                  const lotSize = trade.suggestedLotSize || 0.01;
                  const detailed = calculateDetailedPnL(pnlPoints, lotSize, trade.symbol, false);
                  const accountUpdate = await applyTradeResultToAccount(detailed.netPnLUSD, 'LOSS', trade._id.toString());
                  currentLiveBal = accountUpdate.newBalance;

                  await TradeHistory.create({
                    tradeId: trade._id.toString(),
                    symbol: trade.symbol,
                    action: trade.action,
                    tradeType: trade.tradeType,
                    entryPrice: trade.entryPrice,
                    exitPrice: currentPrice,
                    sl: trade.sl,
                    tp: trade.tp,
                    status: 'LOSS',
                    suggestedLotSize: lotSize,
                    pnlPoints: Number(pnlPoints.toFixed(4)),
                    grossPnLUSD: detailed.grossPnLUSD,
                    tradingFeeUSD: detailed.tradingFeeUSD,
                    netPnLUSD: detailed.netPnLUSD,
                    balanceAfterTrade: accountUpdate.newBalance,
                    rsi: trade.rsi,
                    ema20: trade.ema20,
                    ema100: trade.ema100 || trade.ema200,
                    atr: trade.atr,
                    exitRsi: indExit ? indExit.currentRsi : undefined,
                    exitEma20: indExit ? indExit.currentEma20 : undefined,
                    exitEma100: indExit ? indExit.currentEma100 : undefined,
                    exitAtr: indExit ? indExit.currentAtr : undefined,
                    groqAnalysis: trade.groqAnalysis,
                    entryTimestamp: trade.timestamp,
                    closedAt
                  });

                  trade.status = 'ARCHIVED';
                  trade.exitPrice = currentPrice;
                  trade.closedAt = closedAt;
                  trade.pnlPoints = Number(pnlPoints.toFixed(4));
                  trade.netPnLUSD = detailed.netPnLUSD;
                  trade.balanceAfterTrade = accountUpdate.newBalance;
                  await trade.save();

                  const timeStopMsg = `⏱️ **(TIME STOP)**\nمرور 120 دقيقة والصفقة خاسرة. تم إغلاق الصفقة بسعر السوق ${formatPrice(currentPrice)} لرمز ${trade.symbol} لتفريغ السيولة (الخسارة: ${detailed.netPnLUSD.toFixed(2)} دولار).\nرصيد الحساب: ${accountUpdate.newBalance.toFixed(2)} دولار`;
                  logs.push(timeStopMsg);
                  console.log(timeStopMsg);
                  await sendTelegramNotification(timeStopMsg);
                }
              }
            }
          }
        }
      }
    } catch (pendingErr: any) {
      logs.push(`Error evaluating pending scalp trades: ${pendingErr?.message || pendingErr}`);
    }
  }

  // 2. Intra-bar Safe Gate: When NO trade is open, ONLY scan for entries on 5-minute candle closes (:00, :05, :10, :15...)
  const currentMinute = new Date().getUTCMinutes();
  const is5mCandleBoundary = (currentMinute % 5 === 0);

  if (!is5mCandleBoundary) {
    const idleMsg = `[Intra-5m Safe Gate] Minute :${currentMinute.toString().padStart(2, '0')} is an intra-bar monitoring cycle. New entry scan is scheduled for 5m candle close boundaries (:00, :05, :10...). Skipping new scan.`;
    logs.push(idleMsg);
    return {
      success: true,
      engine: '5m High-Frequency Scalper (Adaptive 1m Monitor / 5m Entry)',
      mode: 'INTRA_5M_MONITOR_IDLE',
      currentMinute,
      logs
    };
  }

  // 3. Filter active assets and iterate concurrently (Promise.allSettled)
  const activeWatchlist = SCALP_WATCHLIST.filter(item => item.enabled);
  logs.push(`Active Watchlist (${activeWatchlist.length} assets): ${activeWatchlist.map(a => a.symbol).join(', ')}`);

  const assetPromises = activeWatchlist.map(async (item) => {
    const { symbol, source } = item;
    try {
      if (isMarketWeekend(symbol)) {
        const weekendMsg = `[${symbol}] Weekend detected: Market closed for this asset. Skipping.`;
        console.log(weekendMsg);
        logs.push(weekendMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: weekendMsg };
      }

      if (dbConnected) {
        const activeTrade = await Trade.findOne({
          symbol: { $in: [symbol, symbol.replace('/', ''), symbol.replace('/', '-'), `^${symbol}`, symbol.replace('^', '')] },
          status: 'ALERT_SENT'
        });
        if (activeTrade) {
          const skipMsg = `Active trade exists for ${symbol}, skipping new entry evaluation.`;
          console.log(skipMsg);
          logs.push(skipMsg);
          return { symbol, signalTriggered: false, skipped: true, reason: skipMsg };
        }
      }

      logs.push(`Processing 5m candles for ${symbol} via ${source}...`);
      const fetchRes = await fetchAsset5mCandles(symbol, source);
      const candles = fetchRes.candles;

      if (!candles || candles.length < 100) {
        const msg = `Insufficient candle data for ${symbol} (${fetchRes.feedSource}). Skipping.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const ind = calculateScalpIndicators(candles);
      if (!ind) {
        const msg = `Failed to calculate indicators for ${symbol}. Skipping.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const { currentClose, currentLow, currentHigh, currentEma20, currentEma100, currentEma200, currentRsi, prevRsi, currentAtr } = ind;
      const latestCandleTime = new Date(candles[candles.length - 1].openTime).toLocaleTimeString('en-US', { timeZone: 'Africa/Cairo' });
      logs.push(`[Data Feed Confirmed: ${fetchRes.feedSource}] Fetched ${candles.length} candles for ${symbol}. Latest price: ${currentClose} (Candle Cairo time: ${latestCandleTime})`);

      // توافق الصورة الكبيرة والاتجاه العام (Macro Trend Confluence via EMA200 & EMA100):
      // EMA200 على فريم الـ 5 دقائق = 16.6 ساعة حركة سعر (الاتجاه الكلي لليوم).
      // EMA100 = 8.3 ساعات (اتجاه الجلسة الحالي).
      const isMacroBullish = currentClose > currentEma100 && (currentEma200 ? currentClose > currentEma200 : true);
      const isMacroBearish = currentClose < currentEma100 && (currentEma200 ? currentClose < currentEma200 : true);

      // فلتر عدم ملاحقة السعر (Anti-Chasing Value Zone): الدخول بالقرب من EMA20 وليس عند قمم وقيعان متطرفة
      const isWithinBuyZone = (currentClose - currentEma20) <= (currentAtr * 0.85);
      const isWithinSellZone = (currentEma20 - currentClose) <= (currentAtr * 0.85);

      // Trend-Filtered Dynamic Momentum Strategy Rules:
      // 1. Initial Crossover Trigger (RSI Level 50 Crossover in Trend):
      const isBuyCrossover = isMacroBullish && currentClose > currentEma20 && prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68 && isWithinBuyZone;
      const isSellCrossover = isMacroBearish && currentClose < currentEma20 && prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32 && isWithinSellZone;

      // 2. Trend Continuation Pullback / Retest to EMA20 Trigger:
      const isBuyPullback = isMacroBullish && currentEma20 > currentEma100 && currentLow <= currentEma20 && currentClose >= currentEma20 && currentRsi >= 48 && currentRsi <= 68;
      const isSellPullback = isMacroBearish && currentEma20 < currentEma100 && currentHigh >= currentEma20 && currentClose <= currentEma20 && currentRsi <= 52 && currentRsi >= 32;

      let signalType: 'BUY' | 'SELL' | null = null;
      let triggerReason: 'CROSSOVER' | 'PULLBACK' | null = null;

      if (isBuyCrossover || isBuyPullback) {
        signalType = 'BUY';
        triggerReason = isBuyCrossover ? 'CROSSOVER' : 'PULLBACK';
      } else if (isSellCrossover || isSellPullback) {
        signalType = 'SELL';
        triggerReason = isSellCrossover ? 'CROSSOVER' : 'PULLBACK';
      }

      if (!signalType) {
        return { symbol, signalTriggered: false, close: currentClose, rsi: currentRsi, ema20: currentEma20, ema100: currentEma100, atr: currentAtr };
      }

      // Session Filter Check
      if (!isSessionAllowed(symbol)) {
        const sessMsg = `[${symbol}] Outside allowed trading session. Skipping.`;
        logs.push(sessMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: sessMsg };
      }

      logs.push(`🚨 ${signalType} Scalp Signal Triggered for ${symbol}!`);

      // Dynamic Risk Management (ATR-based SL & TP)
      // 2.0 * ATR Take Profit across assets (September 7 update)
      const tpMultiplier = 2.0;

      const sl = signalType === 'BUY'
        ? currentClose - (currentAtr * 1.5)
        : currentClose + (currentAtr * 1.5);

      const tp = signalType === 'BUY'
        ? currentClose + (currentAtr * tpMultiplier)
        : currentClose - (currentAtr * tpMultiplier);

      // Dynamic lot sizing suggestion based on account balance & risk
      const spec = getSymbolSpec(symbol);
      const posSize = calculatePositionSize(
        currentClose,
        sl,
        currentLiveBal,
        getLiveRiskPercent(),
        spec.contractSize
      );

      // 🛡️ فحص سقف المخاطرة الأقصى (Max Risk Cap $7.00):
      // حماية الحساب من قفزات الـ ATR العنيفة وقت الأخبار (لمنع خسائر 13$)
      if (posSize.exceedsMaxRiskCap) {
        const capMsg = `[${symbol}] 🚨 تجاوز سقف المخاطرة الأقصى (${posSize.actualRiskUSD.toFixed(2)} > $7.00) بسبب اتساع الـ ATR (${currentAtr.toFixed(2)} نقطة) وقت التقلبات العنيفة. تم إلغاء الإشارة تلقائياً لحماية رأس المال.`;
        logs.push(capMsg);
        console.warn(capMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: capMsg };
      }

      const signalDetails = {
        symbol,
        action: signalType,
        entryPrice: currentClose,
        sl,
        tp,
        suggestedLotSize: posSize.lotSize,
        rsi: currentRsi,
        ema20: currentEma20,
        ema100: currentEma100,
        ema200: currentEma200,
        atr: currentAtr
      };

      // 🤖 Groq AI Parallel Processing: تقييم الذكاء وتوليد التنبيه في نفس اللحظة بالتوازي لتقليل التأخير إلى أقصى حد
      const isMondayToday = new Date().getUTCDay() === 1;
      const [groqValidation, groqAnalysis] = await Promise.all([
        validateTradeConfluenceWithGroq({
          symbol,
          action: signalType,
          triggerReason: triggerReason || 'CROSSOVER',
          entryPrice: currentClose,
          sl,
          tp,
          rsi: currentRsi,
          ema20: currentEma20,
          ema100: currentEma100,
          ema200: currentEma200,
          atr: currentAtr,
          isMonday: isMondayToday
        }),
        generateGroqArabicAlert(signalDetails)
      ]);

      logs.push(`🤖 [${symbol}] تقييم Groq AI للصفقة: ${groqValidation.score}/10 | السبب: ${groqValidation.reason}`);

      // Save to MongoDB with tradeType: 'SCALP'
      if (dbConnected) {
        try {
          const newTrade = new Trade({
            ...signalDetails,
            tradeType: 'SCALP',
            groqAnalysis,
            status: 'ALERT_SENT',
            timestamp: new Date()
          });
          await newTrade.save();
        } catch (saveErr: any) {
          logs.push(`Database log error for ${symbol}: ${saveErr?.message || saveErr}`);
        }
      }

      // 50% Breakeven Target level for immediate trader notification
      const beTargetPrice = signalType === 'BUY'
        ? currentClose + 0.5 * (tp - currentClose)
        : currentClose - 0.5 * (currentClose - tp);

      const entryTypeArabic = triggerReason === 'PULLBACK'
        ? '🎯 ارتداد وإعادة اختبار (EMA20 Pullback)'
        : '⚡ تقاطع زخم مع الاتجاه (RSI Crossover)';

      // Send Telegram Alert
      const macroInfo = currentEma200 ? ` | EMA200 (الصورة الكبيرة): ${formatPrice(currentEma200)}` : '';
      const telegramMsg = `${groqAnalysis}\n\n📊 **تفاصيل السكالبينج مع الصورة الكبيرة:**\n- الأصل: ${symbol}\n- نوع الصفقة: ${signalType === 'BUY' ? '🟢 شراء (BUY)' : '🔴 بيع (SELL)'}\n- نوع الدخول: ${entryTypeArabic}\n- 🤖 تقييم الذكاء الاصطناعي (Groq Score): **${groqValidation.score}/10** (${groqValidation.reason})\n- سعر الدخول: ${formatPrice(currentClose)}\n- حجم اللوت المقترح: ${posSize.lotSize.toFixed(2)} لوت (المخاطرة: ${posSize.actualRiskUSD.toFixed(2)} دولار)\n- وقف الخسارة SL (1.5x ATR): ${formatPrice(sl)}\n- الهدف TP (2.0x ATR): ${formatPrice(tp)}\n- 🛡️ مستوى نقل الستوب للدخول (50% Breakeven): ${formatPrice(beTargetPrice)}\n- مؤشر ATR (14): ${formatPrice(signalDetails.atr)} نقطة\n- مؤشر RSI (14): ${formatPrice(signalDetails.rsi)} | EMA20: ${formatPrice(signalDetails.ema20)} | EMA100: ${formatPrice(signalDetails.ema100)}${macroInfo}`;
      await sendTelegramNotification(telegramMsg);

      return { symbol, signalTriggered: true, signal: signalDetails, groqAnalysis, groqValidation };

    } catch (assetErr: any) {
      const errMsg = `Error processing scalp asset ${symbol}: ${assetErr?.message || assetErr}`;
      logs.push(errMsg);
      return { symbol, signalTriggered: false, error: errMsg };
    }
  });

  const settledResults = await Promise.allSettled(assetPromises);

  const results = settledResults.map((res, index) => {
    if (res.status === 'fulfilled') {
      return res.value;
    } else {
      const symbol = activeWatchlist[index]?.symbol || 'UNKNOWN';
      const errMsg = `Unhandled rejection for ${symbol}: ${res.reason?.message || res.reason}`;
      logs.push(errMsg);
      return { symbol, signalTriggered: false, error: errMsg };
    }
  });

  return {
    success: true,
    engine: '5m High-Frequency Scalper (September 9 Baseline)',
    account: {
      currentBalance: currentLiveBal,
      initialBalance: accountState ? accountState.initialBalance : getLiveAccountBalance(),
      totalPnL: accountState ? accountState.totalPnL : 0,
      totalTrades: accountState ? accountState.totalTrades : 0,
      winsCount: accountState ? accountState.winsCount : 0,
      lossesCount: accountState ? accountState.lossesCount : 0
    },
    processedAssets: activeWatchlist.length,
    activeAssets: activeWatchlist.map(a => a.symbol),
    disabledAssets: SCALP_WATCHLIST.filter(a => !a.enabled).map(a => ({ symbol: a.symbol, reason: a.notes })),
    results,
    logs
  };
}

export async function GET() {
  try {
    const output = await runScalperEngine();
    return NextResponse.json(output, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Scalper Engine Failure' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const output = await runScalperEngine();
    return NextResponse.json(output, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Scalper Engine Failure' }, { status: 500 });
  }
}
