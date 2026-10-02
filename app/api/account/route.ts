import { NextResponse } from 'next/server';
import { getLiveAccountState, resetAccountBalance } from '@/lib/account';
import { connectToDatabase } from '@/lib/mongodb';
import TradeHistory from '@/models/TradeHistory';
import Trade from '@/models/Trade';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    await connectToDatabase();
    const state = await getLiveAccountState();
    const url = new URL(req.url);
    const history = url.searchParams.get('history');

    if (history === 'true') {
      const startOfWeek = new Date('2026-09-28T00:00:00.000Z');
      const trades = await TradeHistory.find({
        closedAt: { $gte: startOfWeek }
      }).sort({ closedAt: -1 }).limit(100);

      const activeTrades = await Trade.find({ status: { $ne: 'ARCHIVED' } });

      return NextResponse.json({
        success: true,
        account: state,
        activeTrades,
        weeklyTradesCount: trades.length,
        trades
      }, { status: 200 });
    }

    return NextResponse.json({
      success: true,
      account: state
    }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err?.message || 'Failed to fetch account state'
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const balance = parseFloat(body.balance !== undefined ? body.balance : body.initialBalance);
    if (isNaN(balance) || balance <= 0) {
      return NextResponse.json({
        success: false,
        error: 'Invalid balance value. Must be a positive number.'
      }, { status: 400 });
    }
    const updated = await resetAccountBalance(balance);
    return NextResponse.json({
      success: true,
      message: `Account balance updated to $${balance.toFixed(2)}`,
      account: updated
    }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err?.message || 'Failed to update account balance'
    }, { status: 500 });
  }
}
