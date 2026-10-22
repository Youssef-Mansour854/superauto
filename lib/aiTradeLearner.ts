import axios from 'axios';
import { connectToDatabase } from './mongodb';
import AiTradeMemory, { IAiTradeMemory } from '@/models/AiTradeMemory';

export interface RawTradeRecord {
  symbol?: string;
  action?: 'BUY' | 'SELL';
  entryPrice?: number;
  exitPrice?: number;
  sl?: number;
  tp?: number;
  status: string; // 'WIN' | 'LOSS' | 'BREAKEVEN'
  pnlUSD?: number;
  netPnLUSD?: number;
  rsi?: number;
  ema20?: number;
  ema100?: number;
  atr?: number;
  durationMin?: number;
  openedAt?: string | Date;
  closedAt?: string | Date;
}

export interface StatisticalBreakdown {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePercent: number;
  totalPnLUSD: number;
  profitFactor: number;
  avgWinUSD: number;
  avgLossUSD: number;
  bySession: {
    asian: { total: number; wins: number; losses: number; wr: number; pnl: number };
    london: { total: number; wins: number; losses: number; wr: number; pnl: number };
    newYork: { total: number; wins: number; losses: number; wr: number; pnl: number };
    lateNight: { total: number; wins: number; losses: number; wr: number; pnl: number };
  };
  byDayOfWeek: Record<string, { total: number; wins: number; losses: number; wr: number; pnl: number }>;
  byAction: {
    BUY: { total: number; wins: number; wr: number; pnl: number };
    SELL: { total: number; wins: number; wr: number; pnl: number };
  };
  byRsiBracket: Record<string, { total: number; wins: number; wr: number }>;
  worstLosses: any[];
  bestWins: any[];
}

export interface AiLearningResult {
  stats: StatisticalBreakdown;
  toxicPatterns: string[];
  winningPatterns: string[];
  negativeRules: string[];
  summaryArabic: string;
}

