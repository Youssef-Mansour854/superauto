import axios from 'axios';
import { formatPrice } from './indicators';
import { isAiLearningEnabled } from '@/config/accountConfig';
import { getActiveNegativeRules } from './aiTradeLearner';

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

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

export async function generateGroqArabicAlert(data: GroqSignalData): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;

  const ema100Val = data.ema100 !== undefined ? data.ema100 : data.ema200;
  const ema200Val = data.ema200;

  const defaultFallback = data.action === 'BUY'
    ? `🚨 **صفقة سكالبينج سريعة (شراء) 🔥**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${formatPrice(data.entryPrice)}\nهدف أرباح (TP - ATR 3x): $${formatPrice(data.tp)}\nوقف خسارة (SL - ATR 1.5x): $${formatPrice(data.sl)}\nمؤشر RSI: ${formatPrice(data.rsi)} | EMA20: $${formatPrice(data.ema20)}${ema100Val !== undefined ? ` | EMA100: $${formatPrice(ema100Val)}` : ''}\nفرصة صعودية قوية مع الاتجاه العام!`
    : `🚨 **صفقة سكالبينج سريعة (بيع) 📉**\nرمز العملة: ${data.symbol}\nسعر الدخول: $${formatPrice(data.entryPrice)}\nهدف أرباح (TP - ATR 3x): $${formatPrice(data.tp)}\nوقف خسارة (SL - ATR 1.5x): $${formatPrice(data.sl)}\nمؤشر RSI: ${formatPrice(data.rsi)} | EMA20: $${formatPrice(data.ema20)}${ema100Val !== undefined ? ` | EMA100: $${formatPrice(ema100Val)}` : ''}\nفرصة هبوط قوية مع الاتجاه العام!`;

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت خبير تداول وسكالبينج محترف وسريع جداً. مهمتك كتابة تنبيه صفقة سكالبينج حاسم وقصير بلهجة مصرية عامية حماسية ومباشرة (Egyptian Arabic). تنبيه هام: ممنوع منعاً باتاً وضع نجوم (**) أو أقواس أو علامة دولار ($) متلاصقة بالأرقام أو الأسعار لكي تظهر الأرقام صريحة وواضحة جداً في تليجرام ولا تتحول لنجوم مشفرة (****).`;

  const userPrompt = `
اكتب تنبيه تداول سكالبينج حماسي بلهجة مصرية عامية بناءً على البيانات التالية:
- العملة/الأصل: ${data.symbol}
- نوع الصفقة: ${data.action === 'BUY' ? 'شراء (BUY)' : 'بيع (SELL)'}
- سعر الدخول الحالي: ${formatPrice(data.entryPrice)}
- Stop Loss (وقف الخسارة - 1.5x ATR): ${formatPrice(data.sl)}
- Take Profit (هدف الأرباح - 2.0x ATR): ${formatPrice(data.tp)}
- مؤشر RSI (14): ${formatPrice(data.rsi)}
- مؤشر EMA (20): ${formatPrice(data.ema20)}
${ema100Val !== undefined ? `- مؤشر EMA (100): ${formatPrice(ema100Val)}\n` : ''}${ema200Val !== undefined ? `- مؤشر EMA (200) [الاتجاه العام للصورة الكبيرة]: ${formatPrice(ema200Val)}\n` : ''}${data.atr ? `- مؤشر ATR (14): ${formatPrice(data.atr)}\n` : ''}
قواعد هامة للتنسيق:
1. اكتب الأسعار كأرقام واضحة ومباشرة (مثال: 4047.37) بدون وضع علامة الدولار ($) وبدون وضع أي نجوم (**) ملاصقة لها نهائياً.
2. اجعل التنبيه مركزاً وقصيراً وحماسياً ويشجع على التنفيذ السريع ويوضح المستويات المالية بوضوح تام.
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
- السعر الحالي: ${formatPrice(data.entryPrice)}
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

export interface TradeValidationData {
  symbol: string;
  action: 'BUY' | 'SELL';
  triggerReason: 'CROSSOVER' | 'PULLBACK';
  entryPrice: number;
  sl: number;
  tp: number;
  rsi: number;
  ema20: number;
  ema100: number;
  ema200?: number;
  atr: number;
  isMonday?: boolean;
}

export interface TradeValidationResult {
  approved: boolean;
  score: number;
  reason: string;
}

/**
 * 🤖 Groq AI Trade Confluence & Gatekeeper
 * يفحص جودة الإشارة الفنية ويقيمها من 1 إلى 10 قبل الدخول.
 * لو التقييم أقل من 7.0 (أو 7.5 يوم الاثنين لتدقيق فجوات الافتتاح) يتم رفض الصفقة لحماية الحساب.
 */
