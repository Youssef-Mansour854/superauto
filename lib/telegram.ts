import axios from 'axios';

export async function sendTelegramNotification(textMessage: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || token.includes('your_telegram_bot_token')) {
    console.warn('TELEGRAM_BOT_TOKEN missing or unconfigured. Skipping Telegram notification.');
    return false;
  }

  if (!chatId || chatId.includes('your_telegram_chat_id')) {
    console.warn('TELEGRAM_CHAT_ID missing or unconfigured. Skipping Telegram notification.');
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await axios.post(
      url,
      {
        chat_id: chatId,
        text: textMessage,
        parse_mode: 'Markdown',
      },
      { timeout: 8000 }
    );

    if (response.data?.ok) {
      console.log('Telegram notification delivered successfully.');
      return true;
    } else {
      console.error('Telegram API response returned not OK:', response.data);
      return false;
    }
  } catch (error: any) {
    console.error('Error sending Telegram notification:', error?.response?.data || error?.message || error);
    return false;
  }
}
