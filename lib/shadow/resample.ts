/** Resample CLOSED 5-minute bars into higher timeframes, locally. */
import { Candle } from './types';

export function resample(candles: Candle[], minutes: number): Candle[] {
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    if (![c.openTime, c.closeTime, c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    const start = Math.floor(c.openTime / bucketMs) * bucketMs;
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, { openTime: start, closeTime: start + bucketMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume = (existing.volume || 0) + (c.volume || 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Only bars that have actually closed at `now`. */
export function closedBars(candles: Candle[], now: number): Candle[] {
  return candles
    .filter(c => Number.isFinite(c.closeTime) && c.closeTime <= now)
    .sort((a, b) => a.openTime - b.openTime);
}
