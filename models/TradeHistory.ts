import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ITradeHistory extends Document {
  tradeId?: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  tradeType: 'SCALP' | 'SWING';
  entryPrice: number;
  exitPrice: number;
  sl: number;
  tp: number;
  status: 'WIN' | 'LOSS';
  rsi?: number;
  ema20?: number;
  ema100?: number;
  ema200?: number;
  atr?: number;
  sma50?: number;
  macd?: number;
  exitRsi?: number;
  exitEma20?: number;
  exitEma100?: number;
  exitEma200?: number;
  exitAtr?: number;
  newsHeadlines?: string[];
  groqAnalysis?: string;
  entryTimestamp?: Date;
  closedAt: Date;
}

const TradeHistorySchema: Schema = new Schema<ITradeHistory>({
  tradeId: { type: String, index: true },
  symbol: { type: String, required: true, index: true },
  action: { type: String, enum: ['BUY', 'SELL'], required: true },
  tradeType: { type: String, enum: ['SCALP', 'SWING'], required: true, index: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  sl: { type: Number, required: true },
  tp: { type: Number, required: true },
  status: { type: String, enum: ['WIN', 'LOSS'], required: true, index: true },
  rsi: { type: Number },
  ema20: { type: Number },
  ema100: { type: Number },
  ema200: { type: Number },
  atr: { type: Number },
  sma50: { type: Number },
  macd: { type: Number },
  exitRsi: { type: Number },
  exitEma20: { type: Number },
  exitEma100: { type: Number },
  exitEma200: { type: Number },
  exitAtr: { type: Number },
  newsHeadlines: [{ type: String }],
  groqAnalysis: { type: String },
  entryTimestamp: { type: Date },
  closedAt: { type: Date, default: Date.now }
}, { collection: 'trade_history' });

const TradeHistory: Model<ITradeHistory> = mongoose.models.TradeHistory || mongoose.model<ITradeHistory>('TradeHistory', TradeHistorySchema);

export default TradeHistory;