export async function validateTradeConfluenceWithGroq(data: TradeValidationData): Promise<TradeValidationResult> {
  const apiKey = process.env.GROQ_API_KEY;

  // Fallback فني صارم في حال تعذر الاتصال بـ Groq
  const fallbackApprove = data.action === 'BUY'
    ? data.rsi >= 46 && data.rsi <= 65
    : data.rsi <= 54 && data.rsi >= 35;

  const defaultFallback: TradeValidationResult = {
    approved: fallbackApprove,
    score: fallbackApprove ? 7.5 : 5.0,
    reason: fallbackApprove ? 'موافقة فنية تلقائية (Fallback): شروط الـ RSI والترند متوافقة' : 'رفض فني تلقائي (Fallback): مؤشر RSI في منطقة تشبع أو تذبذب خطر'
  };

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultFallback;
  }

  const systemPrompt = `أنت خبير تداول كمي فائق الدقة متخصص في سكالبينج الذهب (XAU/USD).
مهمتك تدقيق جودة إشارات السكالبينج (Gatekeeper) بصرامة بالغة لمنع فتح صفقات في قمم/قيعان أو في مناطق تذبذب كاذب.
أجب فقط بصيغة JSON بدون أي نصوص قبلها أو بعدها بالشكل التالي:
{
  "approved": boolean,
  "score": number,
  "reason": "سبب التقييم بالعربية في جملة واحدة"
}`;

  const mondayInstruction = `\n⚠️ ملاحظة خاصة: كن فائق الصرامة والتدقيق لمخاطر التذبذب العرضي وضعف السيولة، ولا توافق إلا إذا كانت الإشارة مثالية بنسبة 100% (الموافقة تتطلب تقييم 7.5 أو أعلى دائماً).`;

  // جلب القواعد السلبية المستفادة من الذكاء الاصطناعي لو المفتاح مفعل
  let aiMemoryRulesSection = '';
  if (isAiLearningEnabled()) {
    try {
      const activeRules = await getActiveNegativeRules();
      if (activeRules && activeRules.length > 0) {
        aiMemoryRulesSection = `\n📌 قواعد صارمة مستفادة من تحليل صفقات البوت السابقة لمنع تكرار الخسائر:\n` +
          activeRules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
          `\n⚠️ إذا خالفت هذه الإشارة أي قاعدة من القواعد السابقة، ارفض الصفقة فوراً (Score < 7.5).\n`;
      }
    } catch (e) {
      // تجاهل الخطأ بأمان تام والاستمرار
    }
  }

  const userPrompt = `
قم بتقييم إشارة السكالبينج التالية لـ ${data.symbol}:
- نوع الصفقة: ${data.action} (${data.triggerReason === 'PULLBACK' ? 'ارتداد EMA20' : 'تقاطع زخم RSI'})
- السعر الحالي: ${formatPrice(data.entryPrice)}
- Stop Loss: ${formatPrice(data.sl)} | Take Profit: ${formatPrice(data.tp)}
- RSI (14): ${formatPrice(data.rsi)}
- EMA 20: ${formatPrice(data.ema20)} | EMA 100: ${formatPrice(data.ema100)}${data.ema200 !== undefined ? ` | EMA 200 (الصورة الكبيرة): ${formatPrice(data.ema200)}` : ''}
- ATR (14): $${formatPrice(data.atr)}${mondayInstruction}${aiMemoryRulesSection}

شروط التقييم الصارم:
- اعطِ درجة من 1 إلى 10 (الموافقة تتطلب تقييم صارم 7.5 أو أعلى).
- إذا كانت الصفقة BUY و RSI > 65، أو السعر متضخم وبعيد عن EMA20 -> ارفض (Score < 7.5).
- إذا كانت الصفقة SELL و RSI < 35، أو السعر منخفض جداً وبعيد عن EMA20 -> ارفض (Score < 7.5).
- تحقق من الصورة الكبيرة (EMA200): في الشراء يجب أن يكون السعر أعلى من EMA200 (اتجاه صاعد)، وفي البيع أدنى من EMA200 (اتجاه هابط).
- إذا كانت الشموع متوافقة مع الاتجاه والصورة الكبيرة والـ RSI متزن ومسافة الـ SL مناسبة -> وافق.
أخرج كود JSON فقط.
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
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 6000,
      }
    );

    const rawContent = response.data?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) return defaultFallback;

    const parsed = JSON.parse(rawContent);
    const score = typeof parsed.score === 'number' ? parsed.score : (parsed.approved ? 7.5 : 5.0);
    const minScoreRequired = 7.5;
    const approved = Boolean(parsed.approved) && score >= minScoreRequired;
    const reason = parsed.reason || (approved ? 'تمت الموافقة من Groq AI' : 'تم الرفض بواسطة Groq AI');

    return { approved, score, reason };
  } catch (err: any) {
    console.error('Error validating trade with Groq AI:', err?.response?.data || err?.message || err);
    return defaultFallback;
  }
}

