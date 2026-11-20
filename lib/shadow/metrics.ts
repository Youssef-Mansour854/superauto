/** Identical metrics for every strategy, the control, and the main bot. */
import { TradeRecord } from './types';

const round = (v: number, d = 4) => Number(v.toFixed(d));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Lanczos log-gamma; Math.lgamma is not available in this TS target. */
function logGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized incomplete beta (Numerical Recipes, continued fraction). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return front * betacf(a, b, x) / a;
  return 1 - front * betacf(b, a, 1 - x) / b;
}

/** Two-sided p-value for a one-sample t-test against zero. */
export function tTestPValue(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const s = sd(xs);
  if (s === 0) return m === 0 ? 1 : 0;
  const t = m / (s / Math.sqrt(n));
  return betai((n - 1) / 2, 0.5, (n - 1) / ((n - 1) + t * t));
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[i];
}

export function bootstrapCI(xs: number[], iterations = 2000, seed = 12345): [number, number] {
  if (xs.length < 2) return [0, 0];
  const random = rng(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(random() * xs.length)];
    means.push(sum / xs.length);
  }
  return [round(percentile(means, 0.025)), round(percentile(means, 0.975))];
}

export function dayClusteredCI(trades: TradeRecord[], iterations = 2000, seed = 777): [number, number] {
  const grouped = new Map<string, number[]>();
  for (const t of trades) {
    const day = new Date(t.exit_time_utc).toISOString().slice(0, 10);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(Number(t.R));
  }
  const days = [...grouped.values()];
  if (days.length < 2) return [0, 0];
  const random = rng(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < days.length; i++) {
      const day = days[Math.floor(random() * days.length)];
      sum += mean(day);
    }
    means.push(sum / days.length);
  }
  return [round(percentile(means, 0.025)), round(percentile(means, 0.975))];
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return round(num / Math.sqrt(dx * dy));
}

/** Pearson correlation of daily mean R between every pair of strategies. */
export function correlationMatrix(byStrategy: Record<string, TradeRecord[]>): Record<string, Record<string, number | null>> {
  const daily = new Map<string, Map<string, number[]>>();
  for (const [id, trades] of Object.entries(byStrategy)) {
    for (const t of trades) {
      const day = new Date(t.exit_time_utc).toISOString().slice(0, 10);
      if (!daily.has(day)) daily.set(day, new Map());
      const row = daily.get(day)!;
      if (!row.has(id)) row.set(id, []);
      row.get(id)!.push(Number(t.R));
    }
  }
  const out: Record<string, Record<string, number | null>> = {};
  for (const id of Object.keys(byStrategy)) {
    out[id] = {};
    for (const other of Object.keys(byStrategy)) {
      const days = [...daily.keys()].filter(d => daily.get(d)!.has(id) && daily.get(d)!.has(other)).sort();
      const xs = days.map(d => mean(daily.get(d)!.get(id)!));
      const ys = days.map(d => mean(daily.get(d)!.get(other)!));
      out[id][other] = id === other ? 1 : pearson(xs, ys);
    }
  }
  return out;
}

export interface Metrics {
  trades: number;
  wins: number;
  winRate: number;
  exitMix: Record<string, number>;
  netUnits: number;
  meanR: number;
  sdR: number;
  tP: number | null;
  ciTrade: [number, number];
  ciDay: [number, number];
  profitFactor: number;
  maxDrawdown: number;
  costsPctGrossProfit: number;
  ambiguous: number;
  dailyPnL: Record<string, number>;
  sessions: Record<string, { trades: number; netUnits: number }>;
  directions: Record<string, { trades: number; netUnits: number }>;
  tradesPerDay: number;
  daysTo200: number;
  flags: string[];
  evaluatorVersion: string;
  paramsVersion: number;
  correlationWithControl: number | null;
}

