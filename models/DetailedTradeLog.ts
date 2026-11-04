import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IDetailedTradeLog extends Document {
  tradeId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  tradeType: 'SCALP' | 'SWING';
  status: 'ALERT_SENT' | 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN';

  // Timestamps
  entryTimestamp: Date;
  entryCairoTime: string;
  sourceCandleCloseTime: Date;
  sourceCandleCloseCairo: string;
  closedAt?: Date;
  closedCairoTime?: string;
  durationMinutes?: number;
  durationCandles?: number;

  // Execution Levels
  entryPrice: number;
  exitPrice?: number;
  slPrice: number;
  tpPrice: number;
  breakevenTriggerPrice: number;
  exitReason?: 'TAKE_PROFIT' | 'SOFT_STOP' | 'HARD_STOP' | 'BREAKEVEN' | 'FRIDAY_CLOSE' | 'TIMEOUT';

  // Position & Financials
  lotSize: number;
  accountBalanceAtEntry: number;
  riskAmountUSD: number;
  riskPercent: number;
  potentialProfitUSD: number;
  riskRewardRatio: number;
  pnlPoints?: number;
  grossPnLUSD?: number;
  tradingFeeUSD?: number;
  spreadCostUSD?: number;
  slippageCostUSD?: number;
  commissionUSD?: number;
  netPnLUSD?: number;
  balanceAfterTrade?: number;

  // Entry Technical Analysis & Candle Anatomy
  triggerReason: string;
  candleOpen?: number;
  candleHigh?: number;
  candleLow?: number;
  candleClose?: number;
  rsi: number;
  prevRsi?: number;
  ema20: number;
  ema100: number;
  ema200?: number;
  atr: number;
  sessionName?: string;
  trendAlignment: 'ALIGNED_WITH_MACRO' | 'COUNTER_TREND' | 'CHOPPY';

  // Exit Technical State & Max Drawdown/Excursion
  exitRsi?: number;
  exitEma20?: number;
  exitEma100?: number;
  exitEma200?: number;
  exitAtr?: number;
  highestHighDuringTrade?: number;
  lowestLowDuringTrade?: number;

  // Groq AI Intelligence & Reasoning
  groqScore?: number;
  groqApproved?: boolean;
  groqReason?: string;
  groqAnalysis?: string;

  // Metadata & Communication
  feedSource: string;
  telegramSent: boolean;
  telegramText?: string;
  notes?: string;
  createdAt: Date;
}

const DetailedTradeLogSchema: Schema = new Schema<IDetailedTradeLog>({
  tradeId: { type: String, required: true, unique: true, index: true },
  symbol: { type: String, required: true, index: true },
  action: { type: String, enum: ['BUY', 'SELL'], required: true },
  tradeType: { type: String, enum: ['SCALP', 'SWING'], default: 'SCALP', required: true, index: true },
  status: { type: String, enum: ['ALERT_SENT', 'OPEN', 'WIN', 'LOSS', 'BREAKEVEN'], default: 'OPEN', required: true, index: true },

  // Timestamps
  entryTimestamp: { type: Date, default: Date.now, index: true },
  entryCairoTime: { type: String, required: true },
  sourceCandleCloseTime: { type: Date, required: true },
  sourceCandleCloseCairo: { type: String, required: true },
  closedAt: { type: Date, index: true },
  closedCairoTime: { type: String },
  durationMinutes: { type: Number },
  durationCandles: { type: Number },

  // Execution Levels
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  slPrice: { type: Number, required: true },
  tpPrice: { type: Number, required: true },
  breakevenTriggerPrice: { type: Number, required: true },
  exitReason: { type: String, enum: ['TAKE_PROFIT', 'SOFT_STOP', 'HARD_STOP', 'BREAKEVEN', 'FRIDAY_CLOSE', 'TIMEOUT'] },

  // Position & Financials
  lotSize: { type: Number, required: true },
  accountBalanceAtEntry: { type: Number, required: true },
  riskAmountUSD: { type: Number, required: true },
  riskPercent: { type: Number, required: true },
  potentialProfitUSD: { type: Number, required: true },
  riskRewardRatio: { type: Number, required: true },
  pnlPoints: { type: Number },
  grossPnLUSD: { type: Number },
  tradingFeeUSD: { type: Number },
  spreadCostUSD: { type: Number },
  slippageCostUSD: { type: Number },
  commissionUSD: { type: Number },
  netPnLUSD: { type: Number },
  balanceAfterTrade: { type: Number },

  // Entry Technical Analysis & Candle Anatomy
  triggerReason: { type: String, required: true },
  candleOpen: { type: Number },
  candleHigh: { type: Number },
  candleLow: { type: Number },
  candleClose: { type: Number },
  rsi: { type: Number, required: true },
  prevRsi: { type: Number },
  ema20: { type: Number, required: true },
  ema100: { type: Number, required: true },
  ema200: { type: Number },
  atr: { type: Number, required: true },
  sessionName: { type: String },
  trendAlignment: { type: String, enum: ['ALIGNED_WITH_MACRO', 'COUNTER_TREND', 'CHOPPY'], default: 'ALIGNED_WITH_MACRO' },

  // Exit Technical State & Max Drawdown/Excursion
  exitRsi: { type: Number },
  exitEma20: { type: Number },
  exitEma100: { type: Number },
  exitEma200: { type: Number },
  exitAtr: { type: Number },
  highestHighDuringTrade: { type: Number },
  lowestLowDuringTrade: { type: Number },

  // Groq AI Intelligence & Reasoning
  groqScore: { type: Number },
  groqApproved: { type: Boolean },
  groqReason: { type: String },
  groqAnalysis: { type: String },

  // Metadata & Communication
  feedSource: { type: String, required: true },
  telegramSent: { type: Boolean, default: false },
  telegramText: { type: String },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now }
}, {
  collection: 'detailed_trade_logs',
  timestamps: true
});

const DetailedTradeLog: Model<IDetailedTradeLog> =
  mongoose.models.DetailedTradeLog || mongoose.model<IDetailedTradeLog>('DetailedTradeLog', DetailedTradeLogSchema);

export default DetailedTradeLog;
