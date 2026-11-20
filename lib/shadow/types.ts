export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Direction = 'BUY' | 'SELL';

export type StopPlan =
  | { /** Fixed stop from the signal. */ kind: 'fixed' }
  | {
      /** Chandelier-style trailing stop: recompute after a bar closes, apply from the NEXT bar. */
      kind: 'chandelier';
      atr: number;
      multiplier: number;
      period: number;
    };

export interface Signal {
  strategyId: string;
  paramsVersion: number;
  evaluatorVersion: string;
  direction: Direction;
  signalTime: number;
  signalBarCloseTime: number;
  entryPrice: number;
  stop: number;
  target: number | null;
  atr14: number;
  rsi14: number | null;
  adx14: number | null;
  sessionBucketUtc: string;
  maxHoldMinutes: number;
  stopPlan: StopPlan;
  meta?: Record<string, any>;
}

export interface OpenPosition {
  tradeId: string;
  strategyId: string;
  source: 'live' | 'replay';
  paramsVersion: number;
  evaluatorVersion: string;
  signal: Signal;
  openedAt: number;
  split?: 'train' | 'test';
}

export interface StrategyContext {
  strategyId: string;
  now: number;
  utcDate: string;
  bars5m: Candle[];
  bars15m: Candle[];
  bars1h: Candle[];
  bars4h: Candle[];
  bars1d: Candle[];
  indicators5m: IndicatorSet;
  indicators15m: IndicatorSet;
  indicators1h: IndicatorSet;
  todaySignals: Signal[];
  usedLevels: string[];
}

export interface IndicatorSet {
  atr14: number | null;
  rsi14: number | null;
  rsi2: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  adx14: number | null;
  sma20: number | null;
  bbLower: number | null;
  bbUpper: number | null;
}

export interface EvaluatorInput {
  direction: Direction;
  entryPrice: number;
  stop: number;
  target: number | null;
  entryBarCloseTime: number;
  maxHoldMinutes: number;
  paramsVersion: number;
  stopPlan?: StopPlan;
  /** High/low of the signal bar, used only by trailing stops ("since entry"). */
  entryHigh?: number;
  entryLow?: number;
  tradeId?: string;
  strategyId?: string;
  source?: 'live' | 'replay';
  split?: 'train' | 'test';
}

export type ExitType = 'TARGET' | 'STOP' | 'TIMEOUT';

export interface EvaluatorResult {
  exitType: ExitType;
  exitPrice: number;
  exitTime: number;
  grossUnits: number;
  costUnits: number;
  netUnits: number;
  riskUnits: number;
  R: number;
  mfeUnits: number;
  maeUnits: number;
  durationMinutes: number;
  ambiguous: boolean;
  resolvedBy: '1m' | 'assumed_stop' | 'none';
  evaluatorVersion: string;
  paramsVersion: number;
  barsEvaluated: number;
}

/** Optional 1-minute resolver. Returning null means "no data / still ambiguous". */
export type IntrabarResolver = (
  bar: Candle,
  levels: { stop: number; target: number; direction: Direction }
) => Promise<'stop' | 'target' | null> | 'stop' | 'target' | null;

export interface TradeRecord {
  trade_id: string;
  strategy_id: string;
  params_version: number;
  evaluator_version: string;
  signal_time_utc: Date;
  entry_time_utc: Date;
  exit_time_utc: Date;
  direction: Direction;
  entry_price: number;
  stop: number;
  target: number | null;
  risk_usd_per_001lot: number;
  atr14: number;
  rsi14: number | null;
  session_bucket_utc: string;
  exit_type: ExitType;
  exit_price: number;
  ambiguous: boolean;
  resolved_by: string;
  gross_units: number;
  cost_units: number;
  net_units: number;
  R: number;
  mfe_units: number;
  mae_units: number;
  duration_minutes: number;
  source: 'live' | 'replay';
  split?: 'train' | 'test';
}

export interface StrategyDefinition {
  id: string;
  paramsVersion: number;
  params: Record<string, number | string | boolean>;
  onClosedBar(ctx: StrategyContext): Signal | null;
}
