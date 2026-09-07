import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import { fetchBinanceKlines, Candle } from '@/lib/binance';
import { fetchTwelveData5mKlines } from '@/lib/twelvedata';
import { calculateScalpIndicators, formatPrice } from '@/lib/indicators';
import { generateGroqArabicAlert } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface ScalpWatchlistItem {
  symbol: string;
  source: string;
  enabled: boolean;
  notes?: string;
}

// Watchlist symbols for 5-minute High-Frequency Scalper Engine
export const SCALP_WATCHLIST: ScalpWatchlistItem[] = [
  { symbol: 'XAU/USD', source: 'TWELVEDATA', enabled: true },
  {
    symbol: 'EUR/USD',
    source: 'TWELVEDATA',
    enabled: false,
    notes: 'PAUSED: marginal edge even after best tuning found (session filter + TP 3.0x ATR), still net negative (-40 pips / PF 0.94 over 71 days). Revisit only with a different entry strategy (mean-reversion, not trend-following).'
  },
  { symbol: 'QQQ', source: 'TWELVEDATA', enabled: true },
  {
    symbol: 'BTC/USD',
    source: 'TWELVEDATA',
    enabled: false,
    notes: 'REJECTED: 61.8% win rate in backtests, negative net expectancy. Strictly disabled from live engine.'
  }
];

function normalizeSymbol(symbol: string): { symbol: string; source: string } {
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD' || symbol === 'XAU/USD') {
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
  'QQQ': { enabled: false, startHourCairo: 16.5, endHourCairo: 23.0 }  // Disabled by default (US Session 16:30 - 23:00 Cairo)
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
  if (source === 'BINANCE') {
    return await fetchBinanceKlines(symbol, '5m', 250);
  }
  return await fetchTwelveData5mKlines(symbol, '5min', 250);
}

