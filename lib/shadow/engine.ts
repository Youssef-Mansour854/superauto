/** Per-strategy position engine: one fixed 0.01-lot open position, resumable from DB. */
import { EVALUATOR_VERSION, PARAMS_VERSION } from './config';
import { evaluateExit } from './evaluator';
import { buildIndicatorSet } from './indicators';
import { resample } from './resample';
import {
  bumpHealth, putOpenPosition, readOpenPosition, recordSignal, removeOpenPosition,
  todaySignals, writeTrade
} from './store';
import {
  Candle, EvaluatorResult, IntrabarResolver, OpenPosition, Signal, StrategyContext, StrategyDefinition, TradeRecord
} from './types';

export interface PrecomputedBars {
  bars15m?: Candle[];
  bars1h?: Candle[];
  bars4h?: Candle[];
  bars1d?: Candle[];
  indicators5m?: StrategyContext['indicators5m'];
  indicators15m?: StrategyContext['indicators15m'];
  indicators1h?: StrategyContext['indicators1h'];
}

export function buildContext(
  strategyId: string, bars: Candle[], now: number, signals: any[] = [], pre?: PrecomputedBars
): StrategyContext {
  const bars5m = bars.filter(c => c.closeTime <= now).sort((a, b) => a.openTime - b.openTime);
  const b15 = pre?.bars15m || resample(bars5m, 15);
  const b1h = pre?.bars1h || resample(bars5m, 60);
  return {
    strategyId,
    now,
    utcDate: new Date(now).toISOString().slice(0, 10),
    bars5m,
    bars15m: b15,
    bars1h: b1h,
    bars4h: pre?.bars4h || resample(bars5m, 240),
    bars1d: pre?.bars1d || resample(bars5m, 1440),
    indicators5m: pre?.indicators5m || buildIndicatorSet(bars5m),
    indicators15m: pre?.indicators15m || buildIndicatorSet(b15),
    indicators1h: pre?.indicators1h || buildIndicatorSet(b1h),
    todaySignals: signals,
    usedLevels: signals.map(s => (s?.meta || {}).level).filter(Boolean)
  };
}

export interface ProcessResult {
  signalCreated: boolean;
  exited: boolean;
  exit?: EvaluatorResult;
  signal?: Signal;
  positionAfter: OpenPosition | null;
}

export interface ProcessOverride {
  /** Caller owns the position (replay); skips per-bar position DB reads/writes. */
  position?: OpenPosition | null;
  skipPositionDb?: boolean;
}

/** Runs one closed bar for one strategy. Never throws to the caller on strategy errors. */
export async function processBar(
  strategy: StrategyDefinition,
  ctx: StrategyContext,
  source: 'live' | 'replay',
  resolver?: IntrabarResolver,
  split?: 'train' | 'test',
  override?: ProcessOverride
): Promise<ProcessResult> {
  const result: ProcessResult = { signalCreated: false, exited: false, positionAfter: null };
  const date = ctx.utcDate;
  const last = ctx.bars5m[ctx.bars5m.length - 1] || ctx.bars15m[ctx.bars15m.length - 1];
  if (!last) return result;

  let position = override && override.position !== undefined
    ? override.position
    : await readOpenPosition(strategy.id, source);
  result.positionAfter = position;
  if (position) {
    const signal = position.signal as Signal;
    const exit = await evaluateExit({
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      stop: signal.stop,
      target: signal.target,
      entryBarCloseTime: signal.signalBarCloseTime,
      maxHoldMinutes: signal.maxHoldMinutes,
      paramsVersion: signal.paramsVersion,
      stopPlan: signal.stopPlan,
      entryHigh: signal.meta?.entryHigh ?? signal.entryPrice,
      entryLow: signal.meta?.entryLow ?? signal.entryPrice,
      tradeId: position.tradeId,
      strategyId: strategy.id,
      source,
      split
    }, ctx.bars5m, resolver);

    if (exit) {
      const trade: TradeRecord = {
        trade_id: position.tradeId,
        strategy_id: strategy.id,
        params_version: signal.paramsVersion,
        evaluator_version: EVALUATOR_VERSION,
        signal_time_utc: new Date(signal.signalTime),
        entry_time_utc: new Date(signal.signalBarCloseTime),
        exit_time_utc: new Date(exit.exitTime),
        direction: signal.direction,
        entry_price: signal.entryPrice,
        stop: signal.stop,
        target: signal.target,
        risk_usd_per_001lot: exit.riskUnits,
        atr14: signal.atr14,
        rsi14: signal.rsi14,
        session_bucket_utc: signal.sessionBucketUtc,
        exit_type: exit.exitType,
        exit_price: exit.exitPrice,
        ambiguous: exit.ambiguous,
        resolved_by: exit.resolvedBy,
        gross_units: exit.grossUnits,
        cost_units: exit.costUnits,
        net_units: exit.netUnits,
        R: exit.R,
        mfe_units: exit.mfeUnits,
        mae_units: exit.maeUnits,
        duration_minutes: exit.durationMinutes,
        source,
        split
      };
      await writeTrade(strategy.id, trade);
      if (!override?.skipPositionDb) await removeOpenPosition(position.tradeId);
      if (source === 'live') await bumpHealth(strategy.id, date, { exits: 1, ambiguous: exit.ambiguous ? 1 : 0 });
      result.exited = true;
      result.exit = exit;
      result.positionAfter = null;
      position = null;
    }
  }

  if (!position) {
    const signal = strategy.onClosedBar(ctx);
    if (signal) {
      const tradeId = `${strategy.id}:${source}:${signal.signalTime}`;
      const existing = override?.skipPositionDb ? position : await readOpenPosition(strategy.id, source);
      if (!existing) {
        const pos: OpenPosition = {
          tradeId, strategyId: strategy.id, source,
          paramsVersion: PARAMS_VERSION, evaluatorVersion: EVALUATOR_VERSION,
          signal, openedAt: signal.signalBarCloseTime, split
        };
        if (!override?.skipPositionDb) {
          await putOpenPosition(pos);
          await recordSignal(strategy.id, source, date, signal.signalTime, signal);
        }
        if (source === 'live') await bumpHealth(strategy.id, date, { signals: 1 });
        result.signalCreated = true;
        result.signal = signal;
        result.positionAfter = pos;
      }
    }
  }
  return result;
}
