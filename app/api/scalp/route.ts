import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/mongodb';
import Trade from '@/models/Trade';
import TradeHistory from '@/models/TradeHistory';
import DetailedTradeLog from '@/models/DetailedTradeLog';
import type { Candle } from '@/lib/binance';
import { fetchTwelveData5mKlines } from '@/lib/twelvedata';
import { calculateScalpIndicators, formatPrice } from '@/lib/indicators';
import { validateTradeConfluenceWithGroq } from '@/lib/groq';
import { sendTelegramNotification } from '@/lib/telegram';
import { diagnoseTradeOutcome } from '@/lib/tradeDiagnosis';
import { evaluateShadow, type ShadowTradeInput } from '@/lib/shadowSimulation';
import { runExitEngine, type ExitKind } from '@/lib/exitEngine';
import {
  calculatePositionSize,
  calculateDetailedPnL,
  getLiveAccountBalance,
  getLiveRiskPercent,
  getSymbolSpec,
  getMaxDailyLossUnits,
  getMaxConsecutiveLosses,
  getCoolDownMinutes,
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

// XAU/USD is OTC and has no single global exchange calendar. Use the main
// 100-oz COMEX gold futures session as a conservative global-market reference:
// Sun 18:00–Fri 17:00 New York time, with the daily 17:00–18:00 break.
// Freshness checks also reject stale data during holidays and unscheduled stops.
const GOLD_MARKET_TIME_ZONE = 'America/New_York';
const DISPLAY_TIME_ZONE = 'Africa/Cairo';
const MAX_CLOSED_CANDLE_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRY_SIGNAL_AGE_MS = 7.5 * 60 * 1000; // 7.5 minutes: allows for 5m candle duration + cron interval + API latency
const ENTRY_SIGNAL_VALIDITY_MS = 7.5 * 60 * 1000;

function isGoldSymbol(symbol: string): boolean {
  const norm = (symbol || '').toUpperCase();
  return norm.includes('XAU') || norm.includes('GOLD');
}

function isGoldMarketOpen(date: Date): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: GOLD_MARKET_TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
    if (!Number.isFinite(minuteOfDay)) return false;

    if (values.weekday === 'Sun') return minuteOfDay >= 18 * 60;
    if (['Mon', 'Tue', 'Wed', 'Thu'].includes(values.weekday)) {
      return minuteOfDay < 17 * 60 || minuteOfDay >= 18 * 60;
    }
    if (values.weekday === 'Fri') return minuteOfDay < 17 * 60;
    return false;
  } catch {
    return false;
  }
}

function isSessionAllowed(symbol: string, date: Date = new Date()): boolean {
  const norm = normalizeSymbol(symbol).symbol;
  if (isGoldSymbol(norm)) {
    return isGoldMarketOpen(date);
  }

  if (norm === 'EUR/USD') {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const cairoDecimalHour = Number(values.hour) + Number(values.minute) / 60;
    return cairoDecimalHour >= 8;
  }
  return true;
}

function getClosedCandles(candles: Candle[], now: Date = new Date()): Candle[] {
  const nowMs = now.getTime();
  return candles
    .filter(c => Number.isFinite(c.openTime) && Number.isFinite(c.closeTime)
      && c.closeTime > c.openTime && c.closeTime <= nowMs)
    .sort((a, b) => a.openTime - b.openTime);
}

// ---------------------------------------------------------------------------
// Shadow (counterfactual) evaluation. Records only; never changes a decision.
// ---------------------------------------------------------------------------
const SHADOW_REFRESH_WINDOW_MS = 20 * 60 * 60 * 1000;
const shadowRefreshInFlight = new Set<string>();

function hardStopMultiplierFor(symbol: string): number {
  return symbol.includes('QQQ') || symbol.includes('IXIC') ? 2.5 : 3.0;
}

function shadowInputFromTrade(trade: any): ShadowTradeInput {
  return {
    action: trade.action,
    symbol: trade.symbol,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice ?? trade.tp,
    atr: trade.atr || Math.abs(trade.entryPrice - (trade.slPrice ?? trade.sl)) / 1.5,
    lotSize: trade.lotSize || trade.suggestedLotSize || 0.01,
    entryTimestamp: new Date(trade.entryTimestamp ?? trade.timestamp).getTime(),
    hardStopMultiplier: hardStopMultiplierFor(trade.symbol)
  };
}

async function attachShadowEvaluation(
  tradeId: string,
  input: ShadowTradeInput,
  candles: Candle[],
  closedAt: Date
): Promise<void> {
  try {
    const shadow = evaluateShadow(input, candles, closedAt);
    if (!shadow.dataCoversEntry) return;
    await DetailedTradeLog.updateOne(
      { tradeId },
      {
        $set: {
          shadowVariants: shadow.variants,
          postExit: shadow.postExit,
          shadowFinalized: shadow.finalized,
          shadowEvaluatedAt: shadow.evaluatedAt
        }
      }
    );
  } catch (shadowErr: any) {
    console.warn('Shadow evaluation error:', shadowErr?.message || shadowErr);
  }
}

/**
 * Continues the counterfactual replay for recently closed trades using fresh
 * candles, and measures whether the original target was reached after the exit.
 * Called from the cycles that already fetch candles, so it costs no extra feed.
 */
async function refreshShadowEvaluations(symbol: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  if (shadowRefreshInFlight.has(symbol)) return;
  shadowRefreshInFlight.add(symbol);
  try {
    const since = new Date(Date.now() - SHADOW_REFRESH_WINDOW_MS);
    const recent = await DetailedTradeLog.find({
      symbol,
      status: { $in: ['WIN', 'LOSS', 'BREAKEVEN'] },
      closedAt: { $gte: since },
      shadowFinalized: { $ne: true }
    })
      .select('tradeId action symbol entryPrice tpPrice slPrice atr lotSize entryTimestamp closedAt')
      .limit(40)
      .lean();

    for (const log of recent) {
      if (!log.closedAt) continue;
      const shadow = evaluateShadow(shadowInputFromTrade(log), candles, new Date(log.closedAt));
      if (!shadow.dataCoversEntry) continue;
      await DetailedTradeLog.updateOne(
        { _id: log._id },
        {
          $set: {
            shadowVariants: shadow.variants,
            postExit: shadow.postExit,
            shadowFinalized: shadow.finalized,
            shadowEvaluatedAt: shadow.evaluatedAt
          }
        }
      );
    }
  } catch (shadowErr: any) {
    console.warn('Shadow refresh error:', shadowErr?.message || shadowErr);
  } finally {
    shadowRefreshInFlight.delete(symbol);
  }
}

