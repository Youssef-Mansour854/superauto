import mongoose, { Schema, Document } from 'mongoose';

export interface IAccountState extends Document {
  accountId: string;
  initialBalance: number;
  currentBalance: number;
  totalPnL: number;
  totalTrades: number;
  winsCount: number;
  lossesCount: number;
  breakevenCount: number;
  lastTradeId?: string;
  lastTradePnL?: number;
  updatedAt: Date;
}

const AccountStateSchema: Schema = new Schema<IAccountState>({
  accountId: { type: String, required: true, unique: true, default: 'default' },
  initialBalance: { type: Number, required: true, default: 100 },
  currentBalance: { type: Number, required: true, default: 100 },
  totalPnL: { type: Number, default: 0 },
  totalTrades: { type: Number, default: 0 },
  winsCount: { type: Number, default: 0 },
  lossesCount: { type: Number, default: 0 },
  breakevenCount: { type: Number, default: 0 },
  lastTradeId: { type: String },
  lastTradePnL: { type: Number },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.AccountState || mongoose.model<IAccountState>('AccountState', AccountStateSchema);