async function runScalperEngine() {
  const logs: string[] = [];
  logs.push(`Starting 5m Multi-Asset Scalper Engine Cycle at ${new Date().toISOString()}`);

  // Market Day Filter: Per-symbol weekend check (Crypto 24/7, Forex/Indices/Gold pause on Sat/Sun)
  const currentUtcDay = new Date().getUTCDay();
  const isWeekendNow = (currentUtcDay === 0 || currentUtcDay === 6);
  logs.push(`Market Day Check: UTC day ${currentUtcDay} (Weekend: ${isWeekendNow}). Per-symbol weekend filtering active.`);

  let dbConnected = false;
  try {
    const db = await connectToDatabase();
    if (db) dbConnected = true;
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
          if (candles && candles.length > 0) {
            const currentCandle = candles[candles.length - 1];
            const currentPrice = currentCandle.close;
            const candleHigh = currentCandle.high !== undefined ? currentCandle.high : currentPrice;
            const candleLow = currentCandle.low !== undefined ? currentCandle.low : currentPrice;
            let newStatus: 'WIN' | 'LOSS' | 'BREAKEVEN' | null = null;
            let exitPrice = currentPrice;

            // HYBRID SAFETY NET LOGIC:
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
              await trade.save();

              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) archived with result ${newStatus}`);

              const outcomeText = newStatus === 'WIN'
                ? `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}`
                : `🛡 **ضرب وقف الخسارة! (LOSS)** 📉\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}`;
              await sendTelegramNotification(outcomeText);

              // Risk Alert: Check for 4+ consecutive losses today (Monitoring only, no automated execution)
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
              // Advanced Trade Management: Breakeven & Time Stop
              // -------------------------------------------------------------

              // 1. Breakeven Logic (Move SL to Entry Price at >= 50% TP progress based on High/Low)
              if (!trade.breakevenApplied) {
                let is50PercentReached = false;

                if (trade.action === 'BUY') {
                  const target50 = trade.entryPrice + 0.5 * (trade.tp - trade.entryPrice);
                  if (candleHigh >= target50) {
                    is50PercentReached = true;
                  }
                } else if (trade.action === 'SELL') {
                  const target50 = trade.entryPrice - 0.5 * (trade.entryPrice - trade.tp);
                  if (candleLow <= target50) {
                    is50PercentReached = true;
                  }
                }

                if (is50PercentReached) {
                  trade.sl = trade.entryPrice;
                  trade.breakevenApplied = true;
                  await trade.save();

                  const breakevenMsg = `🛡️ (BREAKEVEN) Risk Free! SL moved to Entry Price for ${trade.symbol}.`;
                  logs.push(breakevenMsg);
                  console.log(breakevenMsg);
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

                    const timeStopMsg = `⏱️ (SMART TIME STOP) 120m limit reached while in profit! SL moved to Entry Price (Breakeven) for ${trade.symbol}.`;
                    logs.push(timeStopMsg);
                    console.log(timeStopMsg);
                    await sendTelegramNotification(timeStopMsg);
                  }
                } else {
                  // Floating in loss - close trade at market price
                  const closedAt = new Date();
                  const indExit = candles.length >= 100 ? calculateScalpIndicators(candles) : null;

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
                  await trade.save();

                  const timeStopMsg = `⏱️ (TIME STOP) 120m limit reached while in loss. Trade closed at market price to free capital for ${trade.symbol}.`;
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

  // 2. Filter active assets and iterate concurrently (Promise.allSettled)
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

      const { currentClose, currentEma20, currentEma100, currentRsi, prevRsi, currentAtr } = ind;

      // Trend-Filtered Dynamic Momentum Strategy Rules:
      // Trend Direction Filter (The Shield):
      // - BUY: currentClose > currentEma100 AND currentClose > currentEma20
      // - SELL: currentClose < currentEma100 AND currentClose < currentEma20
      // Healthy Momentum Zone (The Trigger - Crossover Event):
      // - BUY: prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68
      // - SELL: prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32

      let signalType: 'BUY' | 'SELL' | null = null;

      const isBuyTrend = currentClose > currentEma100 && currentClose > currentEma20;
      const isBuyMomentum = prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68;

      const isSellTrend = currentClose < currentEma100 && currentClose < currentEma20;
      const isSellMomentum = prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32;

      if (isBuyTrend && isBuyMomentum) {
        signalType = 'BUY';
      } else if (isSellTrend && isSellMomentum) {
        signalType = 'SELL';
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
      // QQQ: 2.0 * ATR, Forex: 2.0 * ATR, Gold/Crypto: 3.0 * ATR
      const normSym = normalizeSymbol(symbol).symbol;
      let tpMultiplier = 3.0;
      if (normSym === 'QQQ' || isForexPair(symbol)) {
        tpMultiplier = 2.0; // 2.0x ATR for QQQ and Forex
      }

      const sl = signalType === 'BUY'
        ? currentClose - (currentAtr * 1.5)
        : currentClose + (currentAtr * 1.5);

      const tp = signalType === 'BUY'
        ? currentClose + (currentAtr * tpMultiplier)
        : currentClose - (currentAtr * tpMultiplier);

      const signalDetails = {
        symbol,
        action: signalType,
        entryPrice: currentClose,
        sl,
        tp,
        rsi: currentRsi,
        ema20: currentEma20,
        ema100: currentEma100,
        atr: currentAtr
      };

      // Generate Egyptian Arabic AI Alert via Groq
      const groqAnalysis = await generateGroqArabicAlert(signalDetails);

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

      // Send Telegram Alert
      const telegramMsg = `${groqAnalysis}\n\n📊 **تفاصيل السكالبينج (Trend-Filtered Dynamic Momentum):**\n- الأصل: ${symbol}\n- السعر: $${formatPrice(currentClose)}\n- SL (1.5x ATR): $${formatPrice(sl)} | TP (${tpMultiplier.toFixed(1)}x ATR): $${formatPrice(tp)}\n- ATR (14): $${formatPrice(signalDetails.atr)}\n- RSI (14): ${formatPrice(signalDetails.rsi)} | EMA20: $${formatPrice(signalDetails.ema20)} | EMA100: $${formatPrice(signalDetails.ema100)}`;
      await sendTelegramNotification(telegramMsg);

      return { symbol, signalTriggered: true, signal: signalDetails, groqAnalysis };

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
    engine: '5m High-Frequency Scalper',
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
