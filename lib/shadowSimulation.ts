import { calculateDetailedPnL } from '../config/accountConfig';

/**
 * Shadow (counterfactual) evaluation of trade management.
 *
 * For every closed trade we replay the same entry with several exit rule-sets
 * against the real candle path. This turns each trade into several learning
 * points instead of one, and lets us compare rule-sets without touching the
 * live strategy.
 *
 * Nothing in this module is used for trading decisions. It only explains what
 * would have happened. The live rules remain in app/api/scalp/route.ts.
 */

export interface ShadowBar {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
}

export type ShadowExitKind =
  | 'TAKE_PROFIT'
  | 'SOFT_STOP'
  | 'HARD_STOP'
  | 'BREAKEVEN'
  | 'TIMEOUT'
  | 'STILL_OPEN';

export interface ShadowTier {
  /** Progress toward the target, as a fraction (0.65 = 65%). */
  progress: number;
  /** Share of the target distance locked in, as a fraction. */
  lockFraction: number;
  /** Alternative trigger: floating points. */
  pointsTrigger: number;
}

export interface ShadowVariantSpec {
  name: string;
  /** Fraction of the target distance that moves the stop to breakeven. null = never. */
  beAtProgress: number | null;
  tiers: ShadowTier[];
  /**
   * Because the live engine raises the stop and checks it again on the *same*
   * candle (which necessarily already traded through the new level), a lock
   * raised from a candle's extreme is filled on that very candle. Variants with
   * this flag reproduce that behaviour; the others raise the stop and only let
   * price action from the next candle trigger it.
   */
  sameBarStopCheck?: boolean;
}

/** Matches the live strategy's floor for the Tier 2 lock. */
const MIN_LOCK_POINTS = 2.5;
/** Matches the live strategy's breakeven buffer for gold. */
const BREAKEVEN_BUFFER_POINTS = 0.5;
/** Matches the live strategy's smart time stop. */
const TIME_STOP_MINUTES = 120;
/** How long after the exit we keep watching for the original target. */
const DEFAULT_POST_EXIT_HORIZON_MINUTES = 180;

export const SHADOW_VARIANTS: ShadowVariantSpec[] = [
  {
    // Faithful reproduction of the deployed rules, including the same-candle
    // stop check. Used to validate the replay against the recorded outcomes.
    name: 'CURRENT',
    beAtProgress: 0.5,
    tiers: [
      { progress: 0.80, lockFraction: 0.65, pointsTrigger: 5.0 },
      { progress: 0.65, lockFraction: 0.40, pointsTrigger: 3.5 }
    ],
    sameBarStopCheck: true
  },
  {
    // The deployed rules with the stop only reacting to price after the candle
    // that raised it. Measures what the same-candle fill costs.
    name: 'CURRENT_CLEAN',
    beAtProgress: 0.5,
    tiers: [
      { progress: 0.80, lockFraction: 0.65, pointsTrigger: 5.0 },
      { progress: 0.65, lockFraction: 0.40, pointsTrigger: 3.5 }
    ]
  },
  {
    name: 'TIER3_ONLY',
    beAtProgress: 0.5,
    tiers: [{ progress: 0.80, lockFraction: 0.65, pointsTrigger: 5.0 }]
  },
  {
    name: 'BE_ONLY',
    beAtProgress: 0.5,
    tiers: []
  },
  {
    name: 'LOOSE_TIER2',
    beAtProgress: 0.5,
    tiers: [
      { progress: 0.75, lockFraction: 0.30, pointsTrigger: 4.5 },
      { progress: 0.80, lockFraction: 0.65, pointsTrigger: 5.0 }
    ]
  },
  {
    name: 'RAW_TP_SL',
    beAtProgress: null,
    tiers: []
  }
];

export interface ShadowTradeInput {
  action: 'BUY' | 'SELL';
  symbol: string;
  entryPrice: number;
  tpPrice: number;
  atr: number;
  lotSize: number;
  entryTimestamp: number;
  hardStopMultiplier?: number;
  postExitHorizonMinutes?: number;
}

export interface ShadowVariantResult {
  name: string;
  exitKind: ShadowExitKind;
  exitPrice?: number;
  points?: number;
  netPnLUSD?: number;
  minutesHeld?: number;
  resolved: boolean;
}