export function computeMetrics(
  trades: TradeRecord[],
  controlTrades: TradeRecord[] = [],
  evaluatorVersion = 'shadow-exit-v1',
  paramsVersion = 1
): Metrics {
  const Rs = trades.map(t => Number(t.R));
  const net = trades.map(t => Number(t.net_units));
  const wins = trades.filter(t => Number(t.net_units) > 0).length;
  const exitMix: Record<string, number> = {};
  const dailyPnL: Record<string, number> = {};
  const sessions: Record<string, { trades: number; netUnits: number }> = {};
  const directions: Record<string, { trades: number; netUnits: number }> = {};
  let cumulative = 0;
  let maxDD = 0;
  let costSum = 0;
  let positiveGross = 0;
  let negativeGross = 0;

  for (const t of trades) {
    const type = String(t.exit_type);
    exitMix[type] = (exitMix[type] || 0) + 1;
    const day = new Date(t.exit_time_utc).toISOString().slice(0, 10);
    dailyPnL[day] = (dailyPnL[day] || 0) + Number(t.net_units);
    const session = String(t.session_bucket_utc || 'UNKNOWN');
    if (!sessions[session]) sessions[session] = { trades: 0, netUnits: 0 };
    sessions[session].trades++;
    sessions[session].netUnits += Number(t.net_units);
    const dir = String(t.direction);
    if (!directions[dir]) directions[dir] = { trades: 0, netUnits: 0 };
    directions[dir].trades++;
    directions[dir].netUnits += Number(t.net_units);
    cumulative += Number(t.net_units);
    maxDD = Math.min(maxDD, cumulative);
    costSum += Number(t.cost_units);
    if (Number(t.gross_units) > 0) positiveGross += Number(t.gross_units);
    if (Number(t.gross_units) < 0) negativeGross += Math.abs(Number(t.gross_units));
  }

  const distinctDays = Object.keys(dailyPnL).length || 1;
  const tradesPerDay = trades.length / distinctDays;
  const controlDailyR = new Map<string, number[]>();
  for (const t of controlTrades) {
    const day = new Date(t.exit_time_utc).toISOString().slice(0, 10);
    if (!controlDailyR.has(day)) controlDailyR.set(day, []);
    controlDailyR.get(day)!.push(Number(t.R));
  }
  const myDailyR = new Map<string, number[]>();
  for (const t of trades) {
    const day = new Date(t.exit_time_utc).toISOString().slice(0, 10);
    if (!myDailyR.has(day)) myDailyR.set(day, []);
    myDailyR.get(day)!.push(Number(t.R));
  }
  const shared = [...myDailyR.keys()].filter(d => controlDailyR.has(d)).sort();
  const correlation = pearson(
    shared.map(d => mean(myDailyR.get(d)!)),
    shared.map(d => mean(controlDailyR.get(d)!))
  );

  const versions = new Set(trades.map(t => String(t.evaluator_version)));
  const paramVersions = new Set(trades.map(t => Number(t.params_version)));
  const flags: string[] = [];
  if (trades.length < 100) flags.push('LOW_SAMPLE');
  if (versions.size > 1 || paramVersions.size > 1 ||
    (trades.length > 0 && (String(trades[0].evaluator_version) !== evaluatorVersion || Number(trades[0].params_version) !== paramsVersion))) {
    flags.push('NOT_COMPARABLE');
  }

  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? round(wins / trades.length) : 0,
    exitMix,
    netUnits: round(net.reduce((a, b) => a + b, 0), 2),
    meanR: round(mean(Rs)),
    sdR: round(sd(Rs)),
    tP: tTestPValue(Rs),
    ciTrade: bootstrapCI(Rs),
    ciDay: dayClusteredCI(trades),
    profitFactor: negativeGross === 0 ? (positiveGross > 0 ? 99 : 0) : round(positiveGross / negativeGross),
    maxDrawdown: round(maxDD, 2),
    costsPctGrossProfit: positiveGross === 0 ? 0 : round(100 * costSum / positiveGross, 2),
    ambiguous: trades.filter(t => t.ambiguous).length,
    dailyPnL,
    sessions,
    directions,
    tradesPerDay: round(tradesPerDay, 2),
    daysTo200: tradesPerDay > 0 ? Math.max(0, Math.ceil((200 - trades.length) / tradesPerDay)) : -1,
    flags,
    evaluatorVersion,
    paramsVersion,
    correlationWithControl: correlation
  };
}

