import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import DataFeedStatus from '@/models/DataFeedStatus';
import { fetchBinanceKlines, Candle } from '@/lib/binance';
import { fetchTwelveData5mKlines, CandleFetchResult } from '@/lib/twelvedata';
import { calculateScalpIndicators, formatPrice } from '@/lib/indicators';
import { generateGroqArabicAlert, validateTradeConfluenceWithGroq } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';
import {
  calculatePositionSize,
  calculatePnLUSD,
  calculateDetailedPnL,
  getSymbolSpec,
  getLiveAccountBalance,
  getLiveRiskPercent,
  getMaxTradeRiskUSD,
  getMaxDailyLossUSD,
  getMaxConsecutiveLosses
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

// Watchlist symbols for 5-minute High-Frequency Scalper Engine
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
    notes: 'DISABLED: 9.5% win rate in live testing. Disabled to focus 100% on Gold (XAU/USD).'
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
  'XAU/USD': { enabled: true, startHourCairo: 2, endHourCairo: 19 }, // Tokyo Open Window + London + NY Overlap: 02:00 - 19:00 Cairo
  'QQQ': { enabled: false, startHourCairo: 16.5, endHourCairo: 23.0 }
};

function isFridayBlocked(symbol: string, date: Date = new Date()): boolean {
  const norm = normalizeSymbol(symbol).symbol;
  if (norm === 'XAU/USD' || isForexPair(symbol)) {
    // 5 = Friday
    return date.getUTCDay() === 5;
  }
  return false;
}

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

function isSymbolMarketOpen(symbol: string, date: Date = new Date()): boolean {
  const utcDay = date.getUTCDay();
  // Saturday (6) or Sunday (0) are weekends - always closed for Forex/Gold/Stocks
  if (utcDay === 0 || utcDay === 6) {
    if (isCryptoPair(symbol)) return true;
    return false;
  }

  const norm = normalizeSymbol(symbol).symbol;
  if (norm === 'QQQ' || norm.includes('IXIC') || norm.includes('NAS')) {
    // US Stock Market regular hours: 13:30 UTC to 20:00 UTC (Mon-Fri)
    const utcHours = date.getUTCHours();
    const utcMinutes = date.getUTCMinutes();
    const utcDecimal = utcHours + utcMinutes / 60;
    return utcDecimal >= 13.5 && utcDecimal < 20.0;
  }

  if (norm.includes('XAU') || norm.includes('GOLD')) {
    // Gold spot market: Mon 00:00 UTC to Fri 21:00 UTC
    if (utcDay === 5 && date.getUTCHours() >= 21) return false;
    return true;
  }

  return true;
}

async function recordDataFeedFailure(
  symbol: string,
  fetchResult: CandleFetchResult,
  logs: string[]
): Promise<void> {
  const now = new Date();

  // 1. Never alert on weekends
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) {
    return;
  }

  // 2. Only alert during market hours of this asset
  if (!isSymbolMarketOpen(symbol, now)) {
    return;
  }

  try {
    let statusDoc = await DataFeedStatus.findOne({ symbol });
    if (!statusDoc) {
      statusDoc = new DataFeedStatus({ symbol, consecutiveFailures: 0 });
    }

    statusDoc.consecutiveFailures = (statusDoc.consecutiveFailures || 0) + 1;
    statusDoc.lastFailureAt = now;
    statusDoc.lastHttpStatus = fetchResult.httpStatus;
    statusDoc.lastErrorMessage = fetchResult.errorMessage || 'Insufficient candle data';
    statusDoc.updatedAt = now;

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const timeSinceLastAlert = statusDoc.lastAlertSentAt
      ? now.getTime() - new Date(statusDoc.lastAlertSentAt).getTime()
      : Infinity;

    // Trigger alert: 3 consecutive failures during market hours, once per outage, throttled to 1 hour
    if (statusDoc.consecutiveFailures >= 3 && (!statusDoc.outageAlertSent || timeSinceLastAlert >= ONE_HOUR_MS)) {
      const errorDetail = fetchResult.errorMessage ? `\n- رسالة الخطأ: ${fetchResult.errorMessage}` : '';
      const alertMsg = `🚨 **تنبيه عاجل: البوت أعمى (Data Feed Outage)** ⚠️\n- الأصل: ${symbol}\n- المشكلة: فشل جلب الشموع لـ ${statusDoc.consecutiveFailures} دورات متتالية أثناء ساعات تداول السوق.\n- كود الاستجابة: HTTP ${fetchResult.httpStatus}${errorDetail}\n- عدد الشموع المجلوبة: ${fetchResult.candleCount}\n- التوقيت: ${now.toISOString()}\n\n⚠️ لن يتمكن المحرك من فحص أو تنفيذ أي صفقات لـ ${symbol} حتى عودة تدفق البيانات.`;

      await sendTelegramNotification(alertMsg);
      statusDoc.lastAlertSentAt = now;
      statusDoc.outageAlertSent = true;
      logs.push(`[BLIND BOT ALERT SENT] for ${symbol} (${statusDoc.consecutiveFailures} consecutive failures).`);
    }

    await statusDoc.save();
  } catch (err: any) {
    logs.push(`Failed to update DataFeedStatus for ${symbol}: ${err?.message || err}`);
  }
}