export interface ShadowPostExit {
  tpHit: boolean;
  minutesToTp?: number;
  maxFavorablePoints: number;
  maxAdversePoints: number;
  horizonMinutes: number;
  finalized: boolean;
  checkedAt: Date;
}

export interface ShadowEvaluation {
  variants: ShadowVariantResult[];
  postExit: ShadowPostExit;
  finalized: boolean;
  evaluatedAt: Date;
  /** False when the candle window starts after the entry, so the replay is invalid. */
  dataCoversEntry: boolean;
}

function netFor(input: ShadowTradeInput, points: number): number {
  return calculateDetailedPnL(points, input.lotSize, input.symbol).netPnLUSD;
}

function runVariant(spec: ShadowVariantSpec, input: ShadowTradeInput, bars: ShadowBar[]): ShadowVariantResult {
  const isBuy = input.action === 'BUY';
  const entry = input.entryPrice;
  const tp = input.tpPrice;
  const tpDistance = Math.abs(tp - entry);
  const atr = input.atr > 0 ? input.atr : tpDistance / 1.5;
  const hardMultiplier = input.hardStopMultiplier ?? 3.0;

  let sl = isBuy ? entry - atr * 1.5 : entry + atr * 1.5;
  let breakevenApplied = false;
  let highest = -Infinity;
  let lowest = Infinity;

  const finish = (exitKind: ShadowExitKind, exitPrice: number, bar: ShadowBar): ShadowVariantResult => {
    const points = Number((isBuy ? exitPrice - entry : entry - exitPrice).toFixed(4));
    return {
      name: spec.name,
      exitKind,
      exitPrice: Number(exitPrice.toFixed(2)),
      points,
      netPnLUSD: netFor(input, points),
      minutesHeld: Math.max(0, Math.round((bar.closeTime - input.entryTimestamp) / 60000)),
      resolved: true
    };
  };

  for (const bar of bars) {
    highest = Math.max(highest, bar.high);
    lowest = Math.min(lowest, bar.low);

    // 1. Take profit: the wick of any completed candle since entry.
    if (isBuy ? highest >= tp : lowest <= tp) {
      return finish('TAKE_PROFIT', tp, bar);
    }

    // 2. Stop orders. Before breakeven the protective stop only fires on a
    //    candle close, with a catastrophic wick stop further away.
    if (breakevenApplied) {
      const stopHit = isBuy
        ? bar.low <= sl || bar.close <= sl
        : bar.high >= sl || bar.close >= sl;
      if (stopHit) return finish('BREAKEVEN', sl, bar);
    } else {
      const hardStop = isBuy ? entry - atr * hardMultiplier : entry + atr * hardMultiplier;
      const hardHit = isBuy ? bar.low <= hardStop : bar.high >= hardStop;
      if (hardHit) return finish('HARD_STOP', hardStop, bar);
      const softHit = isBuy ? bar.close <= sl : bar.close >= sl;
      if (softHit) return finish('SOFT_STOP', sl, bar);
    }

    // 3. Management, applied after the candle closes.
    const floating = isBuy ? highest - entry : entry - lowest;
    const slBeforeManagement = sl;

    if (!breakevenApplied && spec.beAtProgress !== null && floating >= tpDistance * spec.beAtProgress) {
      const next = isBuy ? entry + BREAKEVEN_BUFFER_POINTS : entry - BREAKEVEN_BUFFER_POINTS;
      if (isBuy ? next > sl : next < sl) sl = next;
      breakevenApplied = true;
    }

    if (breakevenApplied && spec.tiers.length > 0) {
      let lockedPoints = 0;
      for (const tier of spec.tiers) {
        if (floating >= tpDistance * tier.progress || floating >= tier.pointsTrigger) {
          lockedPoints = Math.max(lockedPoints, Math.max(MIN_LOCK_POINTS, tpDistance * tier.lockFraction));
        }
      }
      if (lockedPoints > 0) {
        const next = isBuy ? entry + lockedPoints : entry - lockedPoints;
        if (isBuy ? next > sl : next < sl) sl = next;
      }
    }

    // 3b. The live engine re-checks the stop on the same candle that raised it,
    //     so a stop raised from this candle's extreme fills on this candle.
    if (spec.sameBarStopCheck && sl !== slBeforeManagement) {
      const filled = isBuy ? bar.low <= sl : bar.high >= sl;
      if (filled) return finish('BREAKEVEN', sl, bar);
    }

    // 4. Smart time stop.
    if (bar.closeTime - input.entryTimestamp >= TIME_STOP_MINUTES * 60000) {
      const inProfit = isBuy ? bar.close > entry : bar.close < entry;
      if (inProfit) {
        const next = isBuy ? entry + BREAKEVEN_BUFFER_POINTS : entry - BREAKEVEN_BUFFER_POINTS;
        if (isBuy ? next > sl : next < sl) sl = next;
        breakevenApplied = true;
      } else {
        return finish('TIMEOUT', bar.close, bar);
      }
    }
  }

  const last = bars[bars.length - 1];
  const lastPoints = last ? Number((isBuy ? last.close - entry : entry - last.close).toFixed(4)) : 0;
  return {
    name: spec.name,
    exitKind: 'STILL_OPEN',
    exitPrice: last ? Number(last.close.toFixed(2)) : undefined,
    points: lastPoints,
    netPnLUSD: netFor(input, lastPoints),
    minutesHeld: last ? Math.max(0, Math.round((last.closeTime - input.entryTimestamp) / 60000)) : 0,
    resolved: false
  };
}

