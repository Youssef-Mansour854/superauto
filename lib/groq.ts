import axios from 'axios';

export interface GroqSignalData {
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  rsi: number;
  ema20: number;
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

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'groq/compound-mini';

export async function generateGroqArabicAlert(data: GroqSignalData): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;

  const defaultFallback = data.action === 'BUY'
    ? `🚨 **صفقة سكالبينج سريعة (شراء) 🔥**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${data.entryPrice.toFixed(2)}\nهدف أرباح (TP): $${data.tp.toFixed(2)}\nوقف خسارة (SL): $${data.sl.toFixed(2)}\nمؤشر RSI: ${data.rsi.toFixed(1)} | EMA20: $${data.ema20.toFixed(2)}\nفرصة صعودية قوية جداً الآن!`
    : `🚨 **صفقة سكالبينج سريعة (بيع) 📉**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${data.entryPrice.toFixed(2)}\nهدف أرباح (TP): $${data.tp.toFixed(2)}\nوقف خسارة (SL): $${data.sl.toFixed(2)}\nمؤشر RSI: ${data.rsi.toFixed(1)} | EMA20: $${data.ema20.toFixed(2)}\nفرصة هبوط وسكالبينج حاسمة!`;

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت خبير تداول وسكالبينج محترف وسريع جداً. مهمتك كتابة تنبيه صفقة سكالبينج حاسم وقصير بلهجة مصرية عامية حماسية ومباشرة (Egyptian Arabic).`;

  const userPrompt = `
اكتب تنبيه تداول سكالبينج حماسي بلهجة مصرية عامية بناءً على البيانات التالية:
- العملة/الأصل: ${data.symbol}
- نوع الصفقة: ${data.action === 'BUY' ? 'شراء (BUY)' : 'بيع (SELL)'}
- سعر الدخول الحالي: $${data.entryPrice.toFixed(2)}
- Stop Loss (وقف الخسارة): $${data.sl.toFixed(2)}
- Take Profit (هدف الأرباح): $${data.tp.toFixed(2)}
- مؤشر RSI (14): ${data.rsi.toFixed(2)}
- مؤشر EMA (20): $${data.ema20.toFixed(2)}

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
    `**سعر الدخول:** $${data.entryPrice.toFixed(2)}\n` +
    `**وقف الخسارة (SL):** $${data.sl.toFixed(2)}\n` +
    `**الهدف الاستثماري (TP):** $${data.tp.toFixed(2)}\n` +
    `**المؤشرات الفنية:** SMA(50)=$${data.sma50.toFixed(2)} | MACD=${data.macd.toFixed(2)}\n\n` +
    `**أهم الأخبار:**\n${newsSummary}`;

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت مستشار مالي ومحلل فني وأساسي لأسواق الأسهم الأمريكية. قم بتحليل المؤشرات الفنية والأخبار المرفقة واكتب تقريراً ورأياً استثمارياً بلهجة مصرية احترافية ومبسطة (Egyptian Arabic).`;

  const userPrompt = `
قم بتحليل صفقة سوينغ (Swing / Position Trade) لسهم ${data.symbol} بلهجة مصرية احترافية ومبسطة بناءً على البيانات الفنية والأساسية التالية:

- السهم: ${data.symbol}
- توصية النمط: ${data.action === 'BUY' ? 'شراء سوينغ (BUY)' : 'بيع / جني أرباح (SELL)'}
- السعر الحالي: $${data.entryPrice.toFixed(2)}
- المتوسط المتحرك SMA 50: $${data.sma50.toFixed(2)}
- خط MACD: ${data.macd.toFixed(2)} (خط الإشارة: ${data.macdSignal.toFixed(2)})
- Stop Loss: $${data.sl.toFixed(2)}
- Take Profit: $${data.tp.toFixed(2)}

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