async function markDataFeedSuccess(symbol: string): Promise<void> {
  try {
    await DataFeedStatus.findOneAndUpdate(
      { symbol },
      {
        consecutiveFailures: 0,
        outageAlertSent: false,
        lastSuccessAt: new Date(),
        updatedAt: new Date()
      }
    );
  } catch {
    // Non-blocking
  }
}

async function fetchAsset5mCandles(symbol: string, source: string): Promise<CandleFetchResult> {
  if (source === 'BINANCE') {
    try {
      const candles = await fetchBinanceKlines(symbol, '5m', 250);
      return {
        candles,
        httpStatus: 200,
        errorMessage: null,
        candleCount: candles.length
      };
    } catch (err: any) {
      return {
        candles: [],
        httpStatus: err?.response?.status || 500,
        errorMessage: err?.message || 'Binance fetch error',
        candleCount: 0
      };
    }
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
  let accountState: any = null;
  let currentLiveBal = getLiveAccountBalance();

  try {
    const db = await connectToDatabase();
    if (db) {
      dbConnected = true;
      accountState = await getLiveAccountState();
      if (accountState) {
        currentLiveBal = accountState.currentBalance;
        logs.push(`Live Account Balance: $${currentLiveBal.toFixed(2)} (Total PnL: $${accountState.totalPnL.toFixed(2)} across ${accountState.totalTrades} trades)`);
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

              // Calculate pnlPoints and detailed PnL with trading fees (Spread + Slippage + Commission)
              const rawDiff = trade.action === 'BUY' ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
              const pnlPoints = Number(rawDiff.toFixed(2));
              const spec = getSymbolSpec(trade.symbol);
              const lotSize = trade.suggestedLotSize || calculatePositionSize(trade.entryPrice, trade.sl, currentLiveBal, undefined, spec.contractSize).lotSize;
              const pnlBreakdown = calculateDetailedPnL(pnlPoints, lotSize, trade.symbol, newStatus === 'BREAKEVEN');
              const netPnLUSD = pnlBreakdown.netPnLUSD;
              const grossPnLUSD = pnlBreakdown.grossPnLUSD;
              const tradingFeeUSD = pnlBreakdown.tradingFeeUSD;

              // Update account balance dynamically in database using netPnLUSD
              const accountUpdate = await applyTradeResultToAccount(netPnLUSD, newStatus, trade._id.toString());
              const updatedBal = accountUpdate.newBalance;
              currentLiveBal = updatedBal;

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
                pnlPoints,
                pnlUSD: netPnLUSD,
                grossPnLUSD,
                tradingFeeUSD,
                netPnLUSD,
                balanceAfterTrade: updatedBal,
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
              trade.suggestedLotSize = lotSize;
              trade.pnlPoints = pnlPoints;
              trade.pnlUSD = netPnLUSD;
              trade.grossPnLUSD = grossPnLUSD;
              trade.tradingFeeUSD = tradingFeeUSD;
              trade.netPnLUSD = netPnLUSD;
              trade.balanceAfterTrade = updatedBal;
              trade.closedAt = closedAt;
              await trade.save();

              logs.push(`Scalp trade ${trade._id} (${trade.symbol}) archived with result ${newStatus} (Net PnL: $${netPnLUSD} | Fee: -$${tradingFeeUSD} | Points: ${pnlPoints}) | Balance: $${updatedBal.toFixed(2)}`);

              const pnlPrefix = netPnLUSD > 0 ? '+' : '';
              const feeText = tradingFeeUSD > 0 ? `\n📉 تكلفة التداول (سبريد وانزلاق): -$${tradingFeeUSD.toFixed(2)}` : '';
              const balanceText = `\n🏦 **رصيد الحساب الآن:** $${updatedBal.toFixed(2)} (${pnlPrefix}$${netPnLUSD.toFixed(2)})`;
              const outcomeText = newStatus === 'WIN'
                ? `🎯 **تم تحقيق الهدف! (WIN)** 🚀\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\n💰 النتيجة الصافية: ${pnlPrefix}$${netPnLUSD.toFixed(2)} (${pnlPoints > 0 ? '+' : ''}${pnlPoints} نقطة) | الحجم: ${lotSize.toFixed(2)} لوت${feeText}${balanceText}`
                : (newStatus === 'BREAKEVEN'
                  ? `🛡️ **خروج على نقطة التعادل! (BREAKEVEN)** ⚖️\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\n💰 النتيجة: -$${tradingFeeUSD.toFixed(2)} (تكلفة السبريد) | الحجم: ${lotSize.toFixed(2)} لوت${balanceText}`
                  : `🛡 **ضرب وقف الخسارة! (LOSS)** 📉\nالرمز: ${trade.symbol}\nسعر الخروج: $${formatPrice(exitPrice)}\n💰 النتيجة الصافية: -$${Math.abs(netPnLUSD).toFixed(2)} (${pnlPoints} نقطة) | الحجم: ${lotSize.toFixed(2)} لوت${feeText}${balanceText}`);
              await sendTelegramNotification(outcomeText);

              // Daily Hard Circuit Breaker Trigger Check on Exit
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

                  let dailyPnL = 0;
                  const allToday = await TradeHistory.find({ closedAt: { $gte: startOfDay } });
                  for (const t of allToday) {
                    dailyPnL += (t.netPnLUSD || 0);
                  }

                  const maxLosses = getMaxConsecutiveLosses();
                  const maxDailyLoss = getMaxDailyLossUSD();

                  if (consecLosses >= maxLosses || dailyPnL <= -maxDailyLoss) {
                    const warningMsg = `⛔ **تفعيل قاطع الدائرة اليومي (Circuit Breaker Activated)** 🛡️\n\n- عدد الخسائر المتتالية اليوم: ${consecLosses} (الحد الأقصى ${maxLosses})\n- صافي خسارة اليوم: -$${Math.abs(dailyPnL).toFixed(2)} (الحد الأقصى -$${maxDailyLoss.toFixed(2)})\n- الإجراء: **تم إيقاف فتح أي صفقات جديدة آلياً حتى بداية الغد (00:00 UTC)** لحماية رأس المال.`;
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

              // 1. Breakeven Logic (Move SL to Entry Price at >= 60% TP progress for Gold, 50% for others)
              if (!trade.breakevenApplied) {
                const beRatio = matchingItem.symbol === 'XAU/USD' ? 0.6 : 0.5;
                let isBeReached = false;

                if (trade.action === 'BUY') {
                  const targetBe = trade.entryPrice + beRatio * (trade.tp - trade.entryPrice);
                  if (candleHigh >= targetBe) {
                    isBeReached = true;
                  }
                } else if (trade.action === 'SELL') {
                  const targetBe = trade.entryPrice - beRatio * (trade.entryPrice - trade.tp);
                  if (candleLow <= targetBe) {
                    isBeReached = true;
                  }
                }

                if (isBeReached) {
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

                  const rawDiff = trade.action === 'BUY' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice);
                  const pnlPoints = Number(rawDiff.toFixed(2));
                  const spec = getSymbolSpec(trade.symbol);
                  const lotSize = trade.suggestedLotSize || calculatePositionSize(trade.entryPrice, trade.sl, currentLiveBal, undefined, spec.contractSize).lotSize;
                  const pnlBreakdown = calculateDetailedPnL(pnlPoints, lotSize, trade.symbol, false);
                  const netPnLUSD = pnlBreakdown.netPnLUSD;
                  const grossPnLUSD = pnlBreakdown.grossPnLUSD;
                  const tradingFeeUSD = pnlBreakdown.tradingFeeUSD;

                  // Update account balance dynamically in database using netPnLUSD
                  const accountUpdate = await applyTradeResultToAccount(netPnLUSD, 'LOSS', trade._id.toString());
                  const updatedBal = accountUpdate.newBalance;
                  currentLiveBal = updatedBal;

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
                    pnlPoints,
                    pnlUSD: netPnLUSD,
                    grossPnLUSD,
                    tradingFeeUSD,
                    netPnLUSD,
                    balanceAfterTrade: updatedBal,
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
                  trade.suggestedLotSize = lotSize;
                  trade.pnlPoints = pnlPoints;
                  trade.pnlUSD = netPnLUSD;
                  trade.grossPnLUSD = grossPnLUSD;
                  trade.tradingFeeUSD = tradingFeeUSD;
                  trade.netPnLUSD = netPnLUSD;
                  trade.balanceAfterTrade = updatedBal;
                  trade.closedAt = closedAt;
                  await trade.save();

                  const feeText = tradingFeeUSD > 0 ? `\n📉 تكلفة التداول (سبريد وانزلاق): -$${tradingFeeUSD.toFixed(2)}` : '';
                  const timeStopMsg = `⏱️ (TIME STOP) 120m limit reached while in loss.\nالرمز: ${trade.symbol}\nسعر الإغلاق: $${formatPrice(currentPrice)}\n💰 النتيجة الصافية: -$${Math.abs(netPnLUSD).toFixed(2)} (${pnlPoints} نقطة) | الحجم: ${lotSize.toFixed(2)} لوت${feeText}\n🏦 **رصيد الحساب الآن:** $${updatedBal.toFixed(2)} (-$${Math.abs(netPnLUSD).toFixed(2)})`;
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

  // --------------------------------------------------------------------------
  // 🛡️ Daily Hard Circuit Breaker (قاطع الدائرة اليومي الإلزامي)
  // --------------------------------------------------------------------------
  let circuitBreakerTriggered = false;
  let circuitBreakerReason = '';

  if (dbConnected) {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const todayClosedTrades = await TradeHistory.find({
        closedAt: { $gte: startOfDay }
      }).sort({ closedAt: -1 });

      let consecLosses = 0;
      let dailyPnLUSD = 0;

      for (const t of todayClosedTrades) {
        dailyPnLUSD += (t.netPnLUSD || 0);
      }

      for (const t of todayClosedTrades) {
        if (t.status === 'LOSS') {
          consecLosses++;
        } else if (t.status === 'WIN') {
          break;
        }
      }

      const maxConsec = getMaxConsecutiveLosses();
      const maxDailyLoss = getMaxDailyLossUSD();

      if (consecLosses >= maxConsec) {
        circuitBreakerTriggered = true;
        circuitBreakerReason = `تم تسجيل ${consecLosses} خسائر متتالية اليوم (الحد الأقصى ${maxConsec})`;
      } else if (dailyPnLUSD <= -maxDailyLoss) {
        circuitBreakerTriggered = true;
        circuitBreakerReason = `تجاوز الحد الأقصى للخسارة اليومية: -$${Math.abs(dailyPnLUSD).toFixed(2)} (الحد الأقصى -$${maxDailyLoss.toFixed(2)})`;
      }

      if (circuitBreakerTriggered) {
        const breakerLogMsg = `⛔ [CIRCUIT BREAKER] قاطع الدائرة اليومي نشط: ${circuitBreakerReason}. تم إيقاف فتح أي صفقات جديدة حتى منتصف الليل (00:00 UTC).`;
        logs.push(breakerLogMsg);
        console.warn(breakerLogMsg);
      }
    } catch (cbErr: any) {
      logs.push(`Error checking daily circuit breaker: ${cbErr?.message || cbErr}`);
    }
  }

  // 2. Filter active assets and iterate concurrently (Promise.allSettled)
  const activeWatchlist = SCALP_WATCHLIST.filter(item => item.enabled);
  logs.push(`Active Watchlist (${activeWatchlist.length} assets): ${activeWatchlist.map(a => a.symbol).join(', ')}`);

  const assetPromises = activeWatchlist.map(async (item) => {
    const { symbol, source } = item;
    try {
      if (circuitBreakerTriggered) {
        const cbSkipMsg = `⛔ [${symbol}] قاطع الدائرة اليومي نشط (${circuitBreakerReason}). تم إيقاف التداول للحفاظ على رأس المال والأرباح.`;
        logs.push(cbSkipMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: cbSkipMsg, circuitBreaker: true };
      }

      if (isMarketWeekend(symbol)) {
        const weekendMsg = `[${symbol}] Weekend detected: Market closed for this asset. Skipping.`;
        console.log(weekendMsg);
        logs.push(weekendMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: weekendMsg };
      }

      if (isFridayBlocked(symbol)) {
        const fridayMsg = `🛡️ [${symbol}] Friday Guard Active: تم حظر التداول يوم الجمعة بالكامل لحماية الحساب من تقلبات نهاية الأسبوع وأخبار NFP.`;
        console.log(fridayMsg);
        logs.push(fridayMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: fridayMsg };
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
      const fetchResult = await fetchAsset5mCandles(symbol, source);
      const candles = fetchResult.candles;

      if (!candles || candles.length < 100) {
        const errorPart = fetchResult.errorMessage ? ` | Error: ${fetchResult.errorMessage}` : '';
        const msg = `Insufficient candle data for ${symbol} (received: ${fetchResult.candleCount} candles, HTTP ${fetchResult.httpStatus}${errorPart}, minimum 100 required for EMA100). Skipping.`;
        logs.push(msg);

        if (dbConnected) {
          await recordDataFeedFailure(symbol, fetchResult, logs);
        }

        return {
          symbol,
          signalTriggered: false,
          skipped: true,
          reason: msg,
          candleCount: fetchResult.candleCount,
          httpStatus: fetchResult.httpStatus,
          errorMessage: fetchResult.errorMessage
        };
      }

      if (dbConnected) {
        await markDataFeedSuccess(symbol);
      }

      const ind = calculateScalpIndicators(candles);
      if (!ind) {
        const msg = `Failed to calculate indicators for ${symbol}. Skipping.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const { currentClose, currentLow, currentHigh, currentEma20, currentEma100, currentRsi, prevRsi, currentAtr } = ind;

      // Trend-Filtered Dynamic Momentum Strategy Rules:
      // 1. Initial Crossover Trigger (RSI Level 50 Crossover in Trend):
      // - BUY: currentClose > currentEma100 && currentClose > currentEma20 && prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68
      // - SELL: currentClose < currentEma100 && currentClose < currentEma20 && prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32
      const isBuyCrossover = currentClose > currentEma100 && currentClose > currentEma20 && prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68;
      const isSellCrossover = currentClose < currentEma100 && currentClose < currentEma20 && prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32;

      // 2. Trend Continuation Pullback / Retest to EMA20 Trigger (Option 2):
      // Captures strong trend waves after the initial crossover trade has exited.
      // - BUY: currentClose > currentEma100 && currentEma20 > currentEma100 && currentLow <= currentEma20 && currentClose >= currentEma20 && currentRsi >= 48 && currentRsi <= 68
      // - SELL: currentClose < currentEma100 && currentEma20 < currentEma100 && currentHigh >= currentEma20 && currentClose <= currentEma20 && currentRsi <= 52 && currentRsi >= 32
      const isBuyPullback = currentClose > currentEma100 && currentEma20 > currentEma100 && currentLow <= currentEma20 && currentClose >= currentEma20 && currentRsi >= 48 && currentRsi <= 68;
      const isSellPullback = currentClose < currentEma100 && currentEma20 < currentEma100 && currentHigh >= currentEma20 && currentClose <= currentEma20 && currentRsi <= 52 && currentRsi >= 32;

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
        return {
          symbol,
          signalTriggered: false,
          close: currentClose,
          rsi: currentRsi,
          ema20: currentEma20,
          ema100: currentEma100,
          atr: currentAtr,
          slDistance: Number((currentAtr * 1.5).toFixed(2)),
          maxRiskCapUSD: getMaxTradeRiskUSD()
        };
      }

      // Session Filter Check
      if (!isSessionAllowed(symbol)) {
        const sessMsg = `[${symbol}] Outside allowed trading session. Skipping.`;
        logs.push(sessMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: sessMsg };
      }

      logs.push(`🚨 ${signalType} Scalp Signal Triggered for ${symbol}! (${triggerReason})`);

      // Dynamic Risk Management (ATR-based SL & TP)
      // 2.0 * ATR Take Profit across assets
      const normSym = normalizeSymbol(symbol).symbol;
      let tpMultiplier = 2.0;
      if (normSym === 'QQQ' || isForexPair(symbol)) {
        tpMultiplier = 2.0; // 2.0x ATR for QQQ and Forex
      }

      const sl = signalType === 'BUY'
        ? currentClose - (currentAtr * 1.5)
        : currentClose + (currentAtr * 1.5);

      const tp = signalType === 'BUY'
        ? currentClose + (currentAtr * tpMultiplier)
        : currentClose - (currentAtr * tpMultiplier);

      const spec = getSymbolSpec(symbol);
      const posSize = calculatePositionSize(
        currentClose,
        sl,
        currentLiveBal,
        getLiveRiskPercent(),
        spec.contractSize
      );

      // 🛡️ فحص سقف المخاطرة الأقصى (Max Risk Cap) لحماية الحساب من قفزات الـ ATR العنيفة
      if (posSize.exceedsMaxRiskCap) {
        const skipCapMsg = `🚨 [${symbol}] تم تخطي الصفقة: مسافة وقف الخسارة تستلزم مخاطرة ($${posSize.actualRiskUSD.toFixed(2)}) تتجاوز سقف المخاطرة المسموح به ($${getMaxTradeRiskUSD().toFixed(2)}) بسبب تضخم الـ ATR (${currentAtr.toFixed(2)}). تم إلغاء الصفقة لحماية الحساب.`;
        logs.push(skipCapMsg);
        console.warn(skipCapMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: skipCapMsg };
      }

      // 🤖 Groq AI Gatekeeper: فحص جودة وتوافق الإشارة قبل التنفيذ
      const groqValidation = await validateTradeConfluenceWithGroq({
        symbol,
        action: signalType,
        triggerReason: triggerReason || 'CROSSOVER',
        entryPrice: currentClose,
        sl,
        tp,
        rsi: currentRsi,
        ema20: currentEma20,
        ema100: currentEma100,
        atr: currentAtr
      });

      if (!groqValidation.approved) {
        const rejectMsg = `🤖 [${symbol}] رفضت Groq AI الصفقة (تقييم: ${groqValidation.score}/10) | السبب: ${groqValidation.reason}`;
        logs.push(rejectMsg);
        console.log(rejectMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: rejectMsg, groqValidation };
      }

      logs.push(`✅ [${symbol}] وافقت Groq AI على الصفقة (تقييم: ${groqValidation.score}/10) | السبب: ${groqValidation.reason}`);

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
      const entryTypeArabic = triggerReason === 'PULLBACK' ? 'ارتداد وإعادة اختبار (EMA20 Pullback)' : 'تقاطع زخم مع الاتجاه (RSI Crossover)';
      let telegramMsg = `${groqAnalysis}\n\n📊 **تفاصيل السكالبينج (Trend-Filtered Momentum + AI Gatekeeper):**\n- الأصل: ${symbol}\n- نوع الدخول: 🎯 ${entryTypeArabic}\n- 🤖 تقييم الذكاء الاصطناعي (Groq Score): **${groqValidation.score}/10** (${groqValidation.reason})\n- السعر: $${formatPrice(currentClose)}\n- 🏦 رصيد الحساب: $${currentLiveBal.toFixed(2)}\n- 📏 حجم الصفقة المقترح: ${posSize.lotSize.toFixed(2)} لوت (المخاطرة: $${posSize.actualRiskUSD.toFixed(2)} / سقف $${getMaxTradeRiskUSD().toFixed(2)})\n- SL (1.5x ATR): $${formatPrice(sl)} | TP (${tpMultiplier.toFixed(1)}x ATR): $${formatPrice(tp)}\n- ATR (14): $${formatPrice(signalDetails.atr)}\n- RSI (14): ${formatPrice(signalDetails.rsi)} | EMA20: $${formatPrice(signalDetails.ema20)} | EMA100: $${formatPrice(signalDetails.ema100)}`;
      if (posSize.hasRiskWarning) {
        telegramMsg += `\n\n${posSize.riskWarningMessage}`;
      }
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
    engine: '5m High-Frequency Scalper',
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
