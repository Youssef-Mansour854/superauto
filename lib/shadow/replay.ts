/** Deterministic replay on stored 5-minute history. Never merged with live rows. */
import { connectToDatabase } from '../mongodb';
import { adxWilder, atrWilder, bollinger, ema, rsi } from './indicators';
import { resample } from './resample';
import { buildContext, processBar } from './engine';
import { loadCandles, putOpenPosition, ShadowPosition, ShadowSignal, tradeModel } from './store';
import { getStrategy } from './strategies';
import { Candle, IndicatorSet, OpenPosition, Signal } from './types';
import { makeResolver } from './runner';
import { ApiBudgetGuard } from './budget';

export interface ReplayReport {
  strategyId: string;
  from: string;
  to: string;
  bars: number;
  splitTime: number;
  signals: number;
  exits: number;
  errors: string[];
  openAtEnd: number;
}

interface Series {
  atr: number[]; rsi14: number[]; rsi2: number[]; ema20: number[];
  ema50: number[]; ema200: number[]; adx: number[]; bb: ReturnType<typeof bollinger>;
}

function series(bars: Candle[]): Series {
  const closes = bars.map(b => b.close);
  return {
    atr: atrWilder(bars, 14), rsi14: rsi(closes, 14), rsi2: rsi(closes, 2),
    ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
    adx: adxWilder(bars, 14), bb: bollinger(closes, 20, 2)
  };
}

function finiteAt(arr: number[], index: number): number | null {
  for (let i = Math.min(index, arr.length - 1); i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function setAt(s: Series, index: number): IndicatorSet {
  return {
    atr14: finiteAt(s.atr, index),
    rsi14: finiteAt(s.rsi14, index),
    rsi2: finiteAt(s.rsi2, index),
    ema20: finiteAt(s.ema20, index),
    ema50: finiteAt(s.ema50, index),
    ema200: finiteAt(s.ema200, index),
    adx14: finiteAt(s.adx, index),
    sma20: finiteAt(s.bb.sma, index),
    bbLower: finiteAt(s.bb.lower, index),
    bbUpper: finiteAt(s.bb.upper, index)
  };
}

/** Index of the last resampled bar closed at or before `time`. */
function indexAt(bars: Candle[], times: number[]): number[] {
  const out: number[] = [];
  let pointer = -1;
  for (const t of times) {
    while (pointer + 1 < bars.length && bars[pointer + 1].closeTime <= t) pointer++;
    out.push(pointer);
  }
  return out;
}

export async function replayStrategy(
  strategyId: string, fromIso: string, toIso: string
): Promise<ReplayReport> {
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error(`Unknown strategy: ${strategyId}`);
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T23:59:59Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Invalid replay window');

  await connectToDatabase();
  // Extra history is used ONLY as indicator warm-up; no trade is opened before `from`.
  const warmup = from - 14 * 24 * 60 * 60 * 1000;
  const all = await loadCandles(warmup, to, 50000);
  const offset = all.filter(c => c.openTime < from).length;
  const candles = all.slice(offset);
  if (candles.length < 300) {
    throw new Error(`Only ${candles.length} stored 5m bars in the window; run a backfill first.`);
  }
  const model = tradeModel(strategyId);

  // Replay owns only its own source-tagged rows; live rows are untouched.
  await model.deleteMany({ source: 'replay' });
  await ShadowPosition.deleteMany({ strategy_id: strategyId, source: 'replay' });
  await ShadowSignal.deleteMany({ strategy_id: strategyId, source: 'replay' });

  const splitIndex = Math.floor(candles.length * 0.7);
  const splitTime = candles[Math.min(splitIndex, candles.length - 1)].closeTime;
  const guard = new ApiBudgetGuard();
  const resolver = makeResolver(guard);
  // Indicators (especially H1 EMA200) need history BEFORE `from`. Build them
  // from `all`, then read each processed bar at its absolute index i + offset.
  const times = all.map(c => c.closeTime);
  const b15 = resample(all, 15);
  const b1h = resample(all, 60);
  const b4h = resample(all, 240);
  const b1d = resample(all, 1440);
  const idx15 = indexAt(b15, times);
  const idx1h = indexAt(b1h, times);
  const idx4h = indexAt(b4h, times);
  const idx1d = indexAt(b1d, times);
  const s5 = series(all);
  const s15 = series(b15);
  const s1h = series(b1h);

  const byDate = new Map<string, Signal[]>();
  const report: ReplayReport = {
    strategyId, from: fromIso, to: toIso, bars: candles.length, splitTime,
    signals: 0, exits: 0, errors: [], openAtEnd: 0
  };
  let position: OpenPosition | null = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const absolute = i + offset;
    const split: 'train' | 'test' = i < splitIndex ? 'train' : 'test';
    const date = new Date(bar.closeTime).toISOString().slice(0, 10);
    const today = (byDate.get(date) || []).filter(s => s.signalTime <= bar.openTime);
    const ctx = buildContext(strategyId, all.slice(0, absolute + 1), bar.closeTime, today, {
      bars15m: b15.slice(0, idx15[absolute] + 1),
      bars1h: b1h.slice(0, idx1h[absolute] + 1),
      bars4h: b4h.slice(0, idx4h[absolute] + 1),
      bars1d: b1d.slice(0, idx1d[absolute] + 1),
      indicators5m: setAt(s5, absolute),
      indicators15m: setAt(s15, idx15[absolute]),
      indicators1h: setAt(s1h, idx1h[absolute])
    });
    try {
      const result = await processBar(strategy, ctx, 'replay', resolver, split,
        { position, skipPositionDb: true });
      position = result.positionAfter;
      if (result.signalCreated && result.signal) {
        report.signals++;
        byDate.set(date, [...(byDate.get(date) || []), result.signal]);
      }
      if (result.exited) report.exits++;
    } catch (e: any) {
      report.errors.push(`${strategyId} @ ${new Date(bar.closeTime).toISOString()}: ${e?.message || e}`);
    }
  }

  if (position) await putOpenPosition(position);
  report.openAtEnd = position ? 1 : 0;
  return report;
}
