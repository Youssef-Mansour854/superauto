import { NextResponse } from 'next/server';
import { sendTelegramNotification } from '@/lib/telegram';
import { getLiveAccountBalance, getLiveRiskPercent, calculatePositionSize } from '@/config/accountConfig';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const time = new Date().toISOString();
  const liveBalance = getLiveAccountBalance();
  const liveRisk = getLiveRiskPercent();
  
  // Test position size calculation for Gold (Entry: 2500, SL: 2494 -> 6 points distance)
  const samplePos = calculatePositionSize(2500, 2494, liveBalance, liveRisk);
  
  let msg = `🧪 **اختبار تدقيق الإنتاج المباشر (Vercel Live Verification)**\n⏰ التوقيت: ${time}\n\n📊 **تفاصيل السكالبينج (Trend-Filtered Dynamic Momentum):**\n- الأصل: XAU/USD\n- السعر: $2500.00\n- 📏 حجم الصفقة المقترح: ${samplePos.lotSize.toFixed(2)} لوت\n- SL (1.5x ATR): $2494.00 | TP (2.0x ATR): $2508.00\n- ATR (14): $4.00\n- RSI (14): 58.20 | EMA20: $2498.50 | EMA100: $2492.10`;
  
  if (samplePos.hasRiskWarning) {
    msg += `\n\n${samplePos.riskWarningMessage}`;
  }

  const delivered = await sendTelegramNotification(msg);

  return NextResponse.json({
    success: delivered,
    message: delivered ? 'Telegram alert sent successfully from Vercel!' : 'Failed to send Telegram alert.',
    timestamp: time,
    accountConfig: {
      liveBalance,
      liveRisk,
      envAccountBalance: process.env.ACCOUNT_BALANCE || null,
      envRiskPercent: process.env.RISK_PERCENT || null,
      samplePositionCalculation: samplePos
    },
    env: {
      hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
      hasChatId: !!process.env.TELEGRAM_CHAT_ID,
      nodeEnv: process.env.NODE_ENV
    }
  }, { status: delivered ? 200 : 500 });
}
