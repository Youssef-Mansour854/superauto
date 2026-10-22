import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAiTradeMemory extends Document {
  version: number;
  createdAt: Date;
  source: 'HISTORICAL_FILES' | 'LIVE_DATABASE' | 'HYBRID';
  totalTradesAnalyzed: number;
  winRate: number;
  netPnLUSD: number;
  profitFactor: number;
  toxicPatterns: string[];       // الأنماط الخاسرة المتكررة (مثل دخول شراء في تشبع بيعي أو في جلسة معينة)
  winningPatterns: string[];     // الأنماط الرابحة القوية
  negativeRules: string[];       // قواعد حاسمة للـ Gatekeeper لرفض الصفقات المشابهة للخسائر
  summaryArabic: string;         // تقرير إحصائي تحليلي شامل
  isActive: boolean;
}

const AiTradeMemorySchema: Schema = new Schema<IAiTradeMemory>({
  version: { type: Number, default: 1, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
  source: { type: String, enum: ['HISTORICAL_FILES', 'LIVE_DATABASE', 'HYBRID'], default: 'LIVE_DATABASE' },
  totalTradesAnalyzed: { type: Number, required: true },
  winRate: { type: Number, required: true },
  netPnLUSD: { type: Number, required: true },
  profitFactor: { type: Number, default: 0 },
  toxicPatterns: [{ type: String }],
  winningPatterns: [{ type: String }],
  negativeRules: [{ type: String }],
  summaryArabic: { type: String, required: true },
  isActive: { type: Boolean, default: true, index: true },
});

const AiTradeMemory: Model<IAiTradeMemory> =
  mongoose.models.AiTradeMemory || mongoose.model<IAiTradeMemory>('AiTradeMemory', AiTradeMemorySchema);

export default AiTradeMemory;
