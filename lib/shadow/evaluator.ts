/**
 * ONE evaluator for every strategy and for parity checks.
 * No per-strategy policy switches: only the data supplied in `input` differs
 * (stop/target from the signal, and an optional trailing-stop definition).
 */
import { EVALUATOR_VERSION, COST_UNITS } from './config';
import { closedBars } from './resample';
import {
  Candle, EvaluatorInput, EvaluatorResult, ExitType, IntrabarResolver
} from './types';

export { EVALUATOR_VERSION };

function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Replays an exit from the bar AFTER the signal bar.
 * `resolver` is called at most once, only for a bar that touched both levels.
 */
export async function evaluateExit(
  input: EvaluatorInput,
  candles: Candle[],
  resolver?: IntrabarResolver
): Promise<EvaluatorResult | null> {
  const isBuy = input.direction === 'BUY';
  const entry = input.entryPrice;
  const bars = closedBars(candles, Number.POSITIVE_INFINITY)
    .filter(c => c.closeTime > input.entryBarCloseTime)
    .sort((a, b) => a.openTime - b.openTime);
  if (bars.length === 0) return null;

  let stop = input.stop;
  let highest = Number.isFinite(input.entryHigh) ? (input.entryHigh as number) : -Infinity;
  let lowest = Number.isFinite(input.entryLow) ? (input.entryLow as number) : Infinity;
  let exitType: ExitType | null = null;
  let exitPrice = 0;
  let exitTime = 0;
  let ambiguous = false;
  let resolvedBy: EvaluatorResult['resolvedBy'] = 'none';

  const fillStop = (bar: Candle): number => {
    const open = Number.isFinite(bar.open) ? bar.open : null;
    if (open === null) return stop;
    // Gap through the stop fills at the open (worse than the resting stop).
    return isBuy ? Math.min(stop, open) : Math.max(stop, open);
  };
  const fillTarget = (): number => {
    // A resting limit order fills at its limit, even when the bar gapped past it.
    return input.target as number;
  };
  const settle = (type: ExitType, price: number, bar: Candle) => {
    exitType = type;
    exitPrice = round(price);
    exitTime = bar.closeTime;
  };

  for (const bar of bars) {
    if (bar.high > highest) highest = bar.high;
    if (bar.low < lowest) lowest = bar.low;

    const stopHit = isBuy ? bar.low <= stop : bar.high >= stop;
    const targetHit = input.target !== null && (isBuy ? bar.high >= input.target : bar.low <= input.target);

    if (stopHit && targetHit) {
      ambiguous = true;
      let first: 'stop' | 'target' | null = null;
      if (resolver) {
        try {
          first = await resolver(bar, {
            stop,
            target: input.target as number,
            direction: input.direction
          });
        } catch {
          first = null;
        }
      }
      resolvedBy = first === 'target' ? '1m' : (first === 'stop' ? '1m' : 'assumed_stop');
      if (first === 'target') settle('TARGET', fillTarget(), bar);
      else settle('STOP', fillStop(bar), bar);
      break;
    }
    if (stopHit) {
      settle('STOP', fillStop(bar), bar);
      break;
    }
    if (targetHit) {
      settle('TARGET', fillTarget(), bar);
      break;
    }

    // Stop management is computed from the CLOSED bar and is active from the next bar.
    const plan = input.stopPlan;
    if (plan && plan.kind === 'chandelier' && Number.isFinite(plan.atr)) {
      const reference = isBuy ? highest : lowest;
      const candidate = isBuy
        ? reference - plan.multiplier * plan.atr
        : reference + plan.multiplier * plan.atr;
      if (isBuy ? candidate > stop : candidate < stop) stop = round(candidate);
    }

    if (bar.closeTime - input.entryBarCloseTime >= input.maxHoldMinutes * 60 * 1000) {
      settle('TIMEOUT', bar.close, bar);
      break;
    }
  }

  if (exitType === null) return null;

  const gross = (exitPrice - entry) * (isBuy ? 1 : -1);
  const risk = Math.max(0.000001, Math.abs(entry - input.stop));
  const net = gross - COST_UNITS;
  const mfe = isBuy ? highest - entry : entry - lowest;
  const mae = isBuy ? entry - lowest : highest - entry;

  return {
    exitType,
    exitPrice,
    exitTime,
    grossUnits: round(gross),
    costUnits: COST_UNITS,
    netUnits: round(net),
    riskUnits: round(risk),
    R: round(net / risk),
    mfeUnits: round(Math.max(0, mfe)),
    maeUnits: round(Math.max(0, mae)),
    durationMinutes: round((exitTime - input.entryBarCloseTime) / 60000, 3),
    ambiguous,
    resolvedBy,
    evaluatorVersion: EVALUATOR_VERSION,
    paramsVersion: input.paramsVersion,
    barsEvaluated: bars.length
  };
}