function buildPostExit(input: ShadowTradeInput, bars: ShadowBar[], closedAt: Date): ShadowPostExit {
  const isBuy = input.action === 'BUY';
  const exitTime = closedAt.getTime();
  const horizonMinutes = input.postExitHorizonMinutes ?? DEFAULT_POST_EXIT_HORIZON_MINUTES;
  const horizonMs = horizonMinutes * 60000;

  const after = bars.filter(bar => bar.openTime >= exitTime && bar.openTime <= exitTime + horizonMs);

  let tpHit = false;
  let minutesToTp: number | undefined;
  let maxFavorablePoints = 0;
  let maxAdversePoints = 0;

  for (const bar of after) {
    const favorable = isBuy ? bar.high - input.entryPrice : input.entryPrice - bar.low;
    const adverse = isBuy ? input.entryPrice - bar.low : bar.high - input.entryPrice;
    if (favorable > maxFavorablePoints) maxFavorablePoints = favorable;
    if (adverse > maxAdversePoints) maxAdversePoints = adverse;

    if (!tpHit && (isBuy ? bar.high >= input.tpPrice : bar.low <= input.tpPrice)) {
      tpHit = true;
      minutesToTp = Math.max(0, Math.round((bar.closeTime - exitTime) / 60000));
    }
  }

  const lastBar = bars[bars.length - 1];
  const dataCoversHorizon = Boolean(lastBar && lastBar.closeTime >= exitTime + horizonMs);
  const horizonExpired = Date.now() >= exitTime + Math.min(horizonMs, 6 * 3600 * 1000);

  return {
    tpHit,
    minutesToTp,
    maxFavorablePoints: Number(maxFavorablePoints.toFixed(2)),
    maxAdversePoints: Number(maxAdversePoints.toFixed(2)),
    horizonMinutes,
    finalized: dataCoversHorizon || horizonExpired,
    checkedAt: new Date()
  };
}

/**
 * Replays every shadow variant for one trade and measures what the market did
 * after the real exit. `candles` must be closed candles in any order.
 */
export function evaluateShadow(
  input: ShadowTradeInput,
  candles: ShadowBar[],
  closedAt: Date
): ShadowEvaluation {
  // The feed only returns a limited window of candles. If it starts after the
  // entry, the replay would begin mid-trade and produce a meaningless result.
  const dataCoversEntry = candles.some(
    bar => Number.isFinite(bar.openTime) && bar.openTime <= input.entryTimestamp
  );

  const bars = candles
    .filter(bar => Number.isFinite(bar.openTime) && Number.isFinite(bar.closeTime))
    .filter(bar => bar.openTime >= input.entryTimestamp)
    .sort((a, b) => a.openTime - b.openTime);

  const variants = dataCoversEntry && bars.length > 0
    ? SHADOW_VARIANTS.map(spec => runVariant(spec, input, bars))
    : [];
  const postExit = buildPostExit(input, bars, closedAt);
  const finalized = dataCoversEntry
    && postExit.finalized
    && variants.length > 0
    && variants.every(variant => variant.resolved);

  return { variants, postExit, finalized, evaluatedAt: new Date(), dataCoversEntry };
}