function isFreshClosedCandleData(candles: Candle[], now: Date = new Date()): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  const ageMs = now.getTime() - latest.closeTime;
  return ageMs >= 0 && ageMs <= MAX_CLOSED_CANDLE_AGE_MS;
}

function formatCairoTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function getSessionName(date: Date): string {
  const utcHour = date.getUTCHours();
  if (utcHour >= 13 && utcHour < 16) return 'LONDON_NY_OVERLAP';
  if (utcHour >= 8 && utcHour < 16) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  if (utcHour >= 0 && utcHour < 8) return 'ASIAN';
  return 'PACIFIC';
}

async function getRiskCircuitBreakerReason(): Promise<string | null> {
  const now = new Date();
  const startOfUtcDay = new Date(now);
  startOfUtcDay.setUTCHours(0, 0, 0, 0);

  const todaysTrades = await TradeHistory.find({
    tradeType: 'SCALP',
    closedAt: { $gte: startOfUtcDay }
  }).select('status netPnLUSD suggestedLotSize closedAt').sort({ closedAt: -1 }).lean();

  // نقيس الخسارة بوحدات «0.01 لوت» بدلاً من الدولار الخام، حتى لا يتقلّص السقف
  // بأثر رجعي إذا نزل اللوت بعد خسارة كانت في حدود سقفها وقت حدوثها.
  // units = netPnLUSD × (0.01 ÷ lotSize)  → ربح وخسارة بنفس المعاملة.
  const todaysNetUnits = todaysTrades.reduce((total, trade) => {
    if (typeof trade.netPnLUSD !== 'number') return total;
    const lot = typeof trade.suggestedLotSize === 'number' && trade.suggestedLotSize > 0
      ? trade.suggestedLotSize
      : 0.01;
    return total + trade.netPnLUSD * (0.01 / lot);
  }, 0);
  const dailyLossCapUnits = getMaxDailyLossUnits();
  if (todaysNetUnits <= -dailyLossCapUnits) {
    return `Daily model-loss limit reached (${todaysNetUnits.toFixed(2)} units vs cap ${dailyLossCapUnits.toFixed(2)} units, normalized to 0.01 lot).`;
  }

  const maxConsecutiveLosses = getMaxConsecutiveLosses();
  const recentTrades = await TradeHistory.find({ tradeType: 'SCALP' })
    .select('status closedAt')
    .sort({ closedAt: -1 })
    .limit(maxConsecutiveLosses)
    .lean();
  const latestLoss = recentTrades[0];
  const isLossStreak = recentTrades.length >= maxConsecutiveLosses
    && recentTrades.every(trade => trade.status === 'LOSS');
  const coolingDown = latestLoss?.closedAt
    && now.getTime() - new Date(latestLoss.closedAt).getTime() < getCoolDownMinutes() * 60 * 1000;

  if (isLossStreak && coolingDown) {
    return `${maxConsecutiveLosses} consecutive model losses; ${getCoolDownMinutes()} minute cooldown is active.`;
  }
  return null;
}

interface CandleFetchResponse {
  candles: Candle[];
  feedSource: string;
}

async function fetchAsset5mCandles(symbol: string): Promise<CandleFetchResponse> {
  const result = await fetchTwelveData5mKlines(symbol, '5min', 250);
  if (result?.candles && result.candles.length >= 100) {
    return { candles: result.candles, feedSource: `TWELVEDATA ${symbol}` };
  }
  return { candles: [], feedSource: 'NONE (Twelve Data unavailable; proxy-price fallback disabled)' };
}