// In-memory cache for active rules to prevent repeated MongoDB lookups during live ticks
let cachedNegativeRules: { rules: string[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * حساب الإحصائيات الكمية المتقدمة لصفقات البوت
 */
export function computeTradeStatistics(trades: RawTradeRecord[]): StatisticalBreakdown {
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnLUSD = 0;
  let totalGrossWins = 0;
  let totalGrossLosses = 0;

  const sessionBuckets = {
    asian: { total: 0, wins: 0, losses: 0, wr: 0, pnl: 0 },
    london: { total: 0, wins: 0, losses: 0, wr: 0, pnl: 0 },
    newYork: { total: 0, wins: 0, losses: 0, wr: 0, pnl: 0 },
    lateNight: { total: 0, wins: 0, losses: 0, wr: 0, pnl: 0 },
  };

  const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const dayBuckets: Record<string, { total: number; wins: number; losses: number; wr: number; pnl: number }> = {};
  dayNames.forEach(d => {
    dayBuckets[d] = { total: 0, wins: 0, losses: 0, wr: 0, pnl: 0 };
  });

  const actionBuckets = {
    BUY: { total: 0, wins: 0, wr: 0, pnl: 0 },
    SELL: { total: 0, wins: 0, wr: 0, pnl: 0 },
  };

  const rsiBuckets: Record<string, { total: number; wins: number; wr: number }> = {
    '< 40 (Oversold)': { total: 0, wins: 0, wr: 0 },
    '40 - 48 (Bearish/Pullback)': { total: 0, wins: 0, wr: 0 },
    '48 - 55 (Neutral/Mid)': { total: 0, wins: 0, wr: 0 },
    '55 - 62 (Bullish/Pullback)': { total: 0, wins: 0, wr: 0 },
    '> 62 (Overbought)': { total: 0, wins: 0, wr: 0 },
  };

  trades.forEach(t => {
    const pnl = t.netPnLUSD ?? t.pnlUSD ?? 0;
    const isWin = t.status === 'WIN';
    const isLoss = t.status === 'LOSS';
    const isBe = t.status === 'BREAKEVEN';

    totalTrades++;
    totalPnLUSD += pnl;

    if (isWin) {
      wins++;
      totalGrossWins += pnl;
    } else if (isLoss) {
      losses++;
      totalGrossLosses += Math.abs(pnl);
    } else if (isBe) {
      breakeven++;
    }

    // Sessions and Days (Cairo Time = UTC + 2 or + 3, standardizing on UTC+3 for analysis)
    const rawDate = t.openedAt || t.closedAt;
    if (rawDate) {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        const cairoH = (d.getUTCHours() + 3) % 24;
        const dayIdx = d.getUTCDay();
        const dayName = dayNames[dayIdx] || 'أخرى';

        if (dayBuckets[dayName]) {
          dayBuckets[dayName].total++;
          dayBuckets[dayName].pnl += pnl;
          if (isWin) dayBuckets[dayName].wins++;
          if (isLoss) dayBuckets[dayName].losses++;
        }

        let sKey: keyof typeof sessionBuckets = 'asian';
        if (cairoH >= 9 && cairoH < 15) sKey = 'london';
        else if (cairoH >= 15 && cairoH < 22) sKey = 'newYork';
        else if (cairoH >= 22 || cairoH < 0) sKey = 'lateNight';

        sessionBuckets[sKey].total++;
        sessionBuckets[sKey].pnl += pnl;
        if (isWin) sessionBuckets[sKey].wins++;
        if (isLoss) sessionBuckets[sKey].losses++;
      }
    }

    // Action
    const act = t.action === 'BUY' ? 'BUY' : 'SELL';
    actionBuckets[act].total++;
    actionBuckets[act].pnl += pnl;
    if (isWin) actionBuckets[act].wins++;

    // RSI Bracket
    if (typeof t.rsi === 'number') {
      let rKey = '48 - 55 (Neutral/Mid)';
      if (t.rsi < 40) rKey = '< 40 (Oversold)';
      else if (t.rsi < 48) rKey = '40 - 48 (Bearish/Pullback)';
      else if (t.rsi <= 55) rKey = '48 - 55 (Neutral/Mid)';
      else if (t.rsi <= 62) rKey = '55 - 62 (Bullish/Pullback)';
      else rKey = '> 62 (Overbought)';

      rsiBuckets[rKey].total++;
      if (isWin) rsiBuckets[rKey].wins++;
    }
  });

  // Calculate Win Rates & Profit Factor
  const winRatePercent = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const profitFactor = totalGrossLosses > 0 ? Number((totalGrossWins / totalGrossLosses).toFixed(2)) : totalGrossWins > 0 ? 99 : 0;
  const avgWinUSD = wins > 0 ? Number((totalGrossWins / wins).toFixed(2)) : 0;
  const avgLossUSD = losses > 0 ? Number((totalGrossLosses / losses).toFixed(2)) : 0;

  (Object.keys(sessionBuckets) as (keyof typeof sessionBuckets)[]).forEach(k => {
    const s = sessionBuckets[k];
    s.wr = s.total > 0 ? Number(((s.wins / s.total) * 100).toFixed(1)) : 0;
    s.pnl = Number(s.pnl.toFixed(2));
  });

  Object.keys(dayBuckets).forEach(k => {
    const d = dayBuckets[k];
    d.wr = d.total > 0 ? Number(((d.wins / d.total) * 100).toFixed(1)) : 0;
    d.pnl = Number(d.pnl.toFixed(2));
  });

  (Object.keys(actionBuckets) as (keyof typeof actionBuckets)[]).forEach(k => {
    const a = actionBuckets[k];
    a.wr = a.total > 0 ? Number(((a.wins / a.total) * 100).toFixed(1)) : 0;
    a.pnl = Number(a.pnl.toFixed(2));
  });

  Object.keys(rsiBuckets).forEach(k => {
    const r = rsiBuckets[k];
    r.wr = r.total > 0 ? Number(((r.wins / r.total) * 100).toFixed(1)) : 0;
  });

  // Worst losses and Best wins
  const sortedByLoss = [...trades].sort((a, b) => ((a.netPnLUSD ?? a.pnlUSD ?? 0) - (b.netPnLUSD ?? b.pnlUSD ?? 0)));
  const worstLosses = sortedByLoss.filter(t => (t.netPnLUSD ?? t.pnlUSD ?? 0) < 0).slice(0, 5);
  const bestWins = [...trades].sort((a, b) => ((b.netPnLUSD ?? b.pnlUSD ?? 0) - (a.netPnLUSD ?? a.pnlUSD ?? 0))).slice(0, 5);

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRatePercent,
    totalPnLUSD: Number(totalPnLUSD.toFixed(2)),
    profitFactor,
    avgWinUSD,
    avgLossUSD,
    bySession: sessionBuckets,
    byDayOfWeek: dayBuckets,
    byAction: actionBuckets,
    byRsiBracket: rsiBuckets,
    worstLosses,
    bestWins,
  };
}

