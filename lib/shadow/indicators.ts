/**
 * Local indicator calculations. No Twelve Data indicator endpoints are used,
 * and no look-ahead: every value at index i uses candles[0..i] only.
 */
import { Candle, IndicatorSet } from './types';

const NAN = Number.NaN;

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NAN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NAN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. Leading values are NaN. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NAN);
  if (values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder's ATR (true range, first TR = high-low). Leading values are NaN. */
export function atrWilder(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NAN);
  if (candles.length < period) return out;
  const tr: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder's ADX. Leading values are NaN (needs 2*period-1 bars). */
export function adxWilder(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NAN);
  if (candles.length < period * 2) return out;
  const plus: number[] = new Array(candles.length).fill(0);
  const minus: number[] = new Array(candles.length).fill(0);
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
    const prev = candles[i - 1].close;
    tr[i] = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev));
  }
  let sumTr = 0;
  let sumPlus = 0;
  let sumMinus = 0;
  for (let i = 1; i <= period; i++) {
    sumTr += tr[i]; sumPlus += plus[i]; sumMinus += minus[i];
  }
  let atr = sumTr;
  let smoothedPlus = sumPlus;
  let smoothedMinus = sumMinus;
  const dx: number[] = new Array(candles.length).fill(NAN);
  const setDx = (i: number) => {
    if (atr <= 0) { dx[i] = 0; return; }
    const pdi = 100 * smoothedPlus / atr;
    const mdi = 100 * smoothedMinus / atr;
    const denom = pdi + mdi;
    dx[i] = denom === 0 ? 0 : 100 * Math.abs(pdi - mdi) / denom;
  };
  setDx(period);
  for (let i = period + 1; i < candles.length; i++) {
    atr = atr - atr / period + tr[i];
    smoothedPlus = smoothedPlus - smoothedPlus / period + plus[i];
    smoothedMinus = smoothedMinus - smoothedMinus / period + minus[i];
    setDx(i);
  }
  let first = NAN;
  let count = 0;
  for (let i = period; i < candles.length; i++) {
    if (!Number.isFinite(dx[i])) continue;
    if (!Number.isFinite(first)) {
      first = dx[i];
      count = 1;
    } else {
      first = (first * (period - 1) + dx[i]) / period;
      count++;
    }
    if (count >= period) out[i] = first;
  }
  return out;
}

export interface BollingerResult {
  sma: number[];
  lower: number[];
  upper: number[];
}

/** Bollinger bands with population standard deviation. */
export function bollinger(values: number[], period = 20, multiplier = 2): BollingerResult {
  const mid = sma(values, period);
  const lower = new Array<number>(values.length).fill(NAN);
  const upper = new Array<number>(values.length).fill(NAN);
  for (let i = period - 1; i < values.length; i++) {
    if (!Number.isFinite(mid[i])) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / period);
    lower[i] = mid[i] - multiplier * sd;
    upper[i] = mid[i] + multiplier * sd;
  }
  return { sma: mid, lower, upper };
}

/** Highest high / lowest low of the PREVIOUS `period` bars (excludes index i). */
export function donchian(candles: Candle[], index: number, period: number): { high: number | null; low: number | null } {
  const start = index - period;
  if (start < 0) return { high: null, low: null };
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i < index; i++) {
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low) low = candles[i].low;
  }
  return { high, low };
}

export function lastFinite(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return null;
}

export function valueAt(values: number[], index: number): number | null {
  if (index < 0 || index >= values.length) return null;
  return Number.isFinite(values[index]) ? values[index] : null;
}

export function buildIndicatorSet(candles: Candle[]): IndicatorSet {
  if (candles.length === 0) {
    return { atr14: null, rsi14: null, rsi2: null, ema20: null, ema50: null, ema200: null, adx14: null, sma20: null, bbLower: null, bbUpper: null };
  }
  const closes = candles.map(c => c.close);
  const bb = bollinger(closes, 20, 2);
  return {
    atr14: lastFinite(atrWilder(candles, 14)),
    rsi14: lastFinite(rsi(closes, 14)),
    rsi2: lastFinite(rsi(closes, 2)),
    ema20: lastFinite(ema(closes, 20)),
    ema50: lastFinite(ema(closes, 50)),
    ema200: lastFinite(ema(closes, 200)),
    adx14: lastFinite(adxWilder(candles, 14)),
    sma20: lastFinite(bb.sma),
    bbLower: lastFinite(bb.lower),
    bbUpper: lastFinite(bb.upper)
  };
}

export function sessionBucketUtc(timeMs: number): string {
  const hour = new Date(timeMs).getUTCHours();
  if (hour >= 13 && hour < 16) return 'LONDON_NY_OVERLAP';
  if (hour >= 8 && hour < 16) return 'LONDON';
  if (hour >= 13 && hour < 21) return 'NEW_YORK';
  if (hour >= 0 && hour < 8) return 'ASIAN';
  return 'PACIFIC';
}
