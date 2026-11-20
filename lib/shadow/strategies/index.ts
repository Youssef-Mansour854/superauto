/**
 * Fixed strategies. Every `onClosedBar` is a pure function of closed bars and
 * the supplied context. No DB, no network, no Math.random, no look-ahead.
 */
import { PARAMS_VERSION, EVALUATOR_VERSION } from '../config';
import { donchian } from '../indicators';
import { sessionBucketUtc } from '../indicators';
import { Candle, Direction, Signal, StrategyContext, StrategyDefinition } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

function dayStart(utcDate: string): number {
  return Date.parse(`${utcDate}T00:00:00Z`);
}

function hash32(seed: number, text: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function baseSignal(ctx: StrategyContext, direction: Direction, last: Candle,
  stop: number, target: number | null, atr: number, rsi: number | null, adx: number | null,
  maxHoldMinutes: number, meta?: Record<string, any>, stopPlan?: Signal['stopPlan']): Signal {
  return {
    strategyId: ctx.strategyId,
    paramsVersion: PARAMS_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    direction,
    signalTime: last.openTime,
    signalBarCloseTime: last.closeTime,
    entryPrice: last.close,
    stop,
    target,
    atr14: atr,
    rsi14: rsi,
    adx14: adx,
    sessionBucketUtc: sessionBucketUtc(last.closeTime),
    maxHoldMinutes,
    stopPlan: stopPlan || { kind: 'fixed' },
    meta: { ...(meta || {}), entryHigh: last.high, entryLow: last.low }
  };
}

function countToday(ctx: StrategyContext, id: string): number {
  return ctx.todaySignals.filter(s => s.strategyId === id).length;
}

// ---------------------------------------------------------------------------
// S1 — London opening range breakout
// ---------------------------------------------------------------------------
const orbLondon: StrategyDefinition = {
  id: 'orb_london',
  paramsVersion: PARAMS_VERSION,
  params: { asianStartUtc: 0, asianEndUtc: 7, windowStartUtc: 7, windowEndUtc: 12, breakoutAtr: 0.1, minRangeAtr: 2, maxRangeAtr: 12, targetR: 1.5, timeStopUtc: 16, maxPerDay: 1 },
  onClosedBar(ctx) {
    const atr = ctx.indicators5m.atr14;
    if (!atr || atr <= 0) return null;
    const start = dayStart(ctx.utcDate);
    const hour = new Date(ctx.now).getUTCHours();
    if (hour < 7 || hour >= 12) return null;
    if (countToday(ctx, 'orb_london') >= 1) return null;
    const asian = ctx.bars5m.filter(c => c.openTime >= start && c.openTime < start + 7 * HOUR_MS);
    if (asian.length < 12) return null;
    const high = Math.max(...asian.map(c => c.high));
    const low = Math.min(...asian.map(c => c.low));
    const range = high - low;
    if (range < 2 * atr || range > 12 * atr) return null;
    const last = ctx.bars5m[ctx.bars5m.length - 1];
    if (!last) return null;
    const threshold = 0.1 * atr;
    if (last.close > high + threshold) {
      const risk = last.close - low;
      return baseSignal(ctx, 'BUY', last, low, last.close + 1.5 * risk, atr, ctx.indicators5m.rsi14, null,
        (start + 16 * HOUR_MS - last.closeTime) / 60000, { rangeHigh: high, rangeLow: low });
    }
    if (last.close < low - threshold) {
      const risk = high - last.close;
      return baseSignal(ctx, 'SELL', last, high, last.close - 1.5 * risk, atr, ctx.indicators5m.rsi14, null,
        (start + 16 * HOUR_MS - last.closeTime) / 60000, { rangeHigh: high, rangeLow: low });
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// S2 — Bollinger mean reversion on 15m, only in low-ADX regimes
// ---------------------------------------------------------------------------
const bbMeanRev: StrategyDefinition = {
  id: 'bb_meanrev_15m',
  paramsVersion: PARAMS_VERSION,
  params: { bbPeriod: 20, bbStd: 2, adxMax: 20, rsiMax: 30, rsiMin: 70, stopAtr: 1.5, minTargetRisk: 0.8, maxHoldBars: 24, maxPerDay: 3 },
  onClosedBar(ctx) {
    if (countToday(ctx, 'bb_meanrev_15m') >= 3) return null;
    const { adx14, atr14, bbLower, bbUpper, sma20, rsi14 } = ctx.indicators15m;
    const last = ctx.bars15m[ctx.bars15m.length - 1];
    if (!last || adx14 === null || adx14 >= 20 || !atr14 || !bbLower || !bbUpper || !sma20 || rsi14 === null) return null;
    const risk = 1.5 * atr14;
    if (last.close < bbLower && rsi14 < 30) {
      if (sma20 - last.close < 0.8 * risk) return null;
      return baseSignal(ctx, 'BUY', last, last.close - risk, sma20, atr14, rsi14, adx14, 24 * 15, { band: 'lower' });
    }
    if (last.close > bbUpper && rsi14 > 70) {
      if (last.close - sma20 < 0.8 * risk) return null;
      return baseSignal(ctx, 'SELL', last, last.close + risk, sma20, atr14, rsi14, adx14, 24 * 15, { band: 'upper' });
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// S3 — Donchian breakout with chandelier trailing stop, no target
// ---------------------------------------------------------------------------
const donchianTrend: StrategyDefinition = {
  id: 'donchian_trend_15m',
  paramsVersion: PARAMS_VERSION,
  params: { channel: 55, adxMin: 20, initialStopAtr: 2, trailAtr: 3, maxHoldBars: 96, maxPerDay: 2 },
  onClosedBar(ctx) {
    if (countToday(ctx, 'donchian_trend_15m') >= 2) return null;
    const { adx14, atr14, rsi14 } = ctx.indicators15m;
    const bars = ctx.bars15m;
    const last = bars[bars.length - 1];
    if (!last || adx14 === null || adx14 <= 20 || !atr14) return null;
    const channel = donchian(bars, bars.length - 1, 55);
    if (channel.high === null || channel.low === null) return null;
    const stopPlan: Signal['stopPlan'] = { kind: 'chandelier', atr: atr14, multiplier: 3, period: 55 };
    if (last.close > channel.high) {
      return baseSignal(ctx, 'BUY', last, last.close - 2 * atr14, null, atr14, rsi14, adx14, 96 * 15,
        { channelHigh: channel.high }, stopPlan);
    }
    if (last.close < channel.low) {
      return baseSignal(ctx, 'SELL', last, last.close + 2 * atr14, null, atr14, rsi14, adx14, 96 * 15,
        { channelLow: channel.low }, stopPlan);
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// S4 — H1 trend filter, RSI(2) pullback on 15m
// ---------------------------------------------------------------------------
const rsi2Pullback: StrategyDefinition = {
  id: 'rsi2_pullback_h1_trend',
  paramsVersion: PARAMS_VERSION,
  params: { emaFast: 50, emaSlow: 200, rsiPeriod: 2, rsiOversold: 10, rsiOverbought: 90, stopAtr: 1.5, targetAtr: 1.5, maxHoldBars: 16, maxPerDay: 3 },
  onClosedBar(ctx) {
    if (countToday(ctx, 'rsi2_pullback_h1_trend') >= 3) return null;
    const h1 = ctx.bars1h[ctx.bars1h.length - 1];
    const { ema50, ema200 } = ctx.indicators1h;
    const { atr14, rsi2, rsi14, adx14 } = ctx.indicators15m;
    const last = ctx.bars15m[ctx.bars15m.length - 1];
    if (!h1 || !last || ema50 === null || ema200 === null || !atr14 || rsi2 === null) return null;
    const upTrend = ema50 > ema200 && h1.close > ema50;
    const downTrend = ema50 < ema200 && h1.close < ema50;
    const risk = 1.5 * atr14;
    if (upTrend && rsi2 < 10) {
      return baseSignal(ctx, 'BUY', last, last.close - risk, last.close + risk, atr14, rsi14, adx14, 16 * 15, { h1Trend: 'UP' });
    }
    if (downTrend && rsi2 > 90) {
      return baseSignal(ctx, 'SELL', last, last.close + risk, last.close - risk, atr14, rsi14, adx14, 16 * 15, { h1Trend: 'DOWN' });
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// S5 — Previous-day high/low sweep and reclaim
// ---------------------------------------------------------------------------
const pdhPdlSweep: StrategyDefinition = {
  id: 'pdh_pdl_sweep_reclaim',
  paramsVersion: PARAMS_VERSION,
  params: { windowStartUtc: 7, windowEndUtc: 20, breakoutAtr: 0.1, targetR: 1.5, maxHoldBars: 48, maxPerDay: 2 },
  onClosedBar(ctx) {
    const hour = new Date(ctx.now).getUTCHours();
    if (hour < 7 || hour >= 20) return null;
    if (countToday(ctx, 'pdh_pdl_sweep_reclaim') >= 2) return null;
    const atr = ctx.indicators5m.atr14;
    const last = ctx.bars5m[ctx.bars5m.length - 1];
    if (!last || !atr || atr <= 0) return null;
    const start = dayStart(ctx.utcDate);
    const previous = ctx.bars5m.filter(c => c.openTime >= start - DAY_MS && c.openTime < start);
    if (previous.length < 12) return null;
    const pdh = Math.max(...previous.map(c => c.high));
    const pdl = Math.min(...previous.map(c => c.low));
    const used = ctx.todaySignals.filter(s => s.strategyId === 'pdh_pdl_sweep_reclaim').map(s => s.meta?.level);
    const buffer = 0.1 * atr;
    if (last.high > pdh + buffer && last.close < pdh && !used.includes('PDH')) {
      const stop = last.high + buffer;
      return baseSignal(ctx, 'SELL', last, stop, last.close - 1.5 * (stop - last.close), atr,
        ctx.indicators5m.rsi14, null, 48 * 5, { level: 'PDH', pdh, pdl });
    }
    if (last.low < pdl - buffer && last.close > pdl && !used.includes('PDL')) {
      const stop = last.low - buffer;
      return baseSignal(ctx, 'BUY', last, stop, last.close + 1.5 * (last.close - stop), atr,
        ctx.indicators5m.rsi14, null, 48 * 5, { level: 'PDL', pdh, pdl });
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// C0 — seeded random control (not counted as a strategy)
// ---------------------------------------------------------------------------
const c0Random: StrategyDefinition = {
  id: 'c0_random',
  paramsVersion: PARAMS_VERSION,
  params: { seed: 55778177, perDaySample: 10, stopAtr: 1.5, targetAtr: 2, maxHoldMinutes: 240 },
  onClosedBar(ctx) {
    const last = ctx.bars5m[ctx.bars5m.length - 1];
    const atr = ctx.indicators5m.atr14;
    if (!last || !atr || atr <= 0) return null;
    // 5m bars/day ≈ 288; mod 29 gives ≈ 10 entries/day, deterministically.
    const h = hash32(55778177, `${ctx.utcDate}:${last.openTime}`);
    if (h % 29 !== 0) return null;
    const direction: Direction = ((h >>> 8) & 1) === 0 ? 'BUY' : 'SELL';
    const risk = 1.5 * atr;
    return baseSignal(ctx, direction, last,
      direction === 'BUY' ? last.close - risk : last.close + risk,
      direction === 'BUY' ? last.close + 2 * atr : last.close - 2 * atr,
      atr, ctx.indicators5m.rsi14, null, 240, { control: true });
  }
};

export const STRATEGIES: StrategyDefinition[] = [
  orbLondon, bbMeanRev, donchianTrend, rsi2Pullback, pdhPdlSweep, c0Random
];

export function getStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGIES.find(s => s.id === id);
}
