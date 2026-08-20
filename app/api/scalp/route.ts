import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import { fetchBinanceKlines, Candle } from '@/lib/binance';
import { fetchYahoo5mKlines } from '@/lib/yfinance';
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
  { symbol: '^IXIC', source: 'YAHOO' },
  { symbol: '^DJI', source: 'YAHOO' }
];

function normalizeSymbol(symbol: string): { symbol: string; source: string } {
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD' || symbol === 'XAU/USD') {
    return { symbol: 'XAU/USD', source: 'TWELVEDATA' };
  }
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD' || symbol === 'BTC/USD') {
    return { symbol: 'BTC/USD', source: 'TWELVEDATA' };
  }
  const matching = SCALP_WATCHLIST.find(i => i.symbol === symbol);
  return matching || { symbol, source: 'YAHOO' };
}

async function fetchAsset5mCandles(symbol: string, source: string): Promise<Candle[]> {
  if (source === 'TWELVEDATA') {
    return await fetchTwelveData5mKlines(symbol);
  } else if (source === 'BINANCE') {
    return await fetchBinanceKlines(symbol, '5m', 100);
  } else {
    return await fetchYahoo5mKlines(symbol);
  }
}

async function runScalperEngine() {
  const logs: string[] = [];
  logs.push(`Starting 5m Multi-Asset Scalper Engine Cycle at ${new Date().toISOString()}`);

  let dbConnected = false;
  try {
    const db = await connectToDatabase();
    if (db) dbConnected = true;
  } catch (err: any) {
    logs.push(`MongoDB warning: ${err?.message || err}`);
  }

  // 1. Evaluate Pending Trades in Database (tradeType: 'SCALP')
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
              trade.status = newStatus;
              await trade.save();
              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) updated to ${newStatus}`);

              const outcomeText = newStatus === 'WIN'
                ? `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: $${currentPrice}`
                : `🛡 **ضرب وقف الخسارة! (LOSS)** 📉\nالرمز: ${trade.symbol}\nسعر الخروج: $${currentPrice}`;
              await sendTelegramNotification(outcomeText);
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
      logs.push(`Processing 5m candles for ${symbol} via ${source}...`);
      const candles = await fetchAsset5mCandles(symbol, source);

      if (!candles || candles.length < 30) {
        logs.push(`Insufficient candle data for ${symbol}. Skipping.`);
        continue;
      }

      const ind = calculateScalpIndicators(candles);
      if (!ind) continue;

      const { currentClose, currentLow, currentEma20, currentRsi, prevRsi, currentAtr } = ind;

      // Aggressive Scalping Signal Rules:
      // BUY: Close >= EMA20 AND RSI <= 70 AND (RSI crosses above 55 OR pulls back to touch EMA20)
      // SELL: Close < EMA20 AND RSI < 40 AND Prev RSI > 40
      let signalType: 'BUY' | 'SELL' | null = null;

      const rsiCrossAbove55 = prevRsi < 55 && currentRsi >= 55;
      const emaPullbackTouch = currentLow <= currentEma20;

      if (currentClose >= currentEma20 && currentRsi <= 70 && (rsiCrossAbove55 || emaPullbackTouch)) {
        signalType = 'BUY';
      } else if (currentClose < currentEma20 && currentRsi < 40 && prevRsi > 40) {
        signalType = 'SELL';
      }

      if (!signalType) {
        results.push({ symbol, signalTriggered: false, close: currentClose, rsi: currentRsi, ema20: currentEma20 });
        continue;
      }

      logs.push(`🚨 ${signalType} Scalp Signal Triggered for ${symbol}!`);

      // Calculate Dynamic SL & TP (1.5x ATR SL, 3.0x ATR TP)
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
        ema20: parseFloat(currentEma20.toFixed(2))
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
      const telegramMsg = `${groqAnalysis}\n\n📊 **تفاصيل السكالبينج:**\n- الأصل: ${symbol}\n- السعر: $${currentClose}\n- SL: $${sl} | TP: $${tp}\n- RSI: ${signalDetails.rsi} | EMA20: $${signalDetails.ema20}`;
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
