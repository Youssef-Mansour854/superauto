import { connectToDatabase } from './mongodb';
import AccountState, { IAccountState } from '@/models/AccountState';
import { getLiveAccountBalance } from '@/config/accountConfig';

export interface AccountUpdateResult {
  previousBalance: number;
  newBalance: number;
  totalPnL: number;
  totalTrades: number;
}

/**
 * جلب حالة الحساب والرصيد الحالي من قاعدة البيانات:
 * إذا لم يكن هناك سجل سابق، يتم إنشاؤه تلقائياً بالرصيد المبدئي (من متغير البيئة أو 100$).
 */
export async function getLiveAccountState(): Promise<IAccountState | null> {
  try {
    await connectToDatabase();
    let state = await AccountState.findOne({ accountId: 'default' });
    if (!state) {
      const defaultBal = getLiveAccountBalance();
      state = await AccountState.create({
        accountId: 'default',
        initialBalance: defaultBal,
        currentBalance: defaultBal,
        totalPnL: 0,
        totalTrades: 0,
        winsCount: 0,
        lossesCount: 0,
        breakevenCount: 0,
        updatedAt: new Date()
      });
    }
    return state;
  } catch (err: any) {
    console.error('Error fetching live account state:', err?.message || err);
    return null;
  }
}

/**
 * تحديث رصيد الحساب ذرّياً بعد إغلاق صفقة:
 * يضيف pnlUSD إلى الرصيد التراكمي ويسجل عدد الصفقات والنتيجة.
 */
export async function applyTradeResultToAccount(
  pnlUSD: number,
  status: 'WIN' | 'LOSS' | 'BREAKEVEN',
  tradeId?: string
): Promise<AccountUpdateResult> {
  const fallbackBase = getLiveAccountBalance();

  try {
    await connectToDatabase();

    // تأكد من وجود السجل أولاً
    await getLiveAccountState();

    const incField = status === 'WIN' ? 'winsCount' : (status === 'LOSS' ? 'lossesCount' : 'breakevenCount');

    // قراءة الرصيد السابق
    const existing = await AccountState.findOne({ accountId: 'default' });
    const previousBalance = existing ? existing.currentBalance : fallbackBase;

    // تحديث ذري للرصيد
    const updated = await AccountState.findOneAndUpdate(
      { accountId: 'default' },
      {
        $inc: {
          currentBalance: pnlUSD,
          totalPnL: pnlUSD,
          totalTrades: 1,
          [incField]: 1
        },
        $set: {
          lastTradeId: tradeId,
          lastTradePnL: pnlUSD,
          updatedAt: new Date()
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const newBalance = Number(updated.currentBalance.toFixed(2));
    const totalPnL = Number(updated.totalPnL.toFixed(2));

    return {
      previousBalance: Number(previousBalance.toFixed(2)),
      newBalance,
      totalPnL,
      totalTrades: updated.totalTrades
    };
  } catch (err: any) {
    console.error('Error updating account state in database:', err?.message || err);
    const prev = fallbackBase;
    const next = Number((prev + pnlUSD).toFixed(2));
    return {
      previousBalance: prev,
      newBalance: next,
      totalPnL: pnlUSD,
      totalTrades: 1
    };
  }
}

/**
 * تعديل أو إعادة ضبط رصيد الحساب يدوياً
 */
export async function resetAccountBalance(newBalance: number): Promise<IAccountState | null> {
  try {
    await connectToDatabase();
    const updated = await AccountState.findOneAndUpdate(
      { accountId: 'default' },
      {
        $set: {
          initialBalance: newBalance,
          currentBalance: newBalance,
          totalPnL: 0,
          updatedAt: new Date()
        }
      },
      { new: true, upsert: true }
    );
    return updated;
  } catch (err: any) {
    console.error('Error resetting account balance:', err?.message || err);
    return null;
  }
}
