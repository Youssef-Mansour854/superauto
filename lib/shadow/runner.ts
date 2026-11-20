/** One shadow cycle: fetch closed bars, store them, run every strategy in isolation. */
import axios from 'axios';
import { connectToDatabase } from '../mongodb';
import { ApiBudgetGuard } from './budget';
import { EVALUATOR_VERSION, isShadowEnabled, isStrategyEnabled } from './config';
import { processBar, buildContext } from './engine';
import {
  bumpHealth, ensureRun, loadCandles, OneMinuteCache, ShadowState, todaySignals,
  upsertCandles
} from './store';
import { STRATEGIES } from './strategies';
import { Candle, IntrabarResolver } from './types';
import { utcDateKey } from './budget';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

function parseTimeSeries(data: any): Candle[] {
  const values = data?.values;
  if (!Array.isArray(values)) return [];
  const out: Candle[] = [];
  for (const v of values) {
    const openTime = Date.parse(`${v.datetime}Z`);
    if (!Number.isFinite(openTime)) continue;
    out.push({
      openTime,
      closeTime: openTime + FIVE_MIN,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
      volume: Number(v.volume || 0)
    });
  }
  return out.reverse();
}

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export interface CycleReport {
  skipped?: boolean;
  reason?: string;
  fetched: number;
  newBars: number;
  signals: number;
  exits: number;
  errors: string[];
  degraded: boolean;
  evaluatorVersion: string;
}

/** Fetch the latest 5-minute bars. One credit per call, budgeted first. */
export async function fetchLatestCandles(guard: ApiBudgetGuard, now = Date.now()): Promise<Candle[]> {
  const decision = await guard.acquire('shadow:fetch', 'time_series', 1);
  if (!decision.allowed || !decision.key) return [];
  try {
    const response = await axios.get('https://api.twelvedata.com/time_series', {
      params: {
        symbol: 'XAU/USD', interval: '5min', outputsize: 120,
        timezone: 'UTC', apikey: decision.key,
        end_date: sqlTime(Math.floor(now / FIVE_MIN) * FIVE_MIN - FIVE_MIN)
      },
      timeout: 12000,
      validateStatus: () => true
    });
    const candles = parseTimeSeries(response.data);
    await guard.record('time_series', decision.keyLabel || 'unknown', 'shadow:fetch', 1);
    if (candles.length === 0) return [];
    await upsertCandles(candles);
    return candles;
  } catch (e: any) {
    await guard.record('time_series', decision.keyLabel || 'unknown', 'shadow:fetch:error', 0);
    return [];
  }
}

/** Resolves an ambiguous candle with cached 1-minute bars when the budget allows. */
export function makeResolver(guard: ApiBudgetGuard): IntrabarResolver {
  return async (bar, levels) => {
    const barKey = `${bar.openTime}`;
    const cached = await OneMinuteCache.findOne({ barKey }).lean().catch(() => null) as any;
    let minutes: Candle[] = cached ? (cached.candles as Candle[]) : [];
    if (!cached) {
      const decision = await guard.acquire('shadow:1m', 'time_series', 1);
      if (!decision.allowed || decision.degraded || !decision.key) return null;
      try {
        const response = await axios.get('https://api.twelvedata.com/time_series', {
          params: {
            symbol: 'XAU/USD', interval: '1min', outputsize: 6, timezone: 'UTC',
            start_date: sqlTime(bar.openTime), end_date: sqlTime(bar.closeTime - 60000),
            apikey: decision.key
          },
          timeout: 12000, validateStatus: () => true
        });
        const rows = response.data?.values;
        if (!Array.isArray(rows)) return null;
        minutes = rows.map((v: any) => {
          const t = Date.parse(`${v.datetime}Z`);
          return { openTime: t, closeTime: t + 60000, open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close) };
        }).filter((c: Candle) => Number.isFinite(c.openTime) && c.openTime >= bar.openTime && c.openTime < bar.closeTime)
          .sort((a, b) => a.openTime - b.openTime);
        await OneMinuteCache.updateOne({ barKey }, { $set: { barKey, candles: minutes, resolvedAt: new Date() } }, { upsert: true });
        await guard.record('time_series', decision.keyLabel || 'unknown', 'shadow:1m', 1);
      } catch {
        return null;
      }
    }
    if (minutes.length === 0) return null;
    const isBuy = levels.direction === 'BUY';
    for (const m of minutes) {
      const stopHit = isBuy ? m.low <= levels.stop : m.high >= levels.stop;
      const targetHit = isBuy ? m.high >= levels.target : m.low <= levels.target;
      if (stopHit && targetHit) return null; // still ambiguous → stop wins
      if (stopHit) return 'stop';
      if (targetHit) return 'target';
    }
    return null;
  };
}