async function runScalperEngine() {
  const logs: string[] = [];
  logs.push(`Starting 5m Multi-Asset Scalper Engine Cycle (September 9 Strategy) at ${new Date().toISOString()}`);

  logs.push(`Cairo clock: ${formatCairoTime(new Date())}. Gold session uses the COMEX global benchmark; closed or stale feeds are rejected.`);

  let dbConnected = false;
  let accountState: any = null;
  let currentLiveBal = getLiveAccountBalance();

  try {
    const db = await connectToDatabase();
    if (db) {
      dbConnected = true;
      try {
        await mongoose.connection.db?.collection('system_heartbeat').updateOne(
          { _id: 'scalp_cron' as any },
          { $set: { lastRunAt: new Date(), lastRunCairo: formatCairoTime(new Date()) } },
          { upsert: true }
        );
      } catch {}
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
          if (!isSessionAllowed(matchingItem.symbol)) {
            logs.push(`[${matchingItem.symbol}] Broker market closed, skipping pending evaluation.`);
            continue;
          }
          const fetchRes = await fetchAsset5mCandles(matchingItem.symbol);
          const candles = getClosedCandles(fetchRes.candles);
          if (dbConnected) {
            await refreshShadowEvaluations(matchingItem.symbol, candles);
          }
          if (!candles || candles.length === 0) {
            logs.push(`[Pending Evaluation] Could not fetch candles for ${trade.symbol} (${fetchRes.feedSource}). Will retry next cycle.`);
            continue;
          }
          if (!isFreshClosedCandleData(candles)) {
            const ageMinutes = ((Date.now() - candles[candles.length - 1].closeTime) / 60000).toFixed(1);
            logs.push(`[Pending Evaluation] Stale ${fetchRes.feedSource} candles for ${trade.symbol} (${ageMinutes} minutes old). No outcome recorded.`);
            continue;
          }

          if (candles && candles.length > 0) {
            const entryTimeMs = trade.timestamp ? new Date(trade.timestamp).getTime() : 0;

            // Every candle that closes after the entry belongs to the trade —
            // including the candle that contains the entry itself. The old
            // filter dropped that candle, which hid flash reversals: on
            // 16/11/2026 01:00 the price wicked 6.34 points below the stop
            // inside the entry candle and the trade was still recorded as a win.
            const evalCandles = candles.filter(c => c.closeTime > entryTimeMs);
            if (evalCandles.length === 0) {
              logs.push(`[Pending Evaluation] No completed 5m candle after entry for ${trade.symbol}; keeping the trade open.`);
              continue;
            }

            const currentCandle = candles[candles.length - 1];
            const currentPrice = currentCandle.close;
            const candleHigh = currentCandle.high !== undefined ? currentCandle.high : currentPrice;
            const candleLow = currentCandle.low !== undefined ? currentCandle.low : currentPrice;

            const isGold = matchingItem.symbol.includes('XAU') || matchingItem.symbol.includes('GOLD');
            const isQQQ = matchingItem.symbol.includes('QQQ') || matchingItem.symbol.includes('IXIC');
            const hardSlMult = isQQQ ? 2.5 : 3.0;
            const atrVal = trade.atr || (Math.abs(trade.sl - trade.entryPrice) / 1.5);

            // trade.sl is mutated by breakeven and profit locks, so the original
            // level is stored separately. Trades opened before initialSl existed
            // can be reconstructed exactly, because SL = entry ∓ 1.5×ATR.
            const storedInitialSl = (trade as any).initialSl;
            const initialSl = Number.isFinite(storedInitialSl) && storedInitialSl > 0
              ? storedInitialSl
              : (trade.action === 'BUY'
                  ? trade.entryPrice - atrVal * 1.5
                  : trade.entryPrice + atrVal * 1.5);

            // First-touch-per-level walk with management applied from the next
            // candle. See lib/exitEngine.ts for the full contract.
            const exitState = runExitEngine(
              {
                action: trade.action,
                entryPrice: trade.entryPrice,
                tpPrice: trade.tp,
                initialSl,
                atr: atrVal,
                hardStopMultiplier: hardSlMult,
                entryTimestamp: entryTimeMs,
                policy: { breakevenBufferPoints: isGold ? 0.5 : 0.0 }
              },
              evalCandles
            );

            const highestHighSinceEntry = exitState.highestHighDuringTrade;
            const lowestLowSinceEntry = exitState.lowestLowDuringTrade;

            logs.push(`[Pending Trade ${trade.symbol}] Current: ${formatPrice(currentPrice)} | High: ${formatPrice(candleHigh)} (Max since entry: ${formatPrice(highestHighSinceEntry)}) | Low: ${formatPrice(candleLow)} (Min since entry: ${formatPrice(lowestLowSinceEntry)}) | TP: ${formatPrice(trade.tp)} | Stop: ${formatPrice(exitState.stopAtExit)} | Model: touch${exitState.ambiguousSameCandle ? ' (ambiguous)' : ''}`);

            const newStatus: 'WIN' | 'LOSS' | 'BREAKEVEN' | null = exitState.status;
            const exitPrice = exitState.exitPrice ?? currentPrice;
            const resolvedExitReason: ExitKind | null = exitState.exitReason;

            if (newStatus) {
              // Settle at the close of the candle that produced the touch, not at
              // whatever moment the cron happened to run.
              const closedAt = exitState.exitCandleCloseTime
                ? new Date(exitState.exitCandleCloseTime)
                : new Date();
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
                sl: exitState.stopAtExit,
                tp: trade.tp,
                status: newStatus,
                suggestedLotSize: lotSize,
                triggerReason: trade.triggerReason,
                groqScore: trade.groqScore,
                groqReason: trade.groqReason,
                riskUSD: trade.riskUSD,
                potentialProfitUSD: trade.potentialProfitUSD,
                pnlPoints: Number(pnlPoints.toFixed(4)),
                grossPnLUSD: detailed.grossPnLUSD,
                tradingFeeUSD: detailed.tradingFeeUSD,
                netPnLUSD: detailed.netPnLUSD,
                balanceAfterTrade: accountUpdate.newBalance,
                rsi: trade.rsi,
                ema20: trade.ema20,
                ema100: trade.ema100 || trade.ema200,
                atr: trade.atr,
                feedSource: trade.feedSource,
                sourceCandleCloseTime: trade.sourceCandleCloseTime,
                exitRsi: indExit ? indExit.currentRsi : undefined,
                exitEma20: indExit ? indExit.currentEma20 : undefined,
                exitEma100: indExit ? indExit.currentEma100 : undefined,
                exitAtr: indExit ? indExit.currentAtr : undefined,
                groqAnalysis: trade.groqAnalysis,
                entryTimestamp: trade.timestamp,
                closedAt
              });

              // Update the dedicated DetailedTradeLog collection
              let diagnosis: any = null;
              try {
                const durationMins = Math.max(1, Math.round((closedAt.getTime() - new Date(trade.timestamp).getTime()) / 60000));
                const exitReasonVal: 'TAKE_PROFIT' | 'SOFT_STOP' | 'HARD_STOP' | 'BREAKEVEN' | 'TIMEOUT' =
                  resolvedExitReason || (newStatus === 'WIN' ? 'TAKE_PROFIT' : isBe ? 'BREAKEVEN' : 'SOFT_STOP');

                diagnosis = diagnoseTradeOutcome({
                  action: trade.action,
                  status: newStatus,
                  exitReason: exitReasonVal,
                  entryPrice: trade.entryPrice,
                  exitPrice,
                  // The stop that was actually in force when the trade ended
                  // (original 1.5×ATR, or the raised breakeven/profit-lock level).
                  slPrice: exitState.stopAtExit,
                  tpPrice: trade.tp,
                  pnlPoints: Number(pnlPoints.toFixed(4)),
                  netPnLUSD: detailed.netPnLUSD,
                  durationMinutes: durationMins,
                  highestHighDuringTrade: highestHighSinceEntry,
                  lowestLowDuringTrade: lowestLowSinceEntry,
                  rsi: trade.rsi,
                  exitRsi: indExit ? indExit.currentRsi : undefined,
                  sessionName: getSessionName(new Date()),
                  triggerReason: trade.triggerReason,
                  atr: atrVal,
                  riskAmountUSD: trade.riskUSD ?? Math.abs(trade.entryPrice - initialSl) * 100 * lotSize,
                  hardStopMultiplier: hardSlMult
                });

                await DetailedTradeLog.findOneAndUpdate(
                  { tradeId: trade._id.toString() },
                  {
                    $set: {
                      status: newStatus,
                      exitPrice,
                      closedAt,
                      closedCairoTime: formatCairoTime(closedAt),
                      durationMinutes: durationMins,
                      exitReason: exitReasonVal,
                      exitModel: 'touch',
                      ambiguousSameCandle: exitState.ambiguousSameCandle,
                      stopAtExit: exitState.stopAtExit,
                      outcomeReasonArabic: diagnosis.outcomeReasonArabic,
                      postTradeLesson: diagnosis.postTradeLesson,
                      maxDrawdownPoints: diagnosis.maxDrawdownPoints,
                      maxFavorablePoints: diagnosis.maxFavorablePoints,
                      pnlPoints: Number(pnlPoints.toFixed(4)),
                      grossPnLUSD: detailed.grossPnLUSD,
                      tradingFeeUSD: detailed.tradingFeeUSD,
                      spreadCostUSD: detailed.spreadCostUSD,
                      slippageCostUSD: detailed.slippageCostUSD,
                      commissionUSD: detailed.commissionUSD,
                      netPnLUSD: detailed.netPnLUSD,
                      balanceAfterTrade: accountUpdate.newBalance,
                      exitRsi: indExit ? indExit.currentRsi : undefined,
                      exitEma20: indExit ? indExit.currentEma20 : undefined,
                      exitEma100: indExit ? indExit.currentEma100 : undefined,
                      exitAtr: indExit ? indExit.currentAtr : undefined,
                      highestHighDuringTrade: highestHighSinceEntry,
                      lowestLowDuringTrade: lowestLowSinceEntry
                    }
                  },
                  { upsert: false }
                );
              } catch (detErr: any) {
                console.warn('DetailedTradeLog update error:', detErr?.message || detErr);
              }

              // Counterfactual (shadow) replay of alternative exit rules. Recording only.
              await attachShadowEvaluation(
                trade._id.toString(),
                {
                  action: trade.action,
                  symbol: trade.symbol,
                  entryPrice: trade.entryPrice,
                  tpPrice: trade.tp,
                  atr: atrVal,
                  lotSize,
                  entryTimestamp: new Date(trade.timestamp).getTime(),
                  hardStopMultiplier: hardSlMult
                },
                evalCandles,
                closedAt
              );

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
              const tradeActionText = trade.action === 'BUY' ? '🟢 شراء (BUY)' : '🔴 بيع (SELL)';
              const diagText = diagnosis?.outcomeReasonArabic ? `\n\n🔍 **التحليل الجنائي للنتيجة:**\n${diagnosis.outcomeReasonArabic}` : '';
              const ambiguousText = exitState.ambiguousSameCandle
                ? `\n⚠️ **ملاحظة دقة:** شمعة الـ5 دقائق التي أغلقت الصفقة لمست الهدف والوقف معاً، ولا يمكن معرفة أيّهما أولاً من بيانات الشمعة. سُجّل الوقف أولاً (السيناريو الأسوأ).`
                : '';

              if (newStatus === 'WIN') {
                outcomeText = `🎯 **تم تحقيق الهدف بنجاح (Take Profit Hit)!** 🟢\n\n` +
                  `🪙 **الأصل:** ${trade.symbol} (ذهب)\n` +
                  `📊 **نوع الصفقة:** ${tradeActionText}\n` +
                  `💵 **سعر الدخول الأصلي:** ${formatPrice(trade.entryPrice)}\n` +
                  `🎯 **سعر الخروج (الهدف):** ${formatPrice(exitPrice)}\n` +
                  `🛑 **وقف الخسارة وقت الخروج:** ${formatPrice(exitState.stopAtExit)}\n` +
                  `💰 **الربح المحقق:** +${pnlPoints.toFixed(2)} نقطة (+${detailed.netPnLUSD.toFixed(2)} دولار صافي بعد التكاليف ${detailed.tradingFeeUSD.toFixed(2)} دولار)\n` +
                  `📈 **رصيد الحساب:** ${accountUpdate.newBalance.toFixed(2)} دولار` +
                  ambiguousText +
                  diagText;
              } else if (newStatus === 'BREAKEVEN') {
                const pnlSign = detailed.netPnLUSD >= 0 ? '+' : '';
                const isBigBe = pnlPoints >= 1.5;
                const beTitle = isBigBe ? '🔒 **إغلاق بتأمين أرباح متقدم (Breakeven كبير)!** 💵' : '🛡️ **إغلاق على تأمين الدخول (BREAKEVEN)!** ⚖️';
                outcomeText = `${beTitle}\n\n` +
                  `🪙 **الأصل:** ${trade.symbol} (ذهب)\n` +
                  `📊 **نوع الصفقة:** ${tradeActionText}\n` +
                  `💵 **سعر الدخول الأصلي:** ${formatPrice(trade.entryPrice)}\n` +
                  `🛡️ **سعر الخروج عند الوقف المؤمَّن:** ${formatPrice(exitPrice)}\n` +
                  `🎯 **الهدف كان:** ${formatPrice(trade.tp)}\n` +
                  `💰 **الربح المحقق:** ${pnlSign}${pnlPoints.toFixed(2)} نقطة (${pnlSign}${detailed.netPnLUSD.toFixed(2)} دولار صافي بعد التكاليف ${detailed.tradingFeeUSD.toFixed(2)} دولار)\n` +
                  `📈 **رصيد الحساب:** ${accountUpdate.newBalance.toFixed(2)} دولار` +
                  ambiguousText +
                  diagText;
              } else if (resolvedExitReason === 'TIMEOUT') {
                outcomeText = `⏱️ **خروج زمني (Time Stop 120 دقيقة)!** 🔴\n\n` +
                  `🪙 **الأصل:** ${trade.symbol} (ذهب)\n` +
                  `📊 **نوع الصفقة:** ${tradeActionText}\n` +
                  `💵 **سعر الدخول الأصلي:** ${formatPrice(trade.entryPrice)}\n` +
                  `⏱️ **سعر الخروج (إغلاق الشمعة):** ${formatPrice(exitPrice)}\n` +
                  `🛑 **الوقف كان:** ${formatPrice(exitState.stopAtExit)}\n` +
                  `📉 **النتيجة:** ${pnlPoints.toFixed(2)} نقطة (${detailed.netPnLUSD.toFixed(2)} دولار صافي بعد التكاليف ${detailed.tradingFeeUSD.toFixed(2)} دولار)\n` +
                  `📈 **رصيد الحساب:** ${accountUpdate.newBalance.toFixed(2)} دولار` +
                  diagText;
              } else {
                outcomeText = `🛑 **ضرب وقف الخسارة (Stop Loss Hit)!** 🔴\n\n` +
                  `🪙 **الأصل:** ${trade.symbol} (ذهب)\n` +
                  `📊 **نوع الصفقة:** ${tradeActionText}\n` +
                  `💵 **سعر الدخول الأصلي:** ${formatPrice(trade.entryPrice)}\n` +
                  `🛑 **سعر الخروج عند الوقف:** ${formatPrice(exitPrice)}\n` +
                  `🎯 **الهدف كان:** ${formatPrice(trade.tp)}\n` +
                  `📉 **النتيجة:** ${pnlPoints.toFixed(2)} نقطة (${detailed.netPnLUSD.toFixed(2)} دولار صافي بعد التكاليف ${detailed.tradingFeeUSD.toFixed(2)} دولار)\n` +
                  `📈 **رصيد الحساب:** ${accountUpdate.newBalance.toFixed(2)} دولار` +
                  ambiguousText +
                  diagText;
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
              // Trade Management: breakeven at 50%, Tier 2 and Tier 3 locks.
              // The engine above already decided which levels this trade has
              // reached and where the stop belongs. Nothing here re-checks the
              // stop against the candle that raised it: a level raised from a
              // candle's extreme can only be filled from the next candle.
              // -------------------------------------------------------------
              const persistedSl = Number(trade.sl);
              const isImprovement = trade.action === 'BUY'
                ? exitState.stopAtExit > persistedSl
                : exitState.stopAtExit < persistedSl;
              const stopMoved = isImprovement
                && Number.isFinite(exitState.stopAtExit)
                && Math.abs(exitState.stopAtExit - persistedSl) > 0.005;

              if (stopMoved) {
                const lastLevelEvent = [...exitState.events]
                  .reverse()
                  .find(e => e.kind === 'BREAKEVEN_SET' || e.kind === 'PROFIT_LOCK');
                const wasBreakeven = trade.breakevenApplied === true;

                trade.sl = exitState.stopAtExit;
                trade.breakevenApplied = exitState.breakevenApplied;
                await trade.save();

                const lotSize = trade.suggestedLotSize || 0.01;
                const lockedPoints = Math.abs(exitState.stopAtExit - trade.entryPrice);
                const approxCashUSD = calculateDetailedPnL(lockedPoints, lotSize, trade.symbol).grossPnLUSD.toFixed(2);
                const movedAt = lastLevelEvent
                  ? formatCairoTime(new Date(lastLevelEvent.candleCloseTime))
                  : formatCairoTime(new Date());
                const isBeMove = lastLevelEvent
                  ? lastLevelEvent.kind === 'BREAKEVEN_SET'
                  : !wasBreakeven;

                const executionNote = '⚠️ **مهم للتنفيذ:** ارفع أمر الوقف في MT5 الآن. المستوى الجديد لا يعمل إلا من الشمعة التالية، والبوت لا يرسل أوامر لوسيطك.';
                const levelMsg = isBeMove
                  ? `🛡️ **تأمين الصفقة (Breakeven عند 50% من الهدف)** 🎯\n\n` +
                    `🪙 **الأصل:** ${trade.symbol} (${trade.action === 'BUY' ? 'شراء BUY' : 'بيع SELL'})\n` +
                    `💵 **سعر الدخول:** ${formatPrice(trade.entryPrice)}\n` +
                    `🎯 **الهدف:** ${formatPrice(trade.tp)}\n` +
                    `🛡️ **وقف الخسارة أصبح:** **${formatPrice(exitState.stopAtExit)}**\n` +
                    `🕒 **الشمعة التي رفعت الوقف:** ${movedAt}\n` +
                    executionNote
                  : `🔒 **حجز أرباح (Profit Lock)** 💵\n\n` +
                    `🪙 **الأصل:** ${trade.symbol} (${trade.action === 'BUY' ? 'شراء BUY' : 'بيع SELL'})\n` +
                    `💵 **سعر الدخول:** ${formatPrice(trade.entryPrice)}\n` +
                    `🎯 **الهدف:** ${formatPrice(trade.tp)}\n` +
                    `🔒 **وقف الخسارة أصبح:** **${formatPrice(exitState.stopAtExit)}** (+${lockedPoints.toFixed(2)} نقطة ≈ ${approxCashUSD} دولار عند ${lotSize} لوت)\n` +
                    `🕒 **الشمعة التي رفعت الوقف:** ${movedAt}\n` +
                    executionNote;

                logs.push(levelMsg);
                console.log(levelMsg);
                await sendTelegramNotification(levelMsg);
              } else if (trade.breakevenApplied !== exitState.breakevenApplied) {
                trade.breakevenApplied = exitState.breakevenApplied;
                await trade.save();
              }
            }
          }
        }
      }
    } catch (pendingErr: any) {
      logs.push(`Error evaluating pending scalp trades: ${pendingErr?.message || pendingErr}`);
    }
  }

  // Scan each invocation because REST candle delivery can trail the bar close.
  // Persisted sourceCandleCloseTime prevents duplicate alerts for the same bar.
  const activeWatchlist = SCALP_WATCHLIST.filter(item => item.enabled);
  logs.push(`Active Watchlist (${activeWatchlist.length} assets): ${activeWatchlist.map(a => a.symbol).join(', ')}`);

  let entryRiskBlockReason: string | null = null;
  if (!dbConnected) {
    entryRiskBlockReason = 'Database unavailable; refusing to create untracked signals.';
  } else {
    try {
      entryRiskBlockReason = await getRiskCircuitBreakerReason();
      if (entryRiskBlockReason) logs.push(`[Entry Circuit Breaker] ${entryRiskBlockReason}`);
    } catch (riskStateError: any) {
      entryRiskBlockReason = 'Could not verify model risk limits; refusing new signals.';
      logs.push(`[Entry Circuit Breaker] ${entryRiskBlockReason} ${riskStateError?.message || riskStateError}`);
    }
  }

  const assetPromises = activeWatchlist.map(async (item) => {
    const { symbol, source } = item;
    try {
      if (entryRiskBlockReason) {
        return { symbol, signalTriggered: false, skipped: true, reason: entryRiskBlockReason };
      }

      if (!isSessionAllowed(symbol)) {
        const closedMsg = `[${symbol}] Outside the broker trading session. Skipping.`;
        console.log(closedMsg);
        logs.push(closedMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: closedMsg };
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
      const fetchRes = await fetchAsset5mCandles(symbol);
      const candles = getClosedCandles(fetchRes.candles);

      if (dbConnected && candles.length > 0) {
        await refreshShadowEvaluations(symbol, candles);
      }

      if (!candles || candles.length < 100) {
        const msg = `Insufficient candle data for ${symbol} (${fetchRes.feedSource}). Skipping.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      if (!isFreshClosedCandleData(candles)) {
        const ageMinutes = ((Date.now() - candles[candles.length - 1].closeTime) / 60000).toFixed(1);
        const msg = `[${symbol}] Latest completed candle is stale (${ageMinutes} minutes old; max ${MAX_CLOSED_CANDLE_AGE_MS / 60000}). Skipping signal.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const initialSignalAgeMs = Date.now() - candles[candles.length - 1].closeTime;
      if (initialSignalAgeMs > MAX_ENTRY_SIGNAL_AGE_MS) {
        const ageSeconds = (initialSignalAgeMs / 1000).toFixed(0);
        const msg = `[${symbol}] Latest candle is ${ageSeconds}s old; entry signals expire after ${MAX_ENTRY_SIGNAL_AGE_MS / 1000}s. Skipping.`;
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
      const latestClosedCandle = candles[candles.length - 1];
      const sourceCandleCloseTime = new Date(latestClosedCandle.closeTime);
      const sourceSignalExpiresAt = new Date(latestClosedCandle.closeTime + ENTRY_SIGNAL_VALIDITY_MS);
      const latestCandleTime = formatCairoTime(new Date(latestClosedCandle.closeTime));
      logs.push(`[Data Feed Confirmed: ${fetchRes.feedSource}] Fetched ${candles.length} closed candles for ${symbol}. Latest price: ${currentClose} (bar closed: ${latestCandleTime} Cairo time)`);

      if (!dbConnected) {
        const msg = `[${symbol}] Database unavailable. Refusing to send an untracked signal.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const priorSignalForBar = await Trade.findOne({ symbol, tradeType: 'SCALP', sourceCandleCloseTime });
      if (priorSignalForBar) {
        const msg = `[${symbol}] A signal was already recorded for the ${latestCandleTime} candle. Skipping duplicate.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      // Trend-Filtered Dynamic Momentum Strategy Rules (September 9 Baseline + EMA20 Pullback):
      // 1. Initial Crossover Trigger (RSI Level 50 Crossover in Trend):
      const isBuyTrend = currentClose > currentEma100 && currentClose > currentEma20;
      const isSellTrend = currentClose < currentEma100 && currentClose < currentEma20;

      const isBuyCrossover = isBuyTrend && prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68;
      const isSellCrossover = isSellTrend && prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32;

      // 2. Trend Continuation Pullback / Retest to EMA20 Trigger:
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

      // Fail closed only on absolute dollar cap (e.g. wild news candle ATR > $7), but allow broker minimum lot 0.01
      if (posSize.exceedsMaxRiskCap) {
        const capMsg = `[${symbol}] 🚨 actual risk exceeds the configured dollar cap (actual $${posSize.actualRiskUSD.toFixed(2)} vs cap $${posSize.maxRiskCapUSD.toFixed(2)} for ${posSize.lotSize} lot; ATR ${currentAtr.toFixed(2)}). Signal cancelled.`;
        logs.push(capMsg);
        console.warn(capMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: capMsg };
      }

      // -----------------------------------------------------------------------
      // Data-quality guard (safety rule, not a tuned parameter).
      //
      // On 16/11/2026 01:00 the weekly open produced 14 flat synthetic candles,
      // so ATR collapsed to 0.28 (median 3.73) and the bot emitted a signal
      // whose stop was 0.42 points — 1.69× the 0.25 spread — and whose target
      // was 0.56 points. 44% of the target distance was spread. The trade was
      // physically impossible to manage at the broker, so we now refuse it.
      //
      // The floors are safety limits, deliberately not backtest-optimised.
      // -----------------------------------------------------------------------
      const spreadPoints = process.env.ESTIMATED_SPREAD_POINTS
        ? parseFloat(process.env.ESTIMATED_SPREAD_POINTS)
        : spec.estimatedSpreadPoints;
      const minSignalAtr = Number.isFinite(parseFloat(process.env.MIN_SIGNAL_ATR || ''))
        ? parseFloat(process.env.MIN_SIGNAL_ATR as string)
        : 1.5;
      const minSlToSpreadMultiple = Number.isFinite(parseFloat(process.env.MIN_SL_TO_SPREAD_MULTIPLE || ''))
        ? parseFloat(process.env.MIN_SL_TO_SPREAD_MULTIPLE as string)
        : 3.0;
      const slDistancePoints = Math.abs(currentClose - sl);
      const isXauSymbol = symbol.includes('XAU') || symbol.includes('GOLD');

      if (isXauSymbol && currentAtr < minSignalAtr) {
        const guardMsg = `[${symbol}] 🚫 Data-quality guard: ATR ${currentAtr.toFixed(2)} is below the ${minSignalAtr} floor (flat/stale candles, usually the weekly open). Signal cancelled.`;
        logs.push(guardMsg);
        console.warn(guardMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: guardMsg };
      }
      if (spreadPoints > 0 && slDistancePoints < minSlToSpreadMultiple * spreadPoints) {
        const guardMsg = `[${symbol}] 🚫 Data-quality guard: stop distance ${slDistancePoints.toFixed(2)} is below ${minSlToSpreadMultiple}× the modelled spread (${(minSlToSpreadMultiple * spreadPoints).toFixed(2)}). Signal cancelled.`;
        logs.push(guardMsg);
        console.warn(guardMsg);
        return { symbol, signalTriggered: false, skipped: true, reason: guardMsg };
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
        atr: currentAtr,
        feedSource: fetchRes.feedSource,
        sourceCandleCloseTime
      };

      // Validate the setup before it is persisted or sent. The alert itself is
      // deterministic so a second generative request cannot delay the price.
      const isMondayToday = new Date().getUTCDay() === 1;
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
        ema200: currentEma200,
        atr: currentAtr,
        isMonday: isMondayToday
      });

      // 🤖 Groq AI Advisory Evaluation: تقييم استشاري فقط مع إرسال الصفقة دائماً (Non-blocking mode)
      logs.push(`🤖 [${symbol}] تقييم Groq AI الاستشاري للصفقة: ${groqValidation.score}/10 | السبب: ${groqValidation.reason}`);

      if (!isSessionAllowed(symbol) || Date.now() - latestClosedCandle.closeTime > MAX_ENTRY_SIGNAL_AGE_MS) {
        const msg = `[${symbol}] Market closed or candle became stale during validation. No signal sent.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const groqAnalysis = `إشارة ${signalType} على الذهب بناءً على شمعة 5 دقائق مكتملة.`;

      // 50% Breakeven Target level and 80% Major Profit Lock level for trader guidance
      const beTargetPrice = signalType === 'BUY'
        ? currentClose + 0.5 * (tp - currentClose)
        : currentClose - 0.5 * (currentClose - tp);

      const target80Price = signalType === 'BUY'
        ? currentClose + 0.8 * (tp - currentClose)
        : currentClose - 0.8 * (currentClose - tp);

      const entryTypeArabic = triggerReason === 'PULLBACK'
        ? '🎯 ارتداد وإعادة اختبار (EMA20 Pullback)'
        : '⚡ تقاطع زخم مع الاتجاه (RSI Crossover)';

      // Save to MongoDB with tradeType: 'SCALP'
      let persistedTrade: any = null;
      try {
        persistedTrade = new Trade({
          ...signalDetails,
          tradeType: 'SCALP',
          // The original 1.5×ATR stop. `sl` is mutated later by breakeven and
          // profit locks, so this field is what keeps the risk unit intact.
          initialSl: sl,
          triggerReason: triggerReason || 'CROSSOVER',
          groqScore: groqValidation.score,
          groqReason: groqValidation.reason,
          riskUSD: posSize.actualRiskUSD,
          potentialProfitUSD: Number((Math.abs(tp - currentClose) * spec.contractSize * posSize.lotSize).toFixed(2)),
          groqAnalysis,
          status: 'ALERT_SENT',
          timestamp: new Date()
        });
        await persistedTrade.save();

        // 📝 Save complete forensic details into the dedicated DetailedTradeLog collection
        try {
          const rrRatio = Number((Math.abs(tp - currentClose) / Math.abs(currentClose - sl)).toFixed(2));
          const trendAlign: 'ALIGNED_WITH_MACRO' | 'COUNTER_TREND' = currentEma200
            ? (signalType === 'BUY' ? (currentClose > currentEma200 ? 'ALIGNED_WITH_MACRO' : 'COUNTER_TREND') : (currentClose < currentEma200 ? 'ALIGNED_WITH_MACRO' : 'COUNTER_TREND'))
            : 'ALIGNED_WITH_MACRO';

          await DetailedTradeLog.create({
            tradeId: persistedTrade._id.toString(),
            symbol,
            action: signalType,
            tradeType: 'SCALP',
            status: 'ALERT_SENT',
            entryTimestamp: new Date(),
            entryCairoTime: formatCairoTime(new Date()),
            sourceCandleCloseTime,
            sourceCandleCloseCairo: formatCairoTime(sourceCandleCloseTime),
            entryPrice: currentClose,
            slPrice: sl,
            tpPrice: tp,
            breakevenTriggerPrice: beTargetPrice,
            // New trades are judged with first-touch-per-level semantics. Rows
            // written before this field existed have no exitModel and must be
            // read as the legacy close-based model.
            exitModel: 'touch',
            lotSize: posSize.lotSize,
            accountBalanceAtEntry: currentLiveBal,
            riskAmountUSD: posSize.actualRiskUSD,
            riskPercent: posSize.actualRiskPercent,
            potentialProfitUSD: Number((Math.abs(tp - currentClose) * spec.contractSize * posSize.lotSize).toFixed(2)),
            riskRewardRatio: rrRatio,
            triggerReason: triggerReason || 'CROSSOVER',
            candleOpen: latestClosedCandle.open,
            candleHigh: latestClosedCandle.high,
            candleLow: latestClosedCandle.low,
            candleClose: latestClosedCandle.close,
            rsi: currentRsi,
            prevRsi,
            ema20: currentEma20,
            ema100: currentEma100,
            ema200: currentEma200,
            atr: currentAtr,
            sessionName: getSessionName(new Date()),
            trendAlignment: trendAlign,
            groqScore: groqValidation.score,
            groqApproved: groqValidation.approved,
            groqReason: groqValidation.reason,
            groqAnalysis,
            feedSource: fetchRes.feedSource,
            telegramSent: false
          });
        } catch (detailSaveErr: any) {
          console.warn('DetailedTradeLog initial create warning:', detailSaveErr?.message || detailSaveErr);
        }
      } catch (saveErr: any) {
        logs.push(`Database log error for ${symbol}: ${saveErr?.message || saveErr}`);
        const duplicate = saveErr?.code === 11000;
        return { symbol, signalTriggered: false, skipped: duplicate, error: duplicate ? undefined : 'Could not persist signal; alert not sent.' };
      }

      // Format the Telegram Alert to be clear, prominent, and contain all strategy & AI details:
      const actionHeader = signalType === 'BUY' ? '🟢 توصية سكالبينج: شراء (BUY)' : '🔴 بيع (SELL)';
      const macroInfo = currentEma200 ? ` | EMA200 (الصورة الكبيرة): ${formatPrice(currentEma200)}` : '';
      const riskWarnText = posSize.hasRiskWarning ? `\n- ⚠️ **تنبيه إدارة المخاطر:** ${posSize.riskWarningMessage || 'المخاطرة الفعلية أعلى من 2% بسبب الحد الأدنى للوت 0.01'}` : '';

      const potentialProfitUSD = Number((Math.abs(tp - currentClose) * spec.contractSize * posSize.lotSize).toFixed(2));
      const halfProfitUSD = Number((potentialProfitUSD / 2).toFixed(2));

      const profit80USD = Number((potentialProfitUSD * 0.65).toFixed(2));

      const telegramMsg =
        `🚨 **${actionHeader}** 🚨\n\n` +
        `🪙 **الأصل:** ${symbol} (ذهب)\n` +
        `💵 **سعر الدخول:** **${formatPrice(currentClose)}**\n` +
        `🛑 **وقف الخسارة (SL):** **${formatPrice(sl)}**\n` +
        `🎯 **هدف الأرباح (TP):** **${formatPrice(tp)}**\n` +
        `🛡️ **تأمين الدخول (Breakeven عند 50%):** **${formatPrice(beTargetPrice)}**\n` +
        `🔒 **حجز أرباح متقدم (80% من الهدف):** **${formatPrice(target80Price)}**\n` +
        `📦 **حجم اللوت المقترح:** ${posSize.lotSize.toFixed(2)} لوت (المخاطرة: ${posSize.actualRiskUSD.toFixed(2)} دولار)\n\n` +
        `💰 **خطة حجز الأرباح وتأمين الصفقة (خطوة بخطوة):**\n` +
        `1️⃣ **المستوى الأول - عند الوصول لسعر ${formatPrice(beTargetPrice)} (تحقيق 50%):**\n` +
        `   🛡️ انقل وقف الخسارة (SL) فوراً لسعر الدخول (${formatPrice(currentClose)}) لتصبح المخاطرة 0$ تماماً!\n` +
        `   💵 احجز 50% من الأرباح (أغلق نصف العقد لتضمن ~${halfProfitUSD.toFixed(2)} دولار في رصيدك)، واترك باقي العقد يجري للهدف.\n` +
        `2️⃣ **المستوى الثاني - عند الوصول لسعر ${formatPrice(target80Price)} (تحقيق 80%):**\n` +
        `   🔒 تأمين أرباح كبير: البوت بيرفع الوقف تلقائياً ليحجز 65% من أرباح الهدف كاش مضمون (~${profit80USD.toFixed(2)} دولار) في حال ارتداد السعر مفاجئاً.\n` +
        `3️⃣ **المستوى الثالث - الهدف النهائي عند سعر ${formatPrice(tp)} (تحقيق 100%):**\n` +
        `   🏁 أغلق كامل العقد وجني كامل الأرباح المقدرة (~${potentialProfitUSD.toFixed(2)} دولار).\n\n` +
        `📊 **تفاصيل واستراتيجية الصفقة:**\n` +
        `- نوع الدخول: ${entryTypeArabic}\n` +
        `- 🤖 تقييم الذكاء الاصطناعي (Groq Score): **${groqValidation.score}/10** (${groqValidation.reason})\n` +
        `- وقت إغلاق الشمعة: ${formatCairoTime(sourceCandleCloseTime)} (Cairo time)\n` +
        `- صلاحية الإشارة حتى: ${formatCairoTime(sourceSignalExpiresAt)}؛ تجاهلها لو تأخرت\n` +
        `- مصدر السعر: ${fetchRes.feedSource}\n` +
        `- مؤشر ATR (14): ${formatPrice(signalDetails.atr)} نقطة\n` +
        `- مؤشر RSI (14): ${formatPrice(signalDetails.rsi)} | EMA20: ${formatPrice(signalDetails.ema20)} | EMA100: ${formatPrice(signalDetails.ema100)}${macroInfo}${riskWarnText}`;

      if (Date.now() - latestClosedCandle.closeTime > MAX_ENTRY_SIGNAL_AGE_MS) {
        persistedTrade.status = 'ARCHIVED';
        persistedTrade.closedAt = new Date();
        await persistedTrade.save();
        const msg = `[${symbol}] Signal exceeded its age limit before Telegram dispatch; archived without sending.`;
        logs.push(msg);
        return { symbol, signalTriggered: false, skipped: true, reason: msg };
      }

      const sent = await sendTelegramNotification(telegramMsg);
      if (!sent) {
        persistedTrade.status = 'ARCHIVED';
        persistedTrade.closedAt = new Date();
        await persistedTrade.save();
        try {
          await DetailedTradeLog.updateOne(
            { tradeId: persistedTrade._id.toString() },
            { $set: { telegramSent: false, status: 'LOSS', notes: 'Telegram dispatch failed; trade archived' } }
          );
        } catch {}
        logs.push(`[${symbol}] Telegram delivery failed; unsent signal was archived.`);
        return { symbol, signalTriggered: false, skipped: true, reason: 'Telegram delivery failed.' };
      }

      try {
        await DetailedTradeLog.updateOne(
          { tradeId: persistedTrade._id.toString() },
          { $set: { telegramSent: true, telegramText: telegramMsg, status: 'OPEN' } }
        );
      } catch {}

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
