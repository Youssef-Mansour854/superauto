import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import DetailedTradeLog from '@/models/DetailedTradeLog';
import { diagnoseTradeOutcome } from '@/lib/tradeDiagnosis';
import TradeHistory from '@/models/TradeHistory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function formatCairoTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

/**
 * استنتاج سبب الخروج الصحيح من البيانات المخزّنة.
 * السجلات القديمة كانت تصنّف كل خسائر الشراء تقريبًا كـ HARD_STOP بسبب مقارنة معكوسة،
 * لذلك نعيد الاشتقاق من أقصى انعكاس فعلي (maxDrawdownPoints) مقابل الوقف الكارثي (3×ATR).
 */
function resolveExitReason(trade: any): 'TAKE_PROFIT' | 'SOFT_STOP' | 'HARD_STOP' | 'BREAKEVEN' | 'FRIDAY_CLOSE' | 'TIMEOUT' {
  if (trade.status === 'WIN') return 'TAKE_PROFIT';
  if (trade.status === 'BREAKEVEN') return 'BREAKEVEN';
  if (trade.exitReason === 'TIMEOUT' || trade.exitReason === 'FRIDAY_CLOSE') return trade.exitReason;
  if (trade.status === 'LOSS') {
    const atr = typeof trade.atr === 'number' && trade.atr > 0 ? trade.atr : null;
    const mae = typeof trade.maxDrawdownPoints === 'number' ? trade.maxDrawdownPoints : null;
    const hardMult = trade.symbol?.includes('QQQ') || trade.symbol?.includes('IXIC') ? 2.5 : 3.0;
    if (atr && mae != null && mae >= atr * hardMult * 0.97) return 'HARD_STOP';
    return 'SOFT_STOP';
  }
  return trade.exitReason || 'SOFT_STOP';
}

export async function GET(req: Request) {
  try {
    await connectToDatabase();
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const status = url.searchParams.get('status');
    const symbol = url.searchParams.get('symbol');

    const query: any = {};
    if (status) query.status = status.toUpperCase();
    if (symbol) query.symbol = symbol.toUpperCase();

    const trades = await DetailedTradeLog.find(query)
      .sort({ entryTimestamp: -1 })
      .limit(limit);

    // Calculate detailed journal analytics
    let totalWins = 0;
    let totalLosses = 0;
    let totalBreakevens = 0;
    let totalNetPnL = 0;
    let totalGrossPnL = 0;
    let totalFees = 0;
    let totalScoreWins = 0;
    let totalScoreLosses = 0;

    trades.forEach((t) => {
      if (t.status === 'WIN') {
        totalWins++;
        if (t.groqScore) totalScoreWins += t.groqScore;
      } else if (t.status === 'LOSS') {
        totalLosses++;
        if (t.groqScore) totalScoreLosses += t.groqScore;
      } else if (t.status === 'BREAKEVEN') {
        totalBreakevens++;
      }
      if (typeof t.netPnLUSD === 'number') totalNetPnL += t.netPnLUSD;
      if (typeof t.grossPnLUSD === 'number') totalGrossPnL += t.grossPnLUSD;
      if (typeof t.tradingFeeUSD === 'number') totalFees += t.tradingFeeUSD;
    });

    const closedTradesCount = totalWins + totalLosses + totalBreakevens;
    const winRate = closedTradesCount > 0 ? Number(((totalWins / closedTradesCount) * 100).toFixed(2)) : 0;
    const avgWinScore = totalWins > 0 ? Number((totalScoreWins / totalWins).toFixed(2)) : null;
    const avgLossScore = totalLosses > 0 ? Number((totalScoreLosses / totalLosses).toFixed(2)) : null;

    return NextResponse.json({
      success: true,
      message: 'سجل الصفقات المفصل (Detailed Trade Journal)',
      analytics: {
        totalLoggedTrades: trades.length,
        closedTradesCount,
        wins: totalWins,
        losses: totalLosses,
        breakevens: totalBreakevens,
        winRatePercent: winRate,
        netPnLUSD: Number(totalNetPnL.toFixed(2)),
        grossPnLUSD: Number(totalGrossPnL.toFixed(2)),
        totalFeesUSD: Number(totalFees.toFixed(2)),
        avgGroqScoreWins: avgWinScore,
        avgGroqScoreLosses: avgLossScore
      },
      trades
    }, { status: 200 });

  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error?.message || 'Failed to fetch detailed trade journal'
    }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await connectToDatabase();
    const result = await DetailedTradeLog.deleteMany({});
    return NextResponse.json({
      success: true,
      message: `تم مسح السجل الجديد بالكامل بنجاح (${result.deletedCount} صفقة قديمة تم تفريغها). السجل الآن فارغ 100% وجاهز لاستقبال أول صفقة تبدأ بعد هذه المحادثة!`,
      deletedCount: result.deletedCount
    }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error?.message || 'Failed to clear journal'
    }, { status: 500 });
  }
}

export async function PATCH() {
  try {
    await connectToDatabase();
    const trades = await DetailedTradeLog.find();
    let updatedCount = 0;

    for (const t of trades) {
      const exitReasonVal = resolveExitReason(t);
      const diag = diagnoseTradeOutcome({
        action: t.action,
        status: t.status as any,
        exitReason: exitReasonVal,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice || t.entryPrice,
        slPrice: t.slPrice,
        tpPrice: t.tpPrice,
        pnlPoints: t.pnlPoints || 0,
        netPnLUSD: t.netPnLUSD || 0,
        durationMinutes: t.durationMinutes || 20,
        highestHighDuringTrade: t.highestHighDuringTrade || t.entryPrice,
        lowestLowDuringTrade: t.lowestLowDuringTrade || t.entryPrice,
        rsi: t.rsi,
        exitRsi: t.exitRsi,
        sessionName: t.sessionName || 'GLOBAL',
        triggerReason: t.triggerReason,
        riskAmountUSD: t.riskAmountUSD,
        atr: t.atr,
        hardStopMultiplier: t.symbol?.includes('QQQ') || t.symbol?.includes('IXIC') ? 2.5 : 3.0
      });

      t.exitReason = exitReasonVal as any;
      t.outcomeReasonArabic = diag.outcomeReasonArabic;
      t.postTradeLesson = diag.postTradeLesson;
      // لا نستبدل أقصى انعكاس/أفضل حركة إن كانتا محفوظتين بالفعل (الحفاظ على القياس الأصلي)
      if (typeof t.maxDrawdownPoints !== 'number' || !isFinite(t.maxDrawdownPoints)) {
        t.maxDrawdownPoints = diag.maxDrawdownPoints;
      }
      if (typeof t.maxFavorablePoints !== 'number' || !isFinite(t.maxFavorablePoints)) {
        t.maxFavorablePoints = diag.maxFavorablePoints;
      }
      await t.save();
      updatedCount++;
    }

    return NextResponse.json({
      success: true,
      message: `تم تشخيص وتحديث أسباب الربح والخسارة لـ ${updatedCount} صفقة في السجل بنجاح!`,
      updatedCount
    }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message }, { status: 500 });
  }
}
