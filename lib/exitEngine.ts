/**
 * Exit engine — first-touch-per-level replay of a scalp trade.
 *
 * The live route used to decide exits from the *aggregate* high/low of every
 * candle since the entry, and it only fired the protective stop on a 5m close.
 * That is not how a resting stop order works at a broker, and it made the
 * journal disagree with the account: a trade could wick through its stop and
 * still be recorded as a winner because the target was touched by a later bar.
 *
 * This module walks the candles in order, one level at a time:
 *   - the take profit is a resting limit order → fills on touch,
 *   - the protective stop is a resting stop order → fills on touch,
 *   - the catastrophic stop is a resting stop order → fills on touch,
 *   - when a candle touches both the target and a stop we cannot know the
 *     intrabar order, so we fill the stop first and flag `ambiguousSameCandle`.
 *
 * Management levels (breakeven at 50%, Tier 2 and Tier 3 profit locks) are the
 * same rules the live engine already uses, with one correction: a stop raised
 * from a candle's extreme only becomes active on the *next* candle. The old code
 * re-checked the raised stop against the same candle that created it, which
 * guaranteed a fill at a price that had already printed — and was often better
 * than the price at which the trader could actually have moved the order.
 *
 * Nothing here reads the database or the clock. Same input → same output, which
 * is what makes it testable against real candle history.
 */

export interface ExitCandle {
  openTime: number;
  closeTime: number;
  open?: number;
  high: number;
  low: number;
  close: number;
}

export interface ExitTierSpec {
  /** Progress toward the target, as a fraction (0.65 = 65%). */
  progress: number;
  /** Alternative trigger: floating points. */
  pointsTrigger: number;
  /** Share of the target distance locked in. */
  lockFraction: number;
  /** Floor for the locked distance, in points. */
  minLockPoints: number;
}

export interface ExitPolicy {
  /** Fraction of the target distance that moves the stop to breakeven. null = never. */
  breakevenAtProgress: number | null;
  /** Buffer added beyond the entry when the stop moves to breakeven. */
  breakevenBufferPoints: number;
  /** Profit locks, evaluated after breakeven is active. */
  tiers: ExitTierSpec[];
  /** Maximum holding time before the trade is settled or pushed to breakeven. */
  timeStopMinutes: number;
}

/** The rules that are actually deployed. Gold uses a 0.50 buffer above entry. */
export const LIVE_EXIT_POLICY: ExitPolicy = {
  breakevenAtProgress: 0.5,
  breakevenBufferPoints: 0.5,
  tiers: [
    { progress: 0.8, pointsTrigger: 5.0, lockFraction: 0.65, minLockPoints: 0 },
    { progress: 0.65, pointsTrigger: 3.5, lockFraction: 0.4, minLockPoints: 2.5 }
  ],
  timeStopMinutes: 120
};

/** No management at all: raw target against the original stop. */
export const RAW_EXIT_POLICY: ExitPolicy = {
  breakevenAtProgress: null,
  breakevenBufferPoints: 0,
  tiers: [],
  timeStopMinutes: 120
};

export interface ExitEngineInput {
  action: 'BUY' | 'SELL';
  entryPrice: number;
  tpPrice: number;
  /** Protective stop at entry (entry ∓ 1.5×ATR). */
  initialSl: number;
  atr: number;
  /** Multiplier for the catastrophic stop (3.0 for gold, 2.5 for QQQ/IXIC). */
  hardStopMultiplier?: number;
  entryTimestamp: number;
  policy?: Partial<ExitPolicy>;
}

export type ExitStatus = 'WIN' | 'LOSS' | 'BREAKEVEN';
export type ExitKind =
  | 'TAKE_PROFIT'
  | 'SOFT_STOP'
  | 'HARD_STOP'
  | 'BREAKEVEN'
  | 'TIMEOUT';

export type ExitEventKind =
  | 'BREAKEVEN_SET'
  | 'PROFIT_LOCK'
  | 'TAKE_PROFIT'
  | 'STOP_FILL'
  | 'HARD_STOP_FILL'
  | 'TIMEOUT';

export interface ExitEvent {
  kind: ExitEventKind;
  /** Candle whose price action produced this event. */
  candleOpenTime: number;
  candleCloseTime: number;
  /** Fill price for exits, new stop for management events. */
  price: number;
  fromStop?: number;
  toStop?: number;
  /** First candle from which a raised stop is active (management events). */
  activeFromCandle?: number;
}

