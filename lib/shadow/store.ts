/** All storage for the shadow subsystem. It never touches a main-bot collection. */
import mongoose, { Schema } from 'mongoose';
import { StrategyId } from './config';
import { Candle, OpenPosition, TradeRecord } from './types';

function model(name: string, schema: Schema): mongoose.Model<any> {
  return (mongoose.models[name] as mongoose.Model<any>) || mongoose.model(name, schema);
}

const candleSchema = new Schema({
  openTime: { type: Number, required: true, unique: true, index: true },
  closeTime: { type: Number, required: true },
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  volume: { type: Number, default: 0 },
  source: { type: String, default: 'time_series' }
}, { collection: 'shadow_candles_5m', versionKey: false });

const apiUsageSchema = new Schema({
  date: { type: String, required: true, index: true },
  endpoint: { type: String, required: true },
  credits: { type: Number, required: true },
  caller: { type: String, required: true },
  keyLabel: { type: String, default: 'unknown' },
  at: { type: Date, default: Date.now, index: true }
}, { collection: 'api_usage', versionKey: false });

const quotaSchema = new Schema({
  keyIndex: { type: Number, required: true },
  date: { type: String, required: true },
  dailyUsage: { type: Number, required: true },
  planDailyLimit: { type: Number, required: true },
  fetchedAt: { type: Date, default: Date.now }
}, { collection: 'shadow_quota_snapshots', versionKey: false });
quotaSchema.index({ keyIndex: 1, date: 1 }, { unique: true });

const runSchema = new Schema({
  strategy_id: { type: String, required: true, index: true },
  params_version: { type: Number, required: true },
  params_json: { type: String, required: true },
  started_at: { type: Date, default: Date.now },
  evaluator_version: { type: String, required: true },
  source: { type: String, default: 'live' }
}, { collection: 'strategy_runs', versionKey: false });

const positionSchema = new Schema({
  tradeId: { type: String, required: true, unique: true },
  strategy_id: { type: String, required: true },
  source: { type: String, default: 'live' },
  params_version: { type: Number, required: true },
  evaluator_version: { type: String, required: true },
  signal: { type: Schema.Types.Mixed, required: true },
  openedAt: { type: Number, required: true },
  split: { type: String, default: undefined }
}, { collection: 'shadow_positions', versionKey: false });
positionSchema.index({ strategy_id: 1, source: 1 }, { unique: true });

const oneMinuteSchema = new Schema({
  barKey: { type: String, required: true, unique: true },
  candles: { type: [Schema.Types.Mixed], default: [] },
  resolvedAt: { type: Date, default: Date.now }
}, { collection: 'shadow_1m_cache', versionKey: false });

const healthSchema = new Schema({
  date: { type: String, required: true, index: true },
  strategy_id: { type: String, required: true },
  signals: { type: Number, default: 0 },
  exits: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  ambiguous: { type: Number, default: 0 },
  credits: { type: Number, default: 0 },
  at: { type: Date, default: Date.now }
}, { collection: 'shadow_health', versionKey: false });
healthSchema.index({ date: 1, strategy_id: 1 }, { unique: true });

const stateSchema = new Schema({
  key: { type: String, required: true, unique: true },
  lastBarCloseTime: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'shadow_state', versionKey: false });

const signalSchema = new Schema({
  strategy_id: { type: String, required: true, index: true },
  source: { type: String, default: 'live' },
  date: { type: String, required: true },
  signal_time_utc: { type: Number, required: true },
  signal: { type: Schema.Types.Mixed, required: true }
}, { collection: 'shadow_signals', versionKey: false });
signalSchema.index({ strategy_id: 1, source: 1, date: 1 });

const tradeSchema = new Schema({
  trade_id: { type: String, required: true, unique: true },
  strategy_id: { type: String, required: true, index: true },
  params_version: { type: Number, required: true },
  evaluator_version: { type: String, required: true },
  signal_time_utc: { type: Date, required: true },
  entry_time_utc: { type: Date, required: true },
  exit_time_utc: { type: Date, required: true },
  direction: { type: String, required: true },
  entry_price: { type: Number, required: true },
  stop: { type: Number, required: true },
  target: { type: Number, default: null },
  risk_usd_per_001lot: { type: Number, required: true },
  atr14: { type: Number, required: true },
  rsi14: { type: Number, default: null },
  session_bucket_utc: { type: String, required: true },
  exit_type: { type: String, required: true },
  exit_price: { type: Number, required: true },
  ambiguous: { type: Boolean, default: false },
  resolved_by: { type: String, default: 'none' },
  gross_units: { type: Number, required: true },
  cost_units: { type: Number, required: true },
  net_units: { type: Number, required: true },
  R: { type: Number, required: true },
  mfe_units: { type: Number, required: true },
  mae_units: { type: Number, required: true },
  duration_minutes: { type: Number, required: true },
  source: { type: String, default: 'live', index: true },
  split: { type: String, default: undefined }
}, { versionKey: false });
tradeSchema.index({ source: 1, exit_time_utc: 1 });

export const ShadowCandle = model('ShadowCandle', candleSchema);
export const ApiUsageLog = model('ApiUsageLog', apiUsageSchema);
export const QuotaSnapshot = model('QuotaSnapshot', quotaSchema);
export const StrategyRun = model('StrategyRun', runSchema);
export const ShadowPosition = model('ShadowPosition', positionSchema);
export const OneMinuteCache = model('OneMinuteCache', oneMinuteSchema);
export const ShadowHealth = model('ShadowHealth', healthSchema);
export const ShadowState = model('ShadowState', stateSchema);
export const ShadowSignal = model('ShadowSignal', signalSchema);