/**
 * تحليل الصفقات بواسطة Groq AI واستخراج القواعد المانعة للأخطاء المكررة
 */
export async function analyzeTradesWithAi(
  trades: RawTradeRecord[],
  sourceLabel: 'HISTORICAL_FILES' | 'LIVE_DATABASE' | 'HYBRID' = 'LIVE_DATABASE'
): Promise<AiLearningResult> {
  const stats = computeTradeStatistics(trades);

  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

  const defaultResult: AiLearningResult = {
    stats,
    toxicPatterns: [
      'التداول في أوقات التذبذب المنخفض وضعف السيولة',
      'الدخول في صفقات شراء عندما يكون مؤشر RSI في مناطق تشبع شرائي (>62)',
      'صفقات بيع بعد حركات هبوط حادة وممتدة بعيداً عن EMA20',
    ],
    winningPatterns: [
      'صفقات ارتداد ترند لندن ونيويورك متوافقة مع اتجاه EMA100',
      'الدخول عند عودة السعر لاختبار EMA20 مع RSI متزن (48-55)',
    ],
    negativeRules: [
      'ارفض صفقات BUY إذا كان RSI أكبر من 62 لتفادي الشراء في القمم',
      'ارفض صفقات SELL إذا كان RSI أقل من 36 لتفادي البيع في القيعان',
      'ارفض الدخول أثناء فترات ضعف السيولة إذا كانت مسافة الـ SL أكبر من 1.8x ATR',
    ],
    summaryArabic: `تم تحليل ${stats.totalTrades} صفقة. نسبة الفوز الإجمالية: ${stats.winRatePercent}% وصافي الأرباح: $${stats.totalPnLUSD}. معامل الربح: ${stats.profitFactor}.`,
  };

  if (!apiKey || apiKey.includes('your_groq_api_key')) {
    return defaultResult;
  }

  const systemPrompt = `أنت خبير تدقيق كمي ومخاطر مالية (Senior Quantitative Trading Auditor) متخصص في سكالبينج الذهب (XAU/USD).
مهمتك دراسة الإحصائيات والأخطاء لصفقات البوت واستخراج:
1. "toxicPatterns": الأنماط السامة المسببة للخسارة.
2. "winningPatterns": الأنماط الأقوى ربحية واستقراراً.
3. "negativeRules": 3 إلى 5 قواعد قاطعة ومحددة باللغة العربية يتبعها الـ Gatekeeper لمنع فتح صفقات تشبه الصفقات الخاسرة (مثل: "ارفض صفقات BUY إذا كان RSI > 60 في جلسة معينة").
4. "summaryArabic": ملخص تنفيذي احترافي ودقيق.
أجب بصيغة JSON فقط:
{
  "toxicPatterns": [string],
  "winningPatterns": [string],
  "negativeRules": [string],
  "summaryArabic": string
}`;

  const promptContent = `
بيانات تحليل صفقات البوت الحالية:
- إجمالي الصفقات: ${stats.totalTrades} (رابحة: ${stats.wins} | خاسرة: ${stats.losses} | تعادل: ${stats.breakeven})
- نسبة الفوز (Win Rate): ${stats.winRatePercent}%
- صافي الأرباح (Net PnL): $${stats.totalPnLUSD}
- معامل الربح (Profit Factor): ${stats.profitFactor}
- متوسط الربح: $${stats.avgWinUSD} | متوسط الخسارة: $${stats.avgLossUSD}

أداء الجلسات (بتوقيت القاهرة):
- آسيا (00:00 - 08:59): ${stats.bySession.asian.total} صفقة | فوز: ${stats.bySession.asian.wr}% | ربح: $${stats.bySession.asian.pnl}
- لندن (09:00 - 14:59): ${stats.bySession.london.total} صفقة | فوز: ${stats.bySession.london.wr}% | ربح: $${stats.bySession.london.pnl}
- نيويورك (15:00 - 21:59): ${stats.bySession.newYork.total} صفقة | فوز: ${stats.bySession.newYork.wr}% | ربح: $${stats.bySession.newYork.pnl}
- وقت متأخر (22:00 - 23:59): ${stats.bySession.lateNight.total} صفقة | فوز: ${stats.bySession.lateNight.wr}% | ربح: $${stats.bySession.lateNight.pnl}

أداء الشراء والبيع:
- شراء (BUY): ${stats.byAction.BUY.total} صفقة | فوز: ${stats.byAction.BUY.wr}% | ربح: $${stats.byAction.BUY.pnl}
- بيع (SELL): ${stats.byAction.SELL.total} صفقة | فوز: ${stats.byAction.SELL.wr}% | ربح: $${stats.byAction.SELL.pnl}

أداء مؤشر RSI:
${Object.entries(stats.byRsiBracket).map(([k, v]) => `- ${k}: ${v.total} صفقة | نسبة الفوز: ${v.wr}%`).join('\n')}

أداء أيام الأسبوع:
${Object.entries(stats.byDayOfWeek).filter(([_, v]) => v.total > 0).map(([k, v]) => `- ${k}: ${v.total} صفقة | فوز: ${v.wr}% | ربح: $${v.pnl}`).join('\n')}

استخرج القواعد الحاسمة لمنع التكرار بصيغة JSON.
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptContent }
        ],
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        stats,
        toxicPatterns: Array.isArray(parsed.toxicPatterns) ? parsed.toxicPatterns : defaultResult.toxicPatterns,
        winningPatterns: Array.isArray(parsed.winningPatterns) ? parsed.winningPatterns : defaultResult.winningPatterns,
        negativeRules: Array.isArray(parsed.negativeRules) ? parsed.negativeRules : defaultResult.negativeRules,
        summaryArabic: parsed.summaryArabic || defaultResult.summaryArabic,
      };
    }
  } catch (err: any) {
    console.error('Error generating AI Trade Learning analysis with Groq:', err?.response?.data || err?.message || err);
  }

  return defaultResult;
}

/**
 * حفظ تقرير الدروس المستفادة في MongoDB وتحديث الذاكرة الحية
 */
export async function saveLearnedMemory(
  learningResult: AiLearningResult,
  source: 'HISTORICAL_FILES' | 'LIVE_DATABASE' | 'HYBRID' = 'LIVE_DATABASE'
): Promise<IAiTradeMemory | null> {
  try {
    await connectToDatabase();

    // Deactivate previous active memories to keep only the freshest lessons active
    await AiTradeMemory.updateMany({ isActive: true }, { $set: { isActive: false } });

    const newMemory = await AiTradeMemory.create({
      createdAt: new Date(),
      source,
      totalTradesAnalyzed: learningResult.stats.totalTrades,
      winRate: learningResult.stats.winRatePercent,
      netPnLUSD: learningResult.stats.totalPnLUSD,
      profitFactor: learningResult.stats.profitFactor,
      toxicPatterns: learningResult.toxicPatterns,
      winningPatterns: learningResult.winningPatterns,
      negativeRules: learningResult.negativeRules,
      summaryArabic: learningResult.summaryArabic,
      isActive: true,
    });

    // Update in-memory cache immediately
    cachedNegativeRules = {
      rules: learningResult.negativeRules,
      timestamp: Date.now(),
    };

    return newMemory;
  } catch (err) {
    console.error('Failed to save learned memory to MongoDB:', err);
    return null;
  }
}

/**
 * جلب القواعد السلبية النشطة للـ Gatekeeper من الكاش أو من الداتابيز
 */
export async function getActiveNegativeRules(): Promise<string[]> {
  try {
    const now = Date.now();
    if (cachedNegativeRules && (now - cachedNegativeRules.timestamp) < CACHE_TTL_MS) {
      return cachedNegativeRules.rules;
    }

    await connectToDatabase();
    const activeDoc = await AiTradeMemory.findOne({ isActive: true }).sort({ createdAt: -1 });
    if (activeDoc && activeDoc.negativeRules && activeDoc.negativeRules.length > 0) {
      cachedNegativeRules = {
        rules: activeDoc.negativeRules,
        timestamp: now,
      };
      return activeDoc.negativeRules;
    }
  } catch (err) {
    console.error('Error retrieving active negative rules:', err);
  }

  return [];
}
