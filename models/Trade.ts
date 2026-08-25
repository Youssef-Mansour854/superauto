import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ITrade extends Document {
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice?: number;
  sl: number;
  tp: number;
  rsi?: number;
  ema20?: number;
  ema100?: number;
  ema200?: number;
  atr?: number;
  sma50?: number;
  macd?: number;
  tradeType: 'SCALP' | 'SWING';
  newsHeadlines?: string[];
  groqAnalysis?: string;
  status: 'ALERT_SENT' | 'WIN' | 'LOSS' | 'ARCHIVED';
  breakevenApplied?: boolean;
  closedAt?: Date;
  timestamp: Date;
}

const TradeSchema: Schema = new Schema<ITrade>({
  symbol: { type: String, required: true, index: true },
  action: { type: String, enum: ['BUY', 'SELL'], required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  sl: { type: Number, required: true },
  tp: { type: Number, required: true },
  rsi: { type: Number },
  ema20: { type: Number },
  ema100: { type: Number },
  ema200: { type: Number },
  atr: { type: Number },
  sma50: { type: Number },
  macd: { type: Number },
  tradeType: { type: String, enum: ['SCALP', 'SWING'], default: 'SCALP', required: true, index: true },
  newsHeadlines: [{ type: String }],
  groqAnalysis: { type: String },
  status: { type: String, enum: ['ALERT_SENT', 'WIN', 'LOSS', 'ARCHIVED'], default: 'ALERT_SENT', index: true },
  breakevenApplied: { type: Boolean, default: false },
  closedAt: { type: Date },
  timestamp: { type: Date, default: Date.now }
});

const Trade: Model<ITrade> = mongoose.models.Trade || mongoose.model<ITrade>('Trade', TradeSchema);

export default Trade;
