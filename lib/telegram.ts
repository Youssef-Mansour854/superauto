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

  // 1. First attempt: Standard Markdown
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
      console.log('Telegram notification delivered successfully (Markdown).');
      return true;
    }
  } catch (error: any) {
    const errorDesc = error?.response?.data?.description || error?.message || '';
    console.warn(`Telegram Markdown parse failed (${errorDesc}). Retrying immediately with plain text fallback...`);
  }

  // 2. Reliable Fallback: Plain Text (Guarantees messages are NEVER lost due to unescaped markdown)
  try {
    const fallbackResponse = await axios.post(
      url,
      {
        chat_id: chatId,
        text: textMessage,
      },
      { timeout: 8000 }
    );

    if (fallbackResponse.data?.ok) {
      console.log('Telegram notification delivered successfully via plain text fallback.');
      return true;
    } else {
      console.error('Telegram API fallback returned not OK:', fallbackResponse.data);
      return false;
    }
  } catch (fallbackError: any) {
    console.error('Error sending Telegram notification even without parse_mode:', fallbackError?.response?.data || fallbackError?.message);
    return false;
  }
}
