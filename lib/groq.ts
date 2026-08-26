import axios from 'axios';
import { formatPrice } from './indicators';

export interface GroqSignalData {
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  rsi: number;
  ema20: number;
  ema100?: number;
  ema200?: number;
  atr?: number;
}

export interface GroqSwingData {
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  sma50: number;
  macd: number;
  macdSignal: number;
  newsHeadlines: string[];
}

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama3-8b-8192';

export async function generateGroqArabicAlert(data: GroqSignalData): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;

  const ema100Val = data.ema100 !== undefined ? data.ema100 : data.ema200;

  const defaultFallback = data.action === 'BUY'
    ? `🚨 **صفقة سكالبينج سريعة (شراء) 🔥**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${formatPrice(data.entryPrice)}\nهدف أرباح (TP - ATR 3x): $${formatPrice(data.tp)}\nوقف خسارة (SL - ATR 1.5x): $${formatPrice(data.sl)}\nمؤشر RSI: ${formatPrice(data.rsi)} | EMA20: $${formatPrice(data.ema20)}${ema100Val !== undefined ? ` | EMA100: $${formatPrice(ema100Val)}` : ''}\nفرصة صعودية قوية مع الاتجاه العام!`
    : `🚨 **صفقة سكالبينج سريعة (بيع) 📉**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${formatPrice(data.entryPrice)}\nهدف أرباح (TP - ATR 3x): $${formatPrice(data.tp)}\nوقف خسارة (SL - ATR 1.5x): $${formatPrice(data.sl)}\nمؤشر RSI: ${formatPrice(data.rsi)} | EMA20: $${formatPrice(data.ema20)}${ema100Val !== undefined ? ` | EMA100: $${formatPrice(ema100Val)}` : ''}\nفرصة هبوط قوية مع الاتجاه العام!`;

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت خبير تداول وسكالبينج محترف وسريع جداً. مهمتك كتابة تنبيه صفقة سكالبينج حاسم وقصير بلهجة مصرية عامية حماسية ومباشرة (Egyptian Arabic).`;

  const userPrompt = `
اكتب تنبيه تداول سكالبينج حماسي بلهجة مصرية عامية بناءً على البيانات التالية:
- العملة/الأصل: ${data.symbol}
- نوع الصفقة: ${data.action === 'BUY' ? 'شراء (BUY)' : 'بيع (SELL)'}
- سعر الدخول الحالي: $${formatPrice(data.entryPrice)}
- Stop Loss (وقف الخسارة - 1.5x ATR): $${formatPrice(data.sl)}
- Take Profit (هدف الأرباح - 3.0x ATR): $${formatPrice(data.tp)}
- مؤشر RSI (14): ${formatPrice(data.rsi)}
- مؤشر EMA (20): $${formatPrice(data.ema20)}
${ema100Val !== undefined ? `- مؤشر EMA (100): $${formatPrice(ema100Val)}\n` : ''}${data.atr ? `- مؤشر ATR (14): $${formatPrice(data.atr)}\n` : ''}
اجعل التنبيه مركزاً وقصيراً وحماسياً ويشجع على التنفيذ السريع ويوضح المستويات المالية بوضوح.
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 350,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || defaultFallback;
  } catch (error: any) {
    console.error('Error calling Groq API for scalp alert:', error?.response?.data || error?.message || error);
    return defaultFallback;
  }
}

export async function generateGroqSwingAnalysis(data: GroqSwingData): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;

  const newsSummary = data.newsHeadlines && data.newsHeadlines.length > 0
    ? data.newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'لا توجد أخبار رئيسية حديثة متوفرة.';

  const defaultFallback = `📈 **تحليل وتوصية استثمارية (صفقة سوينغ / swing) - ${data.symbol}**\n\n` +
    `**القرار:** ${data.action === 'BUY' ? 'شراء استثماري (BUY)' : 'بيع/تخفيف (SELL)'}\n` +
    `**سعر الدخول:** $${formatPrice(data.entryPrice)}\n` +
    `**وقف الخسارة (SL):** $${formatPrice(data.sl)}\n` +
    `**الهدف الاستثماري (TP):** $${formatPrice(data.tp)}\n` +
    `**المؤشرات الفنية:** SMA(50)=$${formatPrice(data.sma50)} | MACD=${formatPrice(data.macd)}\n\n` +
    `**أهم الأخبار:**\n${newsSummary}`;

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت مستشار مالي ومحلل فني وأساسي لأسواق الأسهم الأمريكية. قم بتحليل المؤشرات الفنية والأخبار المرفقة واكتب تقريراً ورأياً استثمارياً بلهجة مصرية احترافية ومبسطة (Egyptian Arabic).`;

  const userPrompt = `
قم بتحليل صفقة سوينغ (Swing / Position Trade) لسهم ${data.symbol} بلهجة مصرية احترافية ومبسطة بناءً على البيانات الفنية والأساسية التالية:

- السهم: ${data.symbol}
- توصية النمط: ${data.action === 'BUY' ? 'شراء سوينغ (BUY)' : 'بيع / جني أرباح (SELL)'}
- السعر الحالي: $${formatPrice(data.entryPrice)}
- المتوسط المتحرك SMA 50: $${formatPrice(data.sma50)}
- خط MACD: ${formatPrice(data.macd)} (خط الإشارة: ${formatPrice(data.macdSignal)})
- Stop Loss: $${formatPrice(data.sl)}
- Take Profit: $${formatPrice(data.tp)}


أحدث عناوين الأخبار الخاصة بالسهم:
${newsSummary}

اكتب تحليلاً رزيناً يدمج بين النظرة الفنية والأخبار الأساسية، واشرح سبب الصفقة ولماذا المستويات المحددة ممتازة للاستثمار المتوسط أو الطويل الأجل.
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.6,
        max_tokens: 450,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || defaultFallback;
  } catch (error: any) {
    console.error('Error calling Groq API for swing analysis:', error?.response?.data || error?.message || error);
    return defaultFallback;
  }
}
