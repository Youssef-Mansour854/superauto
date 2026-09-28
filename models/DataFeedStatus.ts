import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IDataFeedStatus extends Document {
  symbol: string;
  consecutiveFailures: number;
  lastFailureAt?: Date;
  lastSuccessAt?: Date;
  lastHttpStatus?: number;
  lastErrorMessage?: string;
  lastAlertSentAt?: Date;
  outageAlertSent: boolean;
  updatedAt: Date;
}

const DataFeedStatusSchema: Schema = new Schema<IDataFeedStatus>({
  symbol: { type: String, required: true, unique: true, index: true },
  consecutiveFailures: { type: Number, default: 0 },
  lastFailureAt: { type: Date },
  lastSuccessAt: { type: Date },
  lastHttpStatus: { type: Number },
  lastErrorMessage: { type: String },
  lastAlertSentAt: { type: Date },
  outageAlertSent: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});

const DataFeedStatus: Model<IDataFeedStatus> =
  mongoose.models.DataFeedStatus || mongoose.model<IDataFeedStatus>('DataFeedStatus', DataFeedStatusSchema);

export default DataFeedStatus;