export interface ExitEngineResult {
  /** null means the trade is still open after the last available candle. */
  status: ExitStatus | null;
  exitReason: ExitKind | null;
  exitPrice: number | null;
  /** True when the exit candle touched both the target and a stop. */
  ambiguousSameCandle: boolean;
  /** Stop that was in force when the trade ended (or the current stop if open). */
  stopAtExit: number;
  breakevenApplied: boolean;
  events: ExitEvent[];
  highestHighDuringTrade: number;
  lowestLowDuringTrade: number;
  maxFavorablePoints: number;
  maxDrawdownPoints: number;
  /** Candles actually walked (entry candle included). */
  candlesEvaluated: number;
  /** True when the first walked candle started before the entry timestamp. */
  entryCandlePartial: boolean;
  /** Close time of the candle that produced the exit. */
  exitCandleCloseTime: number | null;
  /** Candle open time of the exit, for diagnostics. */
  exitCandleOpenTime: number | null;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function resolvePolicy(override?: Partial<ExitPolicy>): ExitPolicy {
  if (!override) return LIVE_EXIT_POLICY;
  return {
    breakevenAtProgress: override.breakevenAtProgress !== undefined
      ? override.breakevenAtProgress
      : LIVE_EXIT_POLICY.breakevenAtProgress,
    breakevenBufferPoints: override.breakevenBufferPoints ?? LIVE_EXIT_POLICY.breakevenBufferPoints,
    tiers: override.tiers ?? LIVE_EXIT_POLICY.tiers,
    timeStopMinutes: override.timeStopMinutes ?? LIVE_EXIT_POLICY.timeStopMinutes
  };
}

/**
 * Replays the trade against `candles`. The candles are sorted here; the caller
 * may pass them in any order. Only candles whose close is after the entry are
 * used, and the candle that contains the entry is included on purpose: the
 * position is live the moment the alert is sent, so its wicks are real.
 */
export function runExitEngine(
  input: ExitEngineInput,
  candles: ExitCandle[]
): ExitEngineResult {
  const policy = resolvePolicy(input.policy);
  const isBuy = input.action === 'BUY';
  const entry = input.entryPrice;
  const tp = input.tpPrice;
  const tpDistance = Math.abs(tp - entry);
  const atr = input.atr > 0 ? input.atr : tpDistance / 2;
  const hardMultiplier = input.hardStopMultiplier ?? 3.0;

  const bars = candles
    .filter(c => Number.isFinite(c.openTime) && Number.isFinite(c.closeTime)
      && Number.isFinite(c.high) && Number.isFinite(c.low)
      && c.closeTime > input.entryTimestamp)
    .sort((a, b) => a.openTime - b.openTime);

  let stop = Number.isFinite(input.initialSl) && input.initialSl > 0
    ? input.initialSl
    : (isBuy ? entry - atr * 1.5 : entry + atr * 1.5);
  const hardStop = isBuy ? entry - atr * hardMultiplier : entry + atr * hardMultiplier;

  let breakevenApplied = false;
  let highest = -Infinity;
  let lowest = Infinity;
  const events: ExitEvent[] = [];

  let status: ExitStatus | null = null;
  let exitReason: ExitKind | null = null;
  let exitPrice: number | null = null;
  let ambiguousSameCandle = false;
  let exitCandleCloseTime: number | null = null;
  let exitCandleOpenTime: number | null = null;
  let barsWalked = 0;

  const settle = (
    nextStatus: ExitStatus,
    nextReason: ExitKind,
    price: number,
    bar: ExitCandle,
    ambiguous: boolean
  ) => {
    status = nextStatus;
    exitReason = nextReason;
    exitPrice = price;
    ambiguousSameCandle = ambiguous;
    exitCandleCloseTime = bar.closeTime;
    exitCandleOpenTime = bar.openTime;
    events.push({
      kind: nextReason === 'TAKE_PROFIT' ? 'TAKE_PROFIT'
        : nextReason === 'HARD_STOP' ? 'HARD_STOP_FILL'
        : nextReason === 'TIMEOUT' ? 'TIMEOUT'
        : nextReason === 'BREAKEVEN' ? 'STOP_FILL'
        : 'STOP_FILL',
      candleOpenTime: bar.openTime,
      candleCloseTime: bar.closeTime,
      price
    });
  };

  for (const bar of bars) {
    barsWalked++;
    const high = bar.high;
    const low = bar.low;
    // A candle that started before the entry cannot have gapped through a level
    // that only existed after the entry, so only trust its open on later bars.
    const gapOpen = bar.openTime >= input.entryTimestamp && Number.isFinite(bar.open)
      ? (bar.open as number)
      : undefined;

    if (high > highest) highest = high;
    if (low < lowest) lowest = low;

    // 1. Does this candle touch the target and/or the stop?
    const tpHit = isBuy ? high >= tp : low <= tp;
    const stopHit = isBuy ? low <= stop : high >= stop;
    // The catastrophic stop only matters while the trade still runs on its
    // original stop; once breakeven or a profit lock is active, that stop is
    // tighter and always between the entry and the hard level.
    const hardHit = !breakevenApplied && (isBuy ? low <= hardStop : high >= hardStop);

    if (stopHit || hardHit) {
      // Fill at the level, unless the candle opened on the wrong side of it
      // (a gap), in which case the order fills at the open.
      let fill: number;
      let kind: ExitKind;
      if (hardHit && !stopHit) {
        fill = gapOpen === undefined
          ? hardStop
          : (isBuy ? Math.min(hardStop, gapOpen) : Math.max(hardStop, gapOpen));
        kind = 'HARD_STOP';
      } else {
        fill = gapOpen === undefined
          ? stop
          : (isBuy ? Math.min(stop, gapOpen) : Math.max(stop, gapOpen));
        kind = breakevenApplied ? 'BREAKEVEN' : 'SOFT_STOP';
      }
      // A stop order fills on touch; if the target was also touched inside the
      // same candle, the intrabar order is unknowable. Be pessimistic.
      settle(breakevenApplied ? 'BREAKEVEN' : 'LOSS', kind, fill, bar, tpHit);
      // The stop that was in force when the trade was filled.
      events[events.length - 1].fromStop = kind === 'HARD_STOP' ? hardStop : stop;
      break;
    }

    if (tpHit) {
      const fill = gapOpen === undefined ? tp : (isBuy ? Math.max(tp, gapOpen) : Math.min(tp, gapOpen));
      settle('WIN', 'TAKE_PROFIT', fill, bar, false);
      break;
    }

    // 2. Management levels computed from this candle's extreme, active only
    //    from the next candle (the fix for the same-candle fill).
    const floating = isBuy ? highest - entry : entry - lowest;
    const progress = tpDistance > 0 ? floating / tpDistance : 0;
    const activeFrom = bar.closeTime;

    if (!breakevenApplied
      && policy.breakevenAtProgress !== null
      && floating >= tpDistance * policy.breakevenAtProgress) {
      const next = round2(isBuy
        ? entry + policy.breakevenBufferPoints
        : entry - policy.breakevenBufferPoints);
      if (isBuy ? next > stop : next < stop) {
        events.push({
          kind: 'BREAKEVEN_SET',
          candleOpenTime: bar.openTime,
          candleCloseTime: bar.closeTime,
          price: next,
          fromStop: stop,
          toStop: next,
          activeFromCandle: activeFrom
        });
        stop = next;
      }
      breakevenApplied = true;
    }

    if (breakevenApplied && policy.tiers.length > 0) {
      let lockedPoints = 0;
      for (const tier of policy.tiers) {
        if (progress >= tier.progress || floating >= tier.pointsTrigger) {
          const target = Math.max(tier.minLockPoints, round2(tpDistance * tier.lockFraction));
          if (target > lockedPoints) lockedPoints = target;
        }
      }
      if (lockedPoints > 0) {
        const next = round2(isBuy ? entry + lockedPoints : entry - lockedPoints);
        if (isBuy ? next > stop : next < stop) {
          events.push({
            kind: 'PROFIT_LOCK',
            candleOpenTime: bar.openTime,
            candleCloseTime: bar.closeTime,
            price: next,
            fromStop: stop,
            toStop: next,
            activeFromCandle: activeFrom
          });
          stop = next;
        }
      }
    }

    // 3. Smart time stop: after the maximum holding time the trade is either
    //    pushed to breakeven (if in profit) or closed at the reference close.
    if (policy.timeStopMinutes > 0
      && bar.closeTime - input.entryTimestamp >= policy.timeStopMinutes * 60000) {
      const inProfit = isBuy ? bar.close > entry : bar.close < entry;
      if (inProfit) {
        const next = round2(isBuy
          ? entry + policy.breakevenBufferPoints
          : entry - policy.breakevenBufferPoints);
        if (!breakevenApplied || (isBuy ? next > stop : next < stop)) {
          events.push({
            kind: 'BREAKEVEN_SET',
            candleOpenTime: bar.openTime,
            candleCloseTime: bar.closeTime,
            price: next,
            fromStop: stop,
            toStop: next,
            activeFromCandle: bar.closeTime
          });
          stop = next;
        }
        breakevenApplied = true;
      } else {
        settle('LOSS', 'TIMEOUT', bar.close, bar, false);
        break;
      }
    }
  }

  const maxFavorablePoints = highest === -Infinity
    ? 0
    : round2(isBuy ? highest - entry : entry - lowest);
  const maxDrawdownPoints = lowest === Infinity
    ? 0
    : round2(isBuy ? entry - lowest : highest - entry);

  return {
    status,
    exitReason,
    exitPrice,
    ambiguousSameCandle,
    stopAtExit: round2(stop),
    breakevenApplied,
    events,
    highestHighDuringTrade: highest === -Infinity ? entry : highest,
    lowestLowDuringTrade: lowest === Infinity ? entry : lowest,
    maxFavorablePoints: Math.max(0, maxFavorablePoints),
    maxDrawdownPoints: Math.max(0, maxDrawdownPoints),
    candlesEvaluated: barsWalked,
    entryCandlePartial: bars.length > 0 && bars[0].openTime < input.entryTimestamp,
    exitCandleCloseTime,
    exitCandleOpenTime
  };
}