export async function runShadowCycle(now = Date.now()): Promise<CycleReport> {
  if (!isShadowEnabled()) {
    return { skipped: true, reason: 'SHADOW_ENABLED is false', fetched: 0, newBars: 0, signals: 0, exits: 0, errors: [], degraded: false, evaluatorVersion: EVALUATOR_VERSION };
  }
  await connectToDatabase();
  const guard = new ApiBudgetGuard();
  const fetched = await fetchLatestCandles(guard, now);
  const degraded = await guard.isDegraded(utcDateKey(new Date(now)));
  const all = await loadCandles(now - 14 * DAY_MS, now, 20000);
  const state = await ShadowState.findOne({ key: 'lastBar:live' }).lean().catch(() => null) as any;
  const lastProcessed = Number(state?.lastBarCloseTime || 0);
  const newBars = all.filter(c => c.closeTime > lastProcessed && c.closeTime <= now);
  const report: CycleReport = { fetched: fetched.length, newBars: newBars.length, signals: 0, exits: 0, errors: [], degraded, evaluatorVersion: EVALUATOR_VERSION };
  const resolver = makeResolver(guard);

  for (const bar of newBars) {
    const date = new Date(bar.closeTime).toISOString().slice(0, 10);
    for (const strategy of STRATEGIES) {
      if (!isStrategyEnabled(strategy.id)) continue;
      try {
        await ensureRun(strategy.id, strategy.paramsVersion, JSON.stringify(strategy.params), EVALUATOR_VERSION, 'live');
        const signalsAll = await todaySignals(strategy.id, 'live', date);
        const signals = signalsAll.filter((s: any) => (s?.signalTime || 0) <= bar.openTime);
        const ctx = buildContext(strategy.id, all.filter(c => c.closeTime <= bar.closeTime), bar.closeTime, signals);
        const result = await processBar(strategy, ctx, 'live', resolver);
        if (result.signalCreated) report.signals++;
        if (result.exited) report.exits++;
      } catch (e: any) {
        const message = `${strategy.id}: ${e?.message || e}`;
        report.errors.push(message);
        await bumpHealth(strategy.id, date, { errorCount: 1 }).catch(() => undefined);
      }
    }
  }

  if (newBars.length > 0) {
    const maxClose = Math.max(...newBars.map(c => c.closeTime));
    await ShadowState.updateOne(
      { key: 'lastBar:live' },
      { $set: { key: 'lastBar:live', lastBarCloseTime: maxClose, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  return report;
}

/** One-off 30-day backfill, paced by the budget guard. Safe to re-run (upsert only). */
export async function backfillDays(days = 30): Promise<{ loaded: number; daysDone: number; stopped: string | null }> {
  await connectToDatabase();
  const guard = new ApiBudgetGuard();
  const now = Date.now();
  let loaded = 0;
  let daysDone = 0;
  for (let d = days; d >= 1; d--) {
    const decision = await guard.acquire('shadow:backfill', 'time_series', 1, true);
    if (!decision.allowed || decision.degraded || !decision.key) {
      return { loaded, daysDone, stopped: decision.reason };
    }
    const end = now - (d - 1) * DAY_MS;
    const start = end - DAY_MS;
    try {
      const response = await axios.get('https://api.twelvedata.com/time_series', {
        params: {
          symbol: 'XAU/USD', interval: '5min', outputsize: 288, timezone: 'UTC',
          start_date: sqlTime(start), end_date: sqlTime(end), apikey: decision.key
        },
        timeout: 20000, validateStatus: () => true
      });
      const candles = parseTimeSeries(response.data);
      await guard.record('time_series', decision.keyLabel || 'unknown', 'shadow:backfill', 1);
      if (candles.length > 0) {
        await upsertCandles(candles);
        loaded += candles.length;
      }
      daysDone++;
      // Stay below the 8 requests/minute provider limit without relying on 429s.
      // 10s leaves room for the 1-credit api_usage counter calls in the same minute.
      if (d > 1) await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (e: any) {
      return { loaded, daysDone, stopped: e?.message || 'backfill request failed' };
    }
  }
  return { loaded, daysDone, stopped: null };
}
