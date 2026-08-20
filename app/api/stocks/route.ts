import { NextResponse } from 'next/server';
import { SMA, MACD } from 'technicalindicators';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import { fetchYahooHistorical, fetchStockNewsHeadlines } from '@/lib/yfinance';
import { generateGroqSwingAnalysis } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Watchlist target stocks for Weekly/Monthly Swing & Position Scanner Engine
const SWING_STOCKS = ['AAPL', 'TSLA', 'NVDA'];

async function runStockSwingEngine() {
  const logs: string[] = [];
  logs.push(`Starting Weekly/Monthly Stock Swing Scanner Engine at ${new Date().toISOString()}`);

  let dbConnected = false;
  try {
    const db = await connectToDatabase();
    if (db) dbConnected = true;
  } catch (err: any) {
    logs.push(`MongoDB warning: ${err?.message || err}`);
  }

  // 1. Evaluate Pending Swing Trades in Database
  // Strictly query active 'ALERT_SENT' trades so archived trades are never re-evaluated
  if (dbConnected) {
    try {
      const pendingTrades = await Trade.find({ status: 'ALERT_SENT', tradeType: 'SWING' });
      if (pendingTrades.length > 0) {
        logs.push(`Evaluating ${pendingTrades.length} pending swing trade(s)...`);
        for (const trade of pendingTrades) {
          const recentCandles = await fetchYahooHistorical(trade.symbol, '1wk', 60);
          if (recentCandles && recentCandles.length > 0) {
            const currentPrice = recentCandles[recentCandles.length - 1].close;
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
                sma50: trade.sma50,
                macd: trade.macd,
                newsHeadlines: trade.newsHeadlines,
                groqAnalysis: trade.groqAnalysis,
                entryTimestamp: trade.timestamp,
                closedAt
              });

              // Update active trade status to ARCHIVED so it's removed from pending list
              trade.status = 'ARCHIVED';
              trade.exitPrice = currentPrice;
              trade.closedAt = closedAt;
              await trade.save();

              logs.push(`Swing trade ${trade._id} (${trade.symbol}) archived with result ${newStatus}`);

              const outcomeText = newStatus === 'WIN'
                ? `🎉 **تم كسب صفقة الاستثمار/السوينغ (WIN)!** 📈\nالسهم: ${trade.symbol}\nسعر الخروج: $${currentPrice}`
                : `🛡 **إغلاق صفقة السوينغ على وقف الخسارة (LOSS)** 📉\nالسهم: ${trade.symbol}\nسعر الخروج: $${currentPrice}`;
              await sendTelegramNotification(outcomeText);
            }
          }
        }
      }
    } catch (pendingErr: any) {
      logs.push(`Error evaluating pending swing trades: ${pendingErr?.message || pendingErr}`);
    }
  }

  // 2. Iterate through Target Stocks
  const results = [];

  for (const symbol of SWING_STOCKS) {
    try {
      logs.push(`Fetching weekly historical candles for ${symbol}...`);
      const weeklyCandles = await fetchYahooHistorical(symbol, '1wk', 730);

      if (!weeklyCandles || weeklyCandles.length < 60) {
        logs.push(`Insufficient weekly data for ${symbol}. Skipping.`);
        continue;
      }

      const closes = weeklyCandles.map(c => c.close);
      const currentClose = closes[closes.length - 1];

      // Calculate SMA(50)
      const sma50Values = SMA.calculate({ period: 50, values: closes });
      if (sma50Values.length < 2) continue;
      const currentSma50 = sma50Values[sma50Values.length - 1];

      // Calculate MACD(12, 26, 9)
      const macdValues = MACD.calculate({
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
        values: closes,
      });

      if (macdValues.length < 2) continue;

      const currMacd = macdValues[macdValues.length - 1];
      const prevMacd = macdValues[macdValues.length - 2];

      const macdLine = currMacd.MACD || 0;
      const signalLine = currMacd.signal || 0;
      const prevMacdLine = prevMacd.MACD || 0;
      const prevSignalLine = prevMacd.signal || 0;

      // Strategy: Trend Following MACD Crossover + SMA 50 Alignment
      // BUY: Close > SMA50 AND MACD Line crosses above Signal Line
      // SELL: Close < SMA50 AND MACD Line crosses below Signal Line
      let action: 'BUY' | 'SELL' | null = null;

      if (currentClose > currentSma50 && prevMacdLine <= prevSignalLine && macdLine > signalLine) {
        action = 'BUY';
      } else if (currentClose < currentSma50 && prevMacdLine >= prevSignalLine && macdLine < signalLine) {
        action = 'SELL';
      }

      if (!action) {
        results.push({ symbol, signalTriggered: false, currentClose, sma50: currentSma50, macd: macdLine, signalLine });
        continue;
      }

      logs.push(`🚨 ${action} Swing Signal Triggered for ${symbol}!`);

      // Dynamic Swing SL & TP (e.g. 5% SL, 15% TP for weekly positions)
      const sl = action === 'BUY'
        ? parseFloat((currentClose * 0.95).toFixed(2))
        : parseFloat((currentClose * 1.05).toFixed(2));

      const tp = action === 'BUY'
        ? parseFloat((currentClose * 1.15).toFixed(2))
        : parseFloat((currentClose * 0.85).toFixed(2));

      // 3. Fetch News Headlines for Fundamental Sentiment Analysis
      logs.push(`Scraping latest news headlines for ${symbol}...`);
      const headlines = await fetchStockNewsHeadlines(symbol, 5);

      // 4. Generate Fundamental + Technical Sentiment Analysis via Groq AI (llama3-8b-8192)
      logs.push(`Generating Groq AI Swing Report in Egyptian Arabic...`);
      const groqAnalysis = await generateGroqSwingAnalysis({
        symbol,
        action,
        entryPrice: currentClose,
        sl,
        tp,
        sma50: parseFloat(currentSma50.toFixed(2)),
        macd: parseFloat(macdLine.toFixed(2)),
        macdSignal: parseFloat(signalLine.toFixed(2)),
        newsHeadlines: headlines,
      });

      // 5. Persist Trade Record to MongoDB
      if (dbConnected) {
        try {
          const newTrade = new Trade({
            symbol,
            action,
            entryPrice: currentClose,
            sl,
            tp,
            sma50: parseFloat(currentSma50.toFixed(2)),
            macd: parseFloat(macdLine.toFixed(2)),
            tradeType: 'SWING',
            newsHeadlines: headlines,
            groqAnalysis,
            status: 'ALERT_SENT',
            timestamp: new Date(),
          });
          await newTrade.save();
        } catch (saveErr: any) {
          logs.push(`Database save error for ${symbol}: ${saveErr?.message || saveErr}`);
        }
      }

      // 6. Send Telegram Notification
      const telegramMessage = `🏛 **توصية استثمارية وسوينغ لأسهم أمريكية** 🏛\n\n${groqAnalysis}`;
      await sendTelegramNotification(telegramMessage);

      results.push({ symbol, signalTriggered: true, action, entryPrice: currentClose, sl, tp, headlines, groqAnalysis });

    } catch (stockErr: any) {
      logs.push(`Error processing stock ${symbol}: ${stockErr?.message || stockErr}`);
    }
  }

  return {
    success: true,
    engine: 'Weekly/Monthly Stock Swing Scanner',
    scannedStocks: SWING_STOCKS.length,
    results,
    logs,
  };
}

export async function GET() {
  try {
    const output = await runStockSwingEngine();
    return NextResponse.json(output, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Stock Swing Engine Failure' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const output = await runStockSwingEngine();
    return NextResponse.json(output, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Stock Swing Engine Failure' }, { status: 500 });
  }
}
