import { envBool, envNumber } from './env';

/** Bump ONLY when the exit rules change. Past trades are never edited. */
export const EVALUATOR_VERSION = 'shadow-exit-v1';

/** All parameter sets are frozen at version 1; changes require a new version and window. */
export const PARAMS_VERSION = 1;

export const STRATEGY_IDS = [
  'orb_london',
  'bb_meanrev_15m',
  'donchian_trend_15m',
  'rsi2_pullback_h1_trend',
  'pdh_pdl_sweep_reclaim',
  'c0_random'
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export const IS_CONTROL: Record<string, boolean> = { c0_random: true };

/** Per-strategy kill switch. Default ON in code but the global feature flag is OFF. */
const KILL_ENV: Record<string, string> = {
  orb_london: 'SHADOW_KILL_ORB_LONDON',
  bb_meanrev_15m: 'SHADOW_KILL_BB_MEANREV_15M',
  donchian_trend_15m: 'SHADOW_KILL_DONCHIAN_TREND_15M',
  rsi2_pullback_h1_trend: 'SHADOW_KILL_RSI2_PULLBACK_H1_TREND',
  pdh_pdl_sweep_reclaim: 'SHADOW_KILL_PDH_PDL_SWEEP_RECLAIM',
  c0_random: 'SHADOW_KILL_C0_RANDOM'
};

export function isStrategyEnabled(id: string): boolean {
  if (!STRATEGY_IDS.includes(id as StrategyId)) return false;
  const envName = KILL_ENV[id];
  return envName ? !envBool(envName, false) : true;
}

/** Global gate. Nothing (not even a database call) happens when this is false. */
export function isShadowEnabled(): boolean {
  return envBool('SHADOW_ENABLED', false);
}

export const DAILY_HARD_CAP_CREDITS = 750;
export const DEGRADED_THRESHOLD_CREDITS = 600;
/** Measured main-bot baseline on 20/11 was 569 credits/key/day; round up and reserve it. */
export const MAIN_RESERVE_CREDITS = envNumber('SHADOW_MAIN_RESERVE_CREDITS', 600);
export const REQUESTS_PER_MINUTE = 8;
export const QUOTA_REFRESH_MS = 30 * 60 * 1000;
export const COST_UNITS = 0.30;
export const FIXED_LOT = 0.01;
export const CAIRO_UTC_OFFSET_HOURS = 2;
