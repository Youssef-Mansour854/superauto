/**
 * Guards every Twelve Data call made by the shadow subsystem.
 * The main bot's calls are NOT routed through here: we reserve credits for it
 * by reading the provider's own usage counters and choosing the least-used key.
 */
import axios from 'axios';
import {
  DAILY_HARD_CAP_CREDITS, DEGRADED_THRESHOLD_CREDITS, MAIN_RESERVE_CREDITS,
  QUOTA_REFRESH_MS, REQUESTS_PER_MINUTE
} from './config';
import { ApiUsageLog, QuotaSnapshot, logApiUsage } from './store';

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  key?: string;
  keyLabel?: string;
  keyIndex?: number;
  degraded: boolean;
  shadowCreditsToday: number;
}

export function utcDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function getShadowApiKeys(): string[] {
  const raw = process.env.TWELVEDATA_API_KEY || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

/** Mirrors the main bot's gold session rule, expressed in UTC via New York time. */
export function isGoldMarketOpen(date: Date): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const minute = Number(values.hour) * 60 + Number(values.minute);
    if (!Number.isFinite(minute)) return false;
    if (values.weekday === 'Sun') return minute >= 18 * 60;
    if (['Mon', 'Tue', 'Wed', 'Thu'].includes(values.weekday)) return minute < 17 * 60 || minute >= 18 * 60;
    if (values.weekday === 'Fri') return minute < 17 * 60;
    return false;
  } catch {
    return false;
  }
}

export class ApiBudgetGuard {
  private lastRefresh = 0;

  async shadowCreditsToday(date = utcDateKey()): Promise<number> {
    const rows = await ApiUsageLog.find({ date }).select('credits').lean().catch(() => []) as any[];
    return rows.reduce((sum, r) => sum + Number(r.credits || 0), 0);
  }

  async isDegraded(date = utcDateKey()): Promise<boolean> {
    const [used, shadow] = await Promise.all([this.primaryUsage(date), this.shadowCreditsToday(date)]);
    return used > DEGRADED_THRESHOLD_CREDITS || shadow > DEGRADED_THRESHOLD_CREDITS;
  }

  private async primaryUsage(date: string): Promise<number> {
    const rows = await QuotaSnapshot.find({ date }).lean().catch(() => []) as any[];
    return rows.length ? Math.max(...rows.map(r => Number(r.dailyUsage || 0))) : 0;
  }

  /** Refresh provider counters at most once per 30 minutes. Costs 1 credit per key. */
  private async refreshQuota(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < QUOTA_REFRESH_MS) return;
    const date = utcDateKey();
    const latest = await QuotaSnapshot.find({ date }).select('fetchedAt').sort({ fetchedAt: -1 }).limit(1).lean().catch(() => []) as any[];
    if (latest.length && now - new Date(latest[0].fetchedAt).getTime() < QUOTA_REFRESH_MS) {
      this.lastRefresh = now;
      return;
    }
    this.lastRefresh = now;
    const keys = getShadowApiKeys();
    for (let i = 0; i < keys.length; i++) {
      try {
        const response = await axios.get('https://api.twelvedata.com/api_usage', {
          params: { apikey: keys[i] }, timeout: 10000, validateStatus: () => true
        });
        const d: any = response.data;
        if (!d || !Number.isFinite(Number(d.daily_usage))) continue;
        await QuotaSnapshot.updateOne(
          { keyIndex: i, date },
          { $set: { keyIndex: i, date, dailyUsage: Number(d.daily_usage), planDailyLimit: Number(d.plan_daily_limit || 800), fetchedAt: new Date() } },
          { upsert: true }
        );
        await logApiUsage(date, 'api_usage', 1, 'shadow:quota', `key${i + 1}`);
      } catch {
        // A failed counter refresh is not fatal: use the last cached snapshot.
      }
    }
  }

  private async recentCalls(keyLabel: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 1000);
    return ApiUsageLog.countDocuments({ keyLabel, at: { $gte: since } }).catch(() => 0) as Promise<number>;
  }

  async acquire(caller: string, endpoint = 'time_series', credits = 1, allowClosedMarket = false): Promise<BudgetDecision> {
    const date = utcDateKey();
    const shadow = await this.shadowCreditsToday(date);
    const base = { degraded: false, shadowCreditsToday: shadow };
    if (shadow + credits > DAILY_HARD_CAP_CREDITS) {
      return { ...base, allowed: false, reason: `hard cap ${DAILY_HARD_CAP_CREDITS}/day reached` };
    }
    // Historical backfill is the documented exception: it cannot affect live trading.
    if (!allowClosedMarket && !isGoldMarketOpen(new Date())) {
      return { ...base, allowed: false, reason: 'market closed' };
    }
    await this.refreshQuota();
    const degraded = await this.isDegraded(date);
    const keys = getShadowApiKeys();
    if (keys.length === 0) {
      return { ...base, degraded, allowed: false, reason: 'no API key configured' };
    }
    const snapshots = await QuotaSnapshot.find({ date }).lean().catch(() => []) as any[];
    const candidates: Array<{ index: number; headroom: number }> = [];
    for (let i = 0; i < keys.length; i++) {
      const snap = snapshots.find(s => Number(s.keyIndex) === i);
      const limit = snap ? Number(snap.planDailyLimit) : 800;
      const used = snap ? Number(snap.dailyUsage) : 0;
      const label = `key${i + 1}`;
      const recent = await this.recentCalls(label);
      if (recent + credits > REQUESTS_PER_MINUTE) continue;
      candidates.push({ index: i, headroom: limit - used - MAIN_RESERVE_CREDITS - credits });
    }
    candidates.sort((a, b) => b.headroom - a.headroom);
    if (candidates.length === 0 || candidates[0].headroom < 0) {
      return { ...base, degraded: true, allowed: false, reason: 'reserved main-bot credits or rate limit exhausted' };
    }
    return {
      allowed: true,
      reason: degraded ? 'degraded mode' : 'ok',
      key: keys[candidates[0].index],
      keyIndex: candidates[0].index,
      keyLabel: `key${candidates[0].index + 1}`,
      degraded,
      shadowCreditsToday: shadow
    };
  }

  async record(endpoint: string, keyLabel: string, caller: string, credits = 1): Promise<void> {
    await logApiUsage(utcDateKey(), endpoint, credits, caller, keyLabel);
  }
}
