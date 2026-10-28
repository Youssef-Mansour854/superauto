import { NextResponse } from 'next/server';
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
  { symbol: 'XAU/USD', source: 'BINANCE', enabled: true },
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
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD' || symbol === 'XAU/USD') {
    return { symbol: 'XAU/USD', source: 'BINANCE' };
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

async function fetchAsset5mCandles(symbol: string, source: string): Promise<Candle[]> {
  const isGold = symbol.includes('XAU') || symbol.includes('GOLD') || symbol === 'GC=F' || symbol === 'PAXGUSDT';

  // 1. Ultra-Fast Zero-Delay Real-time Spot Feed for Gold via Binance (PAXGUSDT tracks spot gold 1:1 down to the cent with 0 seconds latency)
  if (source === 'BINANCE' || isGold) {
    try {
      const binanceSymbol = isGold ? 'PAXGUSDT' : symbol;
      const binanceCandles = await fetchBinanceKlines(binanceSymbol, '5m', 250);
      if (binanceCandles && binanceCandles.length >= 100) {
        return binanceCandles;
      }
    } catch (binanceErr: any) {
      console.warn(`[Data Feed] Binance fetch failed for ${symbol}: ${binanceErr?.message || binanceErr}, trying fallbacks...`);
    }
  }

  // 2. High-reliability Fallback: Yahoo Finance
  if (source === 'YAHOO' || isGold) {
    const yahooCandles = await fetchYahoo5mKlines(symbol);
    if (yahooCandles && yahooCandles.length > 0) {
      return yahooCandles;
    }
  }

  // 3. Fallback: Twelve Data
  const result = await fetchTwelveData5mKlines(symbol, '5min', 250);
  if (result?.candles && result.candles.length > 0) {
    return result.candles;
  }
  return [];
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
          const candles = await fetchAsset5mCandles(matchingItem.symbol, matchingItem.source);
          if (!candles || candles.length === 0) {
            logs.push(`[Pending Evaluation] Could not fetch candles for ${trade.symbol}. Will retry next cycle.`);
            continue;
          }

          if (candles && candles.length > 0) {
            const currentCandle = candles[candles.length - 1];
            const currentPrice = currentCandle.close;
            const candleHigh = currentCandle.high !== undefined ? currentCandle.high : currentPrice;
            const candleLow = currentCandle.low !== undefined ? currentCandle.low : currentPrice;
            logs.push(`[Pending Trade ${trade.symbol}] Current: ${formatPrice(currentPrice)} | High: ${formatPrice(candleHigh)} | Low: ${formatPrice(candleLow)} | TP: ${formatPrice(trade.tp)} | SL: ${formatPrice(trade.sl)}`);
            let newStatus: 'WIN' | 'LOSS' | 'BREAKEVEN' | null = null;
            let exitPrice = currentPrice;

            // HYBRID SAFETY NET LOGIC (September 9 Baseline):
            // 1. Hard Catastrophic Stop (Wick on High/Low): 3.0x ATR for Gold, 2.5x ATR for QQQ
            // 2. Take Profit (Wick on High/Low): limit fill
            // 3. Soft Stop (1.5x ATR): triggers ONLY on candle CLOSE
            const isQQQ = matchingItem.symbol.includes('QQQ') || matchingItem.symbol.includes('IXIC');
            const hardSlMult = isQQQ ? 2.5 : 3.0;
            const atrVal = trade.atr || (Math.abs(trade.sl - trade.entryPrice) / 1.5);
            const hardSl = trade.breakevenApplied
              ? trade.entryPrice
              : (trade.action === 'BUY' ? trade.entryPrice - (atrVal * hardSlMult) : trade.entryPrice + (atrVal * hardSlMult));

            if (trade.action === 'BUY') {
              const hardSlHit = candleLow <= hardSl;
              const tpHit = candleHigh >= trade.tp;
              const softSlHit = currentPrice <= trade.sl; // Soft stop on candle CLOSE

              if (hardSlHit) {
                newStatus = 'LOSS';
                exitPrice = hardSl;
              } else if (tpHit) {
                newStatus = 'WIN';
                exitPrice = trade.tp;
              } else if (softSlHit) {
                newStatus = trade.breakevenApplied && Math.abs(trade.sl - trade.entryPrice) < 0.0001 ? 'BREAKEVEN' : 'LOSS';
                exitPrice = trade.sl;
              }
            } else if (trade.action === 'SELL') {
              const hardSlHit = candleHigh >= hardSl;
              const tpHit = candleLow <= trade.tp;
              const softSlHit = currentPrice >= trade.sl; // Soft stop on candle CLOSE

              if (hardSlHit) {
                newStatus = 'LOSS';
                exitPrice = hardSl;
              } else if (tpHit) {
                newStatus = 'WIN';
                exitPrice = trade.tp;
              } else if (softSlHit) {
                newStatus = trade.breakevenApplied && Math.abs(trade.sl - trade.entryPrice) < 0.0001 ? 'BREAKEVEN' : 'LOSS';
                exitPrice = trade.sl;
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

              // Update active trade status to ARCHIVED so it's removed from pending list
              trade.status = 'ARCHIVED';
              trade.exitPrice = exitPrice;
              trade.closedAt = closedAt;
              trade.pnlPoints = Number(pnlPoints.toFixed(4));
              trade.netPnLUSD = detailed.netPnLUSD;
              trade.balanceAfterTrade = accountUpdate.newBalance;
              await trade.save();

              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) archived with result ${newStatus} (Net: $${detailed.netPnLUSD.toFixed(2)})`);

              let outcomeText = '';
              if (newStatus === 'WIN') {
                outcomeText = `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\nالربح المحقق: +${pnlPoints.toFixed(2)} نقطة (+$${detailed.netPnLUSD.toFixed(2)})\nرصيد الحساب الجديد: $${accountUpdate.newBalance.toFixed(2)}`;
              } else if (newStatus === 'BREAKEVEN') {
                outcomeText = `🛡 **إغلاق على نقطة الدخول (BREAKEVEN)!** ⚖️\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\nالنتيجة: بدون خسارة ($${detailed.netPnLUSD.toFixed(2)})\nرصيد الحساب: $${accountUpdate.newBalance.toFixed(2)}`;
              } else {
                outcomeText = `📉 **ضرب وقف الخسارة! (LOSS)** 🛡\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\nالخسارة: ${pnlPoints.toFixed(2)} نقطة ($${detailed.netPnLUSD.toFixed(2)})\nرصيد الحساب: $${accountUpdate.newBalance.toFixed(2)}`;
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
              // Advanced Trade Management: Breakeven & Time Stop (September 9 Setup)
              // -------------------------------------------------------------

              // 1. Gold Dynamic Stepped Profit Lock & Momentum Snatch
              if (matchingItem.symbol === 'XAU/USD') {
                const totalTargetPoints = Math.abs(trade.tp - trade.entryPrice);
                const isBuy = trade.action === 'BUY';
                const maxFloatingPoints = isBuy ? (candleHigh - trade.entryPrice) : (trade.entryPrice - candleLow);
                const currentFloatingPoints = isBuy ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice);
                const progressRatio = totalTargetPoints > 0 ? (maxFloatingPoints / totalTargetPoints) : 0;

                // أ. مهارة خطف الأرباح (Momentum Snatch): الخروج بسعر السوق إذا ارتد السعر 25% من القمة بعد تقدم >= 50%
                let momentumSnatchTriggered = false;
                const atrVal = trade.atr || 2.5;
                if ((progressRatio >= 0.50 || maxFloatingPoints >= atrVal * 1.2) && currentFloatingPoints > 0) {
                  const retracement = maxFloatingPoints - currentFloatingPoints;
                  if (retracement >= maxFloatingPoints * 0.25) {
                    momentumSnatchTriggered = true;
                  }
                }

                // ب. الوقف المتحرك المتدرج (Stepped Dynamic Lock):
                let stepLockPoints = 0;
                if (progressRatio >= 0.85) {
                  stepLockPoints = Number((maxFloatingPoints * 0.70).toFixed(2));
                } else if (progressRatio >= 0.70) {
                  stepLockPoints = Number((maxFloatingPoints * 0.50).toFixed(2));
                } else if (progressRatio >= 0.50) {
                  stepLockPoints = Number((maxFloatingPoints * 0.30).toFixed(2));
                } else if (progressRatio >= 0.35) {
                  stepLockPoints = 0.50; // تأمين الدخول وتكلفة السبريد
                }

                if (stepLockPoints > 0) {
                  const candidateSl = isBuy
                    ? Number((trade.entryPrice + stepLockPoints).toFixed(2))
                    : Number((trade.entryPrice - stepLockPoints).toFixed(2));

                  const isImprovement = isBuy ? candidateSl > trade.sl : candidateSl < trade.sl;
                  if (isImprovement) {
                    trade.sl = candidateSl;
                    trade.breakevenApplied = true;
                    await trade.save();

                    const lockMsg = `🔒 تأمين أرباح الذهب المتدرج (Gold Profit Lock) 🎯\n- الأصل: ${trade.symbol}\n- تم رفع الوقف لحجز +${stepLockPoints} نقطة كاش (${(progressRatio * 100).toFixed(0)}% من مسار الهدف)!\n- الوقف الجديد: ${formatPrice(trade.sl)}`;
                    logs.push(lockMsg);
                    console.log(lockMsg);
                    await sendTelegramNotification(lockMsg);
                  }
                }

                // فحص ضرب الوقف المؤمن أو تفعيل خطف الربح بسعر السوق
                const lockedSlHit = isBuy
                  ? (candleLow <= trade.sl || currentPrice <= trade.sl)
                  : (candleHigh >= trade.sl || currentPrice >= trade.sl);

                if (momentumSnatchTriggered || lockedSlHit) {
                  const exitPrice = momentumSnatchTriggered ? currentPrice : trade.sl;
                  const closedAt = new Date();
                  const rawDiff = isBuy ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
                  const pnlPoints = Number(rawDiff.toFixed(2));
                  const finalStatus: 'WIN' | 'BREAKEVEN' = pnlPoints > 0.05 ? 'WIN' : 'BREAKEVEN';
                  const lotSize = trade.suggestedLotSize || 0.01;
                  const detailed = calculateDetailedPnL(pnlPoints, lotSize, trade.symbol, finalStatus === 'BREAKEVEN');

                  const accountUpdate = await applyTradeResultToAccount(detailed.netPnLUSD, finalStatus, trade._id.toString());
                  currentLiveBal = accountUpdate.newBalance;

                  await TradeHistory.create({
                    tradeId: trade._id.toString(),
                    symbol: trade.symbol,
                    action: trade.action,
                    tradeType: trade.tradeType,
                    entryPrice: trade.entryPrice,
                    exitPrice,
                    sl: trade.sl,
                    tp: trade.tp,
                    status: finalStatus,
                    suggestedLotSize: lotSize,
                    pnlPoints,
                    grossPnLUSD: detailed.grossPnLUSD,
                    tradingFeeUSD: detailed.tradingFeeUSD,
                    netPnLUSD: detailed.netPnLUSD,
                    balanceAfterTrade: accountUpdate.newBalance,
                    rsi: trade.rsi,
                    ema20: trade.ema20,
                    ema100: trade.ema100 || trade.ema200,
                    atr: trade.atr,
                    groqAnalysis: trade.groqAnalysis,
                    entryTimestamp: trade.timestamp,
                    closedAt
                  });

                  trade.status = 'ARCHIVED';
                  trade.exitPrice = exitPrice;
                  trade.closedAt = closedAt;
                  trade.pnlPoints = pnlPoints;
                  trade.netPnLUSD = detailed.netPnLUSD;
                  trade.balanceAfterTrade = accountUpdate.newBalance;
                  await trade.save();

                  const exitReasonText = momentumSnatchTriggered
                    ? `⚡ خطف الربح فوراً بسعر السوق (+${pnlPoints} نقطة / +${detailed.netPnLUSD.toFixed(2)}) قبل ارتداد السعر!`
                    : `🔒 إغلاق بتأمين الأرباح المتدرج (+${pnlPoints} نقطة / +${detailed.netPnLUSD.toFixed(2)})`;

                  const outcomeMsg = `🏆 إغلاق وحجز أرباح الذهب بنجاح! 💵\n- الأصل: ${trade.symbol}\n- السبب: ${exitReasonText}\n- سعر الخروج: ${formatPrice(exitPrice)}\n- صافي الربح: +${detailed.netPnLUSD.toFixed(2)} (+${pnlPoints} نقطة) | الحجم: ${lotSize.toFixed(2)} لوت\n- رصيد الحساب الآن: ${accountUpdate.newBalance.toFixed(2)}`;
                  logs.push(outcomeMsg);
                  console.log(outcomeMsg);
                  await sendTelegramNotification(outcomeMsg);
                  continue;
                }
              } else if (!trade.breakevenApplied) {
                // Standard Breakeven for other symbols
                let is50PercentReached = false;
                if (trade.action === 'BUY') {
                  const target50 = trade.entryPrice + 0.5 * (trade.tp - trade.entryPrice);
                  if (candleHigh >= target50) is50PercentReached = true;
                } else if (trade.action === 'SELL') {
                  const target50 = trade.entryPrice - 0.5 * (trade.entryPrice - trade.tp);
                  if (candleLow <= target50) is50PercentReached = true;
                }
                if (is50PercentReached) {
                  trade.sl = trade.entryPrice;
                  trade.breakevenApplied = true;
                  await trade.save();
                  const breakevenMsg = `🛡️ (BREAKEVEN) Risk Free!\nتم تحريك الستوب (SL) إلى نقطة الدخول ${formatPrice(trade.entryPrice)} لرمز ${trade.symbol}.`;
                  logs.push(breakevenMsg);
                  await sendTelegramNotification(breakevenMsg);
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
                    trade.sl = trade.entryPrice;
                    trade.breakevenApplied = true;
                    await trade.save();

                    const timeStopMsg = `⏱️ **(SMART TIME STOP)**\nمرور 120 دقيقة والصفقة رابحة! تم تحريك الستوب إلى نقطة الدخول (Breakeven) لرمز ${trade.symbol}.`;
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

                  const timeStopMsg = `⏱️ **(TIME STOP)**\nمرور 120 دقيقة والصفقة خاسرة. تم إغلاق الصفقة بسعر السوق $${formatPrice(currentPrice)} لرمز ${trade.symbol} لتفريغ السيولة (الخسارة: $${detailed.netPnLUSD.toFixed(2)}).`;
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
      const candles = await fetchAsset5mCandles(symbol, source);

      if (!candles || candles.length < 100) {
        const msg = `Insufficient candle data for ${symbol} (minimum 100 required for EMA100). Skipping.`;
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
      logs.push(`[Data Feed Confirmed: BINANCE] Fetched ${candles.length} candles for ${symbol}. Latest price: ${currentClose} (Candle Cairo time: ${latestCandleTime})`);

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