/** One identically-shaped results table per strategy (and for the control). */
export function tradeModel(strategyId: StrategyId | string): mongoose.Model<any> {
  const safe = String(strategyId).replace(/[^A-Za-z0-9_]/g, '_');
  const name = `ShadowTrade_${safe}`;
  return (mongoose.models[name] as mongoose.Model<any>) || mongoose.model(name, tradeSchema, `trades_${safe}`);
}

export async function upsertCandles(candles: Candle[]): Promise<number> {
  if (candles.length === 0) return 0;
  const bulk = ShadowCandle.collection.initializeUnorderedBulkOp();
  for (const c of candles) {
    bulk.find({ openTime: c.openTime }).upsert().updateOne({ $setOnInsert: {
      openTime: c.openTime, closeTime: c.closeTime, open: c.open,
      high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
      source: 'time_series'
    } });
  }
  await bulk.execute();
  return candles.length;
}

export async function loadCandles(from: number, to: number, limit = 10000): Promise<Candle[]> {
  const rows = await ShadowCandle.find({ openTime: { $gte: from, $lte: to } })
    .sort({ openTime: 1 }).limit(limit).lean().catch(() => []) as any[];
  return rows.map(r => ({
    openTime: Number(r.openTime), closeTime: Number(r.closeTime),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume || 0)
  }));
}

export async function logApiUsage(date: string, endpoint: string, credits: number, caller: string, keyLabel: string): Promise<void> {
  await ApiUsageLog.create({ date, endpoint, credits, caller, keyLabel });
}

export async function bumpHealth(strategyId: string, date: string, fields: Record<string, number>): Promise<void> {
  const inc: Record<string, number> = {};
  for (const [k, v] of Object.entries(fields)) inc[k] = v;
  await ShadowHealth.updateOne(
    { strategy_id: strategyId, date },
    { $inc: inc, $set: { at: new Date() } },
    { upsert: true }
  );
}

export async function readOpenPosition(strategyId: string, source: 'live' | 'replay'): Promise<OpenPosition | null> {
  const row = await ShadowPosition.findOne({ strategy_id: strategyId, source }).lean().catch(() => null) as any;
  if (!row) return null;
  return {
    tradeId: row.tradeId, strategyId: row.strategy_id, source: row.source,
    paramsVersion: row.params_version, evaluatorVersion: row.evaluator_version,
    signal: row.signal, openedAt: Number(row.openedAt), split: row.split
  };
}

export async function putOpenPosition(pos: OpenPosition): Promise<void> {
  await ShadowPosition.updateOne(
    { tradeId: pos.tradeId },
    { $set: {
      tradeId: pos.tradeId, strategy_id: pos.strategyId, source: pos.source,
      params_version: pos.paramsVersion, evaluator_version: pos.evaluatorVersion,
      signal: pos.signal, openedAt: pos.openedAt, split: pos.split
    } },
    { upsert: true }
  );
}

export async function removeOpenPosition(tradeId: string): Promise<void> {
  await ShadowPosition.deleteOne({ tradeId });
}

export async function writeTrade(strategyId: string, trade: TradeRecord): Promise<void> {
  await tradeModel(strategyId).updateOne({ trade_id: trade.trade_id }, { $set: trade }, { upsert: true });
}

export async function readTrades(strategyId: string, since?: Date): Promise<TradeRecord[]> {
  const filter: any = {};
  if (since) filter.exit_time_utc = { $gte: since };
  const rows = await tradeModel(strategyId).find(filter).sort({ exit_time_utc: 1 }).lean().catch(() => []) as any[];
  return rows as unknown as TradeRecord[];
}

export async function countTodaySignals(strategyId: string, utcDate: string): Promise<number> {
  const start = new Date(`${utcDate}T00:00:00Z`).getTime();
  return ShadowHealth.findOne({ strategy_id: strategyId, date: utcDate }).lean()
    .then((h: any) => h ? Number(h.signals || 0) : 0)
    .catch(() => 0) as Promise<number>;
}

export async function recordSignal(strategyId: string, source: string, utcDate: string, signalTime: number, signal: unknown): Promise<void> {
  const key = `signal:${strategyId}:${source}:${signalTime}`;
  await ShadowSignal.updateOne(
    { strategy_id: strategyId, source, signal_time_utc: signalTime },
    { $setOnInsert: { strategy_id: strategyId, source, date: utcDate, signal_time_utc: signalTime, signal, key } },
    { upsert: true }
  );
}

export async function todaySignals(strategyId: string, source: string, utcDate: string): Promise<any[]> {
  const rows = await ShadowSignal.find({ strategy_id: strategyId, source, date: utcDate })
    .sort({ signal_time_utc: 1 }).lean().catch(() => []) as any[];
  return rows.map(r => r.signal);
}

export async function ensureRun(strategyId: string, paramsVersion: number, paramsJson: string, evaluatorVersion: string, source: string): Promise<void> {
  await StrategyRun.updateOne(
    { strategy_id: strategyId, params_version: paramsVersion, evaluator_version: evaluatorVersion, source },
    { $setOnInsert: { strategy_id: strategyId, params_version: paramsVersion, params_json: paramsJson, started_at: new Date(), evaluator_version: evaluatorVersion, source } },
    { upsert: true }
  );
}
