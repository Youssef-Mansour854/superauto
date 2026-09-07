import { NextResponse } from 'next/server';
import { sendTelegramNotification } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const time = new Date().toISOString();
  const msg = `✅ **اختبار اتصال ناجح!**\n🚀 البوت شغال وسيرفر Vercel متصل بتليجرام بنجاح.\n⏰ التوقيت: ${time}`;
  const delivered = await sendTelegramNotification(msg);

  return NextResponse.json({
    success: delivered,
    message: delivered ? 'Telegram alert sent successfully from Vercel!' : 'Failed to send Telegram alert.',
    timestamp: time,
    env: {
      hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
      hasChatId: !!process.env.TELEGRAM_CHAT_ID,
      nodeEnv: process.env.NODE_ENV
    }
  }, { status: delivered ? 200 : 500 });
}
