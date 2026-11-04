import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import DetailedTradeLog from '@/models/DetailedTradeLog';
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

export async function POST(req: Request) {
  try {
    await connectToDatabase();
    const historyTrades = await TradeHistory.find().sort({ closedAt: -1 }).limit(100);

    let backfilled = 0;
    for (const h of historyTrades) {
      const tradeId = h.tradeId || h._id.toString();
      const existing = await DetailedTradeLog.findOne({ tradeId });
      if (!existing) {
        const entryTime = h.entryTimestamp || h.closedAt || new Date();
        const closedTime = h.closedAt || new Date();
        const durationMins = Math.max(1, Math.round((closedTime.getTime() - entryTime.getTime()) / 60000));
        const beTarget = h.action === 'BUY'
          ? h.entryPrice + 0.5 * (h.tp - h.entryPrice)
          : h.entryPrice - 0.5 * (h.entryPrice - h.tp);

        const rr = Math.abs(h.entryPrice - h.sl) > 0
          ? Number((Math.abs(h.tp - h.entryPrice) / Math.abs(h.entryPrice - h.sl)).toFixed(2))
          : 1.33;

        await DetailedTradeLog.create({
          tradeId,
          symbol: h.symbol,
          action: h.action,
          tradeType: h.tradeType || 'SCALP',
          status: h.status,
          entryTimestamp: entryTime,
          entryCairoTime: formatCairoTime(entryTime),
          sourceCandleCloseTime: h.sourceCandleCloseTime || entryTime,
          sourceCandleCloseCairo: formatCairoTime(h.sourceCandleCloseTime || entryTime),
          closedAt: closedTime,
          closedCairoTime: formatCairoTime(closedTime),
          durationMinutes: durationMins,
          entryPrice: h.entryPrice,
          exitPrice: h.exitPrice,
          slPrice: h.sl,
          tpPrice: h.tp,
          breakevenTriggerPrice: beTarget,
          exitReason: h.status === 'WIN' ? 'TAKE_PROFIT' : (h.status === 'BREAKEVEN' ? 'BREAKEVEN' : 'SOFT_STOP'),
          lotSize: h.suggestedLotSize || 0.01,
          accountBalanceAtEntry: h.balanceAfterTrade ? h.balanceAfterTrade - (h.netPnLUSD || 0) : 100,
          riskAmountUSD: h.atr ? Number((1.5 * h.atr).toFixed(2)) : 3.0,
          riskPercent: 2.0,
          potentialProfitUSD: h.atr ? Number((2.0 * h.atr).toFixed(2)) : 4.0,
          riskRewardRatio: rr,
          pnlPoints: h.pnlPoints,
          grossPnLUSD: h.grossPnLUSD,
          tradingFeeUSD: h.tradingFeeUSD,
          netPnLUSD: h.netPnLUSD,
          balanceAfterTrade: h.balanceAfterTrade,
          triggerReason: h.triggerReason || 'EMA20_PULLBACK',
          rsi: h.rsi || 50,
          ema20: h.ema20 || h.entryPrice,
          ema100: h.ema100 || h.entryPrice,
          ema200: h.ema200,
          atr: h.atr || 2.0,
          trendAlignment: 'ALIGNED_WITH_MACRO',
          exitRsi: h.exitRsi,
          exitEma20: h.exitEma20,
          exitEma100: h.exitEma100,
          exitAtr: h.exitAtr,
          groqScore: h.groqScore,
          groqReason: h.groqReason,
          groqAnalysis: h.groqAnalysis,
          feedSource: h.feedSource || 'TWELVEDATA XAU/USD',
          telegramSent: true
        });
        backfilled++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `تم مزامنة واستيراد ${backfilled} صفقة تاريخية في السجل المفصل بنجاح!`,
      backfilledCount: backfilled
    }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error?.message || 'Failed to backfill trades'
    }, { status: 500 });
  }
}
