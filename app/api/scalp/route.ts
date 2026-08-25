import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import { fetchBinanceKlines, Candle } from '@/lib/binance';
import { fetchTwelveData5mKlines } from '@/lib/twelvedata';
import { calculateScalpIndicators } from '@/lib/indicators';
import { generateGroqArabicAlert } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Watchlist symbols for 5-minute High-Frequency Scalper Engine
const SCALP_WATCHLIST = [
  { symbol: 'BTC/USD', source: 'TWELVEDATA' },
  { symbol: 'XAU/USD', source: 'TWELVEDATA' },
  { symbol: 'IXIC', source: 'TWELVEDATA' },
  { symbol: 'DJI', source: 'TWELVEDATA' }
];

function normalizeSymbol(symbol: string): { symbol: string; source: string } {
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD' || symbol === 'XAU/USD') {
    return { symbol: 'XAU/USD', source: 'TWELVEDATA' };
  }
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD' || symbol === 'BTC/USD') {
    return { symbol: 'BTC/USD', source: 'TWELVEDATA' };
  }
  if (symbol === '^IXIC' || symbol === 'IXIC') {
    return { symbol: 'IXIC', source: 'TWELVEDATA' };
  }
  if (symbol === '^DJI' || symbol === 'DJI') {
    return { symbol: 'DJI', source: 'TWELVEDATA' };
  }
  const matching = SCALP_WATCHLIST.find(i => i.symbol === symbol);
  return matching || { symbol, source: 'TWELVEDATA' };
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

  // Market Day Filter: Check UTC day of the week (0 = Sunday, 6 = Saturday)
  const currentUtcDay = new Date().getUTCDay();
  if (currentUtcDay === 0 || currentUtcDay === 6) {
    const weekendLog = 'Weekend detected: Bot sleeping';
    console.log(weekendLog);
    logs.push(weekendLog);
    return {
      success: true,
      engine: '5m High-Frequency Scalper',
      message: weekendLog,
      processedAssets: 0,
      results: [],
      logs
    };
  }

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
          const candles = await fetchAsset5mCandles(matchingItem.symbol, matchingItem.source);
          if (candles && candles.length > 0) {
            const currentPrice = candles[candles.length - 1].close;
            let newStatus: 'WIN' | 'LOSS' | null = null;

            if (trade.action === 'BUY') {
              if (currentPrice >= trade.tp) newStatus = 'WIN';
              else if (currentPrice <= trade.sl) newStatus = 'LOSS';
            } else if (trade.action === 'SELL') {
              if (currentPrice <= trade.tp) newStatus = 'WIN';
              else if (currentPrice >= trade.sl) newStatus = 'LOSS';
            }

            if (newStatus) {
              const closedAt = new Date();
              const indExit = candles.length >= 200 ? calculateScalpIndicators(candles) : null;

              // Move trade to TradeHistory archive collection for ML/AI retention
              await TradeHistory.create({
                tradeId: trade._id.toString(),
                symbol: trade.symbol,
                action: trade.action,
                tradeType: trade.tradeType,
                entryPrice: trade.entryPrice,
                exitPrice: currentPrice,
                sl: trade.sl,
                tp: trade.tp,
                status: newStatus,
                rsi: trade.rsi,
                ema20: trade.ema20,
                ema200: trade.ema200,
                atr: trade.atr,
                exitRsi: indExit ? parseFloat(indExit.currentRsi.toFixed(2)) : undefined,
                exitEma20: indExit ? parseFloat(indExit.currentEma20.toFixed(2)) : undefined,
                exitEma200: indExit ? parseFloat(indExit.currentEma200.toFixed(2)) : undefined,
                exitAtr: indExit ? parseFloat(indExit.currentAtr.toFixed(2)) : undefined,
                groqAnalysis: trade.groqAnalysis,
                entryTimestamp: trade.timestamp,
                closedAt
              });

              // Update active trade status to ARCHIVED so it's removed from pending list
              trade.status = 'ARCHIVED';
              trade.exitPrice = currentPrice;
              trade.closedAt = closedAt;
              await trade.save();

              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) archived with result ${newStatus}`);

              const outcomeText = newStatus === 'WIN'
                ? `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: $${currentPrice}`
                : `🛡 **ضرب وقف الخسارة! (LOSS)** 📉\nالرمز: ${trade.symbol}\nسعر الخروج: $${currentPrice}`;
              await sendTelegramNotification(outcomeText);
            } else {
              // -------------------------------------------------------------
              // Advanced Trade Management: Breakeven & Time Stop
              // -------------------------------------------------------------

              // 1. Breakeven Logic (Move SL to Entry Price at >= 50% TP progress)
              if (!trade.breakevenApplied) {
                let is50PercentReached = false;

                if (trade.action === 'BUY') {
                  const target50 = trade.entryPrice + 0.5 * (trade.tp - trade.entryPrice);
                  if (currentPrice >= target50) {
                    is50PercentReached = true;
                  }
                } else if (trade.action === 'SELL') {
                  const target50 = trade.entryPrice - 0.5 * (trade.entryPrice - trade.tp);
                  if (currentPrice <= target50) {
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

              // 2. Time Stop Logic (Close at market price if elapsed time >= 60 minutes)
              const entryTime = trade.timestamp ? new Date(trade.timestamp).getTime() : 0;
              const timeElapsedMs = Date.now() - entryTime;

              if (entryTime > 0 && timeElapsedMs >= 3600000) {
                const closedAt = new Date();
                const indExit = candles.length >= 200 ? calculateScalpIndicators(candles) : null;
                const timeStopStatus: 'WIN' | 'LOSS' = trade.action === 'BUY'
                  ? (currentPrice >= trade.entryPrice ? 'WIN' : 'LOSS')
                  : (currentPrice <= trade.entryPrice ? 'WIN' : 'LOSS');

                await TradeHistory.create({
                  tradeId: trade._id.toString(),
                  symbol: trade.symbol,
                  action: trade.action,
                  tradeType: trade.tradeType,
                  entryPrice: trade.entryPrice,
                  exitPrice: currentPrice,
                  sl: trade.sl,
                  tp: trade.tp,
                  status: timeStopStatus,
                  rsi: trade.rsi,
                  ema20: trade.ema20,
                  ema200: trade.ema200,
                  atr: trade.atr,
                  exitRsi: indExit ? parseFloat(indExit.currentRsi.toFixed(2)) : undefined,
                  exitEma20: indExit ? parseFloat(indExit.currentEma20.toFixed(2)) : undefined,
                  exitEma200: indExit ? parseFloat(indExit.currentEma200.toFixed(2)) : undefined,
                  exitAtr: indExit ? parseFloat(indExit.currentAtr.toFixed(2)) : undefined,
                  groqAnalysis: trade.groqAnalysis,
                  entryTimestamp: trade.timestamp,
                  closedAt
                });

                trade.status = 'ARCHIVED';
                trade.exitPrice = currentPrice;
                trade.closedAt = closedAt;
                await trade.save();

                const timeStopMsg = `⏱️ (TIME STOP) Trade closed at market price to free capital for ${trade.symbol}.`;
                logs.push(timeStopMsg);
                console.log(timeStopMsg);
                await sendTelegramNotification(timeStopMsg);
              }
            }
          }
        }
      }
    } catch (pendingErr: any) {
      logs.push(`Error evaluating pending scalp trades: ${pendingErr?.message || pendingErr}`);
    }
  }

  // 2. Iterate through Scalp Watchlist
  const results = [];

  for (const item of SCALP_WATCHLIST) {
    const { symbol, source } = item;
    try {
      if (dbConnected) {
        const activeTrade = await Trade.findOne({
          symbol: { $in: [symbol, symbol.replace('/', ''), symbol.replace('/', '-'), `^${symbol}`] },
          status: 'ALERT_SENT'
        });
        if (activeTrade) {
          const skipMsg = `Active trade exists for ${symbol}, skipping new entry evaluation.`;
          console.log(skipMsg);
          logs.push(skipMsg);
          results.push({ symbol, signalTriggered: false, skipped: true, reason: skipMsg });
          continue;
        }
      }

      logs.push(`Processing 5m candles for ${symbol} via ${source}...`);
      const candles = await fetchAsset5mCandles(symbol, source);

      if (!candles || candles.length < 200) {
        logs.push(`Insufficient candle data for ${symbol} (minimum 200 required for EMA200). Skipping.`);
        continue;
      }

      const ind = calculateScalpIndicators(candles);
      if (!ind) continue;

      const { currentClose, currentEma20, currentEma200, currentRsi, prevRsi, currentAtr } = ind;

      // Trend-Filtered Dynamic Momentum Strategy Rules:
      // Trend Direction Filter (The Shield):
      // - BUY: currentClose > currentEma200 AND currentClose > currentEma20
      // - SELL: currentClose < currentEma200 AND currentClose < currentEma20
      // Healthy Momentum Zone (The Trigger - Crossover Event):
      // - BUY: prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68
      // - SELL: prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32

      let signalType: 'BUY' | 'SELL' | null = null;

      const isBuyTrend = currentClose > currentEma200 && currentClose > currentEma20;
      const isBuyMomentum = prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68;

      const isSellTrend = currentClose < currentEma200 && currentClose < currentEma20;
      const isSellMomentum = prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32;

      if (isBuyTrend && isBuyMomentum) {
        signalType = 'BUY';
      } else if (isSellTrend && isSellMomentum) {
        signalType = 'SELL';
      }

      if (!signalType) {
        results.push({ symbol, signalTriggered: false, close: currentClose, rsi: currentRsi, ema20: currentEma20, ema200: currentEma200, atr: currentAtr });
        continue;
      }

      logs.push(`🚨 ${signalType} Scalp Signal Triggered for ${symbol}!`);

      // Dynamic Risk Management (ATR-based SL & TP)
      // BUY: SL = entryPrice - (ATR * 1.5), TP = entryPrice + (ATR * 3.0)
      // SELL: SL = entryPrice + (ATR * 1.5), TP = entryPrice - (ATR * 3.0)
      const sl = signalType === 'BUY'
        ? parseFloat((currentClose - (currentAtr * 1.5)).toFixed(2))
        : parseFloat((currentClose + (currentAtr * 1.5)).toFixed(2));

      const tp = signalType === 'BUY'
        ? parseFloat((currentClose + (currentAtr * 3.0)).toFixed(2))
        : parseFloat((currentClose - (currentAtr * 3.0)).toFixed(2));

      const signalDetails = {
        symbol,
        action: signalType,
        entryPrice: currentClose,
        sl,
        tp,
        rsi: parseFloat(currentRsi.toFixed(2)),
        ema20: parseFloat(currentEma20.toFixed(2)),
        ema200: parseFloat(currentEma200.toFixed(2)),
        atr: parseFloat(currentAtr.toFixed(2))
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
      const telegramMsg = `${groqAnalysis}\n\n📊 **تفاصيل السكالبينج (Trend-Filtered Dynamic Momentum):**\n- الأصل: ${symbol}\n- السعر: $${currentClose}\n- SL (1.5x ATR): $${sl} | TP (3.0x ATR): $${tp}\n- ATR (14): $${signalDetails.atr}\n- RSI (14): ${signalDetails.rsi} | EMA20: $${signalDetails.ema20} | EMA200: $${signalDetails.ema200}`;
      await sendTelegramNotification(telegramMsg);

      results.push({ symbol, signalTriggered: true, signal: signalDetails, groqAnalysis });

    } catch (assetErr: any) {
      logs.push(`Error processing scalp asset ${symbol}: ${assetErr?.message || assetErr}`);
    }
  }

  return {
    success: true,
    engine: '5m High-Frequency Scalper',
    processedAssets: SCALP_WATCHLIST.length,
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
