/**
 * ============================================================================
 * 🥇 Gold Precision Scalper Strategy Engine v2.0 (XAU/USD)
 * ============================================================================
 * تم بناء هذه الاستراتيجية بناءً على التدقيق الكمي لـ 349 صفقة حقيقية للبوت.
 * تضم:
 * 1. فلاتر الدخول الذهبية الخمسة (The 5 Golden Entry Gates)
 * 2. نظام خطف الأرباح الذكي والتريلينج المتدرج (Dynamic Profit-Lock & Momentum Exit)
 */

export interface GoldTradeSignalInput {
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  rsi?: number;
  ema20?: number;
  ema200?: number;
  atr?: number;
  timestamp?: Date | string;
}

export interface GateValidationResult {
  approved: boolean;
  score: number;
  blockedBy?: string;
  reasons: string[];
}

export interface DynamicExitState {
  shouldExitNow: boolean;
  exitType: 'TP' | 'SL' | 'DYNAMIC_LOCK' | 'MOMENTUM_SNATCH' | 'HOLD';
  targetExitPrice: number;
  lockedProfitPoints: number;
  reason: string;
}

export type GoldStrategyMode = 'STRICT_4_PER_DAY' | 'ACTIVE_6_PER_DAY';

export interface StrategyConfig {
  mode: GoldStrategyMode;
  maxEmaDistRatio: number;
  maxAtr: number;
  buyRsiMin: number;
  buyRsiMax: number;
  sellRsiMin: number;
  sellRsiMax: number;
  allowHour21: boolean;
  allowThuHour18: boolean;
}

export const STRATEGY_PRESETS: Record<GoldStrategyMode, StrategyConfig> = {
  // 1. الوضع الصارم (متوسط 4 صفقات يومياً)
  STRICT_4_PER_DAY: {
    mode: 'STRICT_4_PER_DAY',
    maxEmaDistRatio: 0.65,
    maxAtr: 6.5,
    buyRsiMin: 48,
    buyRsiMax: 62,
    sellRsiMin: 36,
    sellRsiMax: 55,
    allowHour21: false,
    allowThuHour18: false
  },
  // 2. الوضع النشط المتوازن (متوسط 6 صفقات يومياً بجودة عالية)
  ACTIVE_6_PER_DAY: {
    mode: 'ACTIVE_6_PER_DAY',
    maxEmaDistRatio: 0.88,
    maxAtr: 7.0,
    buyRsiMin: 44,
    buyRsiMax: 65,
    sellRsiMin: 35,
    sellRsiMax: 58,
    allowHour21: true,      // الساعة 21:00 أثبتت تاريخياً نسبة فوز 57.1% وربح إيجابي
    allowThuHour18: true   // الساعة 18:00 يوم الخميس أثبتت تاريخياً نسبة فوز 66.7%
  }
};

// الإعداد الافتراضي الحالي (يمكن تغييره عبر المتغير البيئي GOLD_STRATEGY_MODE)
export const CURRENT_GOLD_MODE: GoldStrategyMode =
  (process.env.GOLD_STRATEGY_MODE as GoldStrategyMode) || 'ACTIVE_6_PER_DAY';

// ----------------------------------------------------------------------------
// 1. فحص التوقيت والأيام (Time & Session Gates - توقيت القاهرة)
// ----------------------------------------------------------------------------
export function checkGoldTimeGate(
  dateInput: Date | string = new Date(),
  config: StrategyConfig = STRATEGY_PRESETS[CURRENT_GOLD_MODE]
): { allowed: boolean; reason?: string } {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return { allowed: true };

  const cairoHour = (d.getUTCHours() + 3) % 24;
  const cairoMinute = d.getUTCMinutes();
  const dayIdx = d.getUTCDay(); // 0 Sun, 1 Mon, 2 Tue, 3 Wed, 4 Thu, 5 Fri, 6 Sat

  // 1. حظر الجمعة الكامل (الجمعة مسؤولة عن أكبر نزيف أسبوعي)
  if (dayIdx === 5) {
    return { allowed: false, reason: 'حظر الجمعة الكامل: تقلبات إغلاق الأسبوع وسحب السيولة' };
  }

  // 2. حظر عطلة نهاية الأسبوع
  if (dayIdx === 0 || dayIdx === 6) {
    return { allowed: false, reason: 'السوق مغلق (عطلة نهاية الأسبوع)' };
  }

  // 3. قاعدة الخميس الذكية: إيقاف التداول بعد 14:30 بتوقيت القاهرة مع استثناء نافذة 18:00 المربحة لو مفعلة
  if (dayIdx === 4) {
    if (cairoHour > 14 || (cairoHour === 14 && cairoMinute >= 30)) {
      if (!(config.allowThuHour18 && cairoHour === 18)) {
        return { allowed: false, reason: 'حظر فترة بعد الظهر ليوم الخميس (بيانات البطالة وافتتاح نيويورك)' };
      }
    }
  }

  // 4. الساعات السامة اليومية (Toxic Hours):
  // 09:00 - 09:59 (افتتاح بورصات أوروبا وتضارب الطلبات)
  if (cairoHour === 9) {
    return { allowed: false, reason: 'الساعة السامة 09:00: افتتاح أوروبا والتذبذب المفاجئ' };
  }

  // 20:00 (انسحاب سيولة نيويورك)
  if (cairoHour === 20) {
    return { allowed: false, reason: 'الساعة السامة 20:00: ضعف سيولة المساء الأمريكي' };
  }

  // 21:00 (محظورة في الوضع الصارم، ومسموحة في وضع الـ 6 صفقات لأنها تاريخياً 57% فوز)
  if (cairoHour === 21 && !config.allowHour21) {
    return { allowed: false, reason: 'الساعة 21:00: محظورة في الوضع الصارم' };
  }

  return { allowed: true };
}

// ----------------------------------------------------------------------------
// 2. فلاتر الدخول الصارمة (The 5 Golden Pre-Trade Filters)
// ----------------------------------------------------------------------------
export function validateGoldSignalV2(
  input: GoldTradeSignalInput,
  config: StrategyConfig = STRATEGY_PRESETS[CURRENT_GOLD_MODE]
): GateValidationResult {
  const reasons: string[] = [];

  // أ. فحص التوقيت
  const timeGate = checkGoldTimeGate(input.timestamp || new Date(), config);
  if (!timeGate.allowed) {
    return {
      approved: false,
      score: 1.0,
      blockedBy: 'TIME_GATE',
      reasons: [timeGate.reason || 'مرفوض بتوقيت الجلسة']
    };
  }

  // ب. قفل الترند العام (EMA 200) - الشرط الذي حقق 77% فوز في الصفقات الحقيقية
  if (typeof input.ema200 === 'number' && input.ema200 > 0) {
    if (input.action === 'BUY' && input.entryPrice < input.ema200) {
      return {
        approved: false,
        score: 3.0,
        blockedBy: 'EMA200_TREND',
        reasons: [`رفض شراء: السعر ($${input.entryPrice.toFixed(2)}) أسفل خط EMA200 ($${input.ema200.toFixed(2)}) - عكس الاتجاه العام`]
      };
    }
    if (input.action === 'SELL' && input.entryPrice > input.ema200) {
      return {
        approved: false,
        score: 3.0,
        blockedBy: 'EMA200_TREND',
        reasons: [`رفض بيع: السعر ($${input.entryPrice.toFixed(2)}) أعلى خط EMA200 ($${input.ema200.toFixed(2)}) - عكس الاتجاه العام`]
      };
    }
  }

  // ج. قفل مؤشر RSI الذهبي
  if (typeof input.rsi === 'number') {
    // حظر الشراء تحت 40 (أثبتت خسارة 100%)
    if (input.action === 'BUY') {
      if (input.rsi < config.buyRsiMin) {
        return {
          approved: false,
          score: 2.0,
          blockedBy: 'RSI_TOO_LOW',
          reasons: [`رفض شراء قاطع: RSI = ${input.rsi.toFixed(1)} أقل من ${config.buyRsiMin}`]
        };
      }
      if (input.rsi > config.buyRsiMax) {
        return {
          approved: false,
          score: 4.0,
          blockedBy: 'RSI_OVERBOUGHT',
          reasons: [`رفض شراء: RSI = ${input.rsi.toFixed(1)} متضخم فوق ${config.buyRsiMax}`]
        };
      }
    } else if (input.action === 'SELL') {
      if (input.rsi > config.sellRsiMax) {
        return {
          approved: false,
          score: 2.0,
          blockedBy: 'RSI_OVERBOUGHT_SELL',
          reasons: [`رفض بيع: RSI = ${input.rsi.toFixed(1)} مرتفع فوق ${config.sellRsiMax}`]
        };
      }
      if (input.rsi < config.sellRsiMin) {
        return {
          approved: false,
          score: 4.0,
          blockedBy: 'RSI_OVERSOLD',
          reasons: [`رفض بيع: RSI = ${input.rsi.toFixed(1)} منخفض جداً تحت ${config.sellRsiMin}`]
        };
      }
    }
  }

  // د. قفل ارتداد EMA20 (منع مطاردة الشموع الممتدة)
  if (typeof input.ema20 === 'number' && typeof input.atr === 'number' && input.atr > 0) {
    const distFromEma = Math.abs(input.entryPrice - input.ema20);
    const maxAllowedDist = input.atr * config.maxEmaDistRatio;
    if (distFromEma > maxAllowedDist) {
      return {
        approved: false,
        score: 4.5,
        blockedBy: 'EMA20_CHASE',
        reasons: [`رفض مطاردة: السعر مبتعد عن EMA20 بـ $${distFromEma.toFixed(2)} (أقصى مسموح $${maxAllowedDist.toFixed(2)})`]
      };
    }
  }

  // هـ. سقف التقلب المفرط (ATR Cap)
  if (typeof input.atr === 'number' && input.atr > config.maxAtr) {
    return {
      approved: false,
      score: 3.5,
      blockedBy: 'ATR_TOO_HIGH',
      reasons: [`رفض تقلب عالي: ATR = ${input.atr.toFixed(2)} أكبر من ${config.maxAtr} (انزلاقات سعرية خطرة)`]
    };
  }

  reasons.push(`✅ متوافق مع كافة شروط القناص الذهبي v2 (وضع: ${config.mode})`);
  return {
    approved: true,
    score: 9.0,
    reasons
  };
}

// ----------------------------------------------------------------------------
// 3. محرك خطف الأرباح الذكي والتريلينج المتدرج أثناء الصفقة (Intra-Trade Engine)
// ----------------------------------------------------------------------------
export interface TradeCurrentProgress {
  action: 'BUY' | 'SELL';
  entryPrice: number;
  initialSl: number;
  initialTp: number;
  currentPrice: number;
  highestPriceSeen: number; // أعلى سعر وصل له السعر في مسار الشراء
  lowestPriceSeen: number;  // أدنى سعر وصل له السعر في مسار البيع
  atr: number;
  currentRsi?: number;
  hasRejectionCandle?: boolean; // شمعة ذات ذيل رفض معاكس
}

export function evaluateDynamicTradeManagement(state: TradeCurrentProgress): DynamicExitState {
  const isBuy = state.action === 'BUY';
  const totalTargetPoints = Math.abs(state.initialTp - state.entryPrice);
  const currentFloatingPoints = isBuy ? (state.currentPrice - state.entryPrice) : (state.entryPrice - state.currentPrice);
  const maxFloatingPoints = isBuy ? (state.highestPriceSeen - state.entryPrice) : (state.entryPrice - state.lowestPriceSeen);
  const progressRatio = totalTargetPoints > 0 ? (maxFloatingPoints / totalTargetPoints) : 0;

  // 1. تحقق الهدف الكامل (Full TP Hit)
  if (isBuy && state.currentPrice >= state.initialTp) {
    return {
      shouldExitNow: true,
      exitType: 'TP',
      targetExitPrice: state.initialTp,
      lockedProfitPoints: totalTargetPoints,
      reason: '🎯 تم تحقيق الهدف الاستثماري الكامل (Full TP)'
    };
  }
  if (!isBuy && state.currentPrice <= state.initialTp) {
    return {
      shouldExitNow: true,
      exitType: 'TP',
      targetExitPrice: state.initialTp,
      lockedProfitPoints: totalTargetPoints,
      reason: '🎯 تم تحقيق الهدف الاستثماري الكامل (Full TP)'
    };
  }

  // 2. مهارة "خطف الربح الفوري" عند فقدان الزخم وارتداد الشموع (Momentum Snatch)
  // إذا حققت الصفقة على الأقل 50% من الهدف (أو أكثر من 1.2x ATR) وظهرت شمعة رفض أو تشبع عكسي
  if (progressRatio >= 0.50 || currentFloatingPoints >= (state.atr * 1.2)) {
    const isExhaustedRsi = isBuy ? (state.currentRsi && state.currentRsi >= 68) : (state.currentRsi && state.currentRsi <= 32);
    if (state.hasRejectionCandle || isExhaustedRsi) {
      // السعر بدأ يتراجع بمقدار 20% عن أقصى قمة حققها
      const retracementPoints = maxFloatingPoints - currentFloatingPoints;
      if (retracementPoints >= (maxFloatingPoints * 0.20)) {
        return {
          shouldExitNow: true,
          exitType: 'MOMENTUM_SNATCH',
          targetExitPrice: state.currentPrice,
          lockedProfitPoints: currentFloatingPoints,
          reason: `⚡ خطف الربح فوراً ($+${currentFloatingPoints.toFixed(2)}): ظهور ضعف وزخم عكسي مع ذيل رفض بعد تقدم ممتاز`
        };
      }
    }
  }

  // 3. التريلينج ستوب المتدرج الذكي (Stepped Profit Lock)
  let lockedProfitPoints = 0;
  if (progressRatio >= 0.85) {
    // تقدم 85% -> حجز 70% من أقصى ربح
    lockedProfitPoints = maxFloatingPoints * 0.70;
  } else if (progressRatio >= 0.70) {
    // تقدم 70% -> حجز 50% من أقصى ربح
    lockedProfitPoints = maxFloatingPoints * 0.50;
  } else if (progressRatio >= 0.50) {
    // تقدم 50% -> حجز 30% من أقصى ربح
    lockedProfitPoints = Math.max(state.atr * 0.5, maxFloatingPoints * 0.30);
  } else if (progressRatio >= 0.35) {
    // تقدم 35% -> نقل الوقف لنقطة الدخول (Risk-Free Breakeven)
    lockedProfitPoints = 0.5; // تأمين تكلفة السبريد فقط
  }

  if (lockedProfitPoints > 0) {
    const dynamicSlPrice = isBuy
      ? (state.entryPrice + lockedProfitPoints)
      : (state.entryPrice - lockedProfitPoints);

    // هل السعر الحالي كسر الوقف المتحرك المحجوز؟
    const isLockHit = isBuy ? (state.currentPrice <= dynamicSlPrice) : (state.currentPrice >= dynamicSlPrice);
    if (isLockHit) {
      return {
        shouldExitNow: true,
        exitType: 'DYNAMIC_LOCK',
        targetExitPrice: dynamicSlPrice,
        lockedProfitPoints,
        reason: `🔒 إغلاق بتأمين الأرباح المتدرج: تم حجز $+${lockedProfitPoints.toFixed(2)} نقطة كاش بعد ارتداد السعر`
      };
    }
  }

  // 4. وقف الخسارة الأصلي (Hard / Soft SL)
  const isOriginalSlHit = isBuy ? (state.currentPrice <= state.initialSl) : (state.currentPrice >= state.initialSl);
  if (isOriginalSlHit) {
    return {
      shouldExitNow: true,
      exitType: 'SL',
      targetExitPrice: state.initialSl,
      lockedProfitPoints: -Math.abs(state.entryPrice - state.initialSl),
      reason: '🛑 ضرب وقف الخسارة الأصلي (Stop Loss)'
    };
  }

  return {
    shouldExitNow: false,
    exitType: 'HOLD',
    targetExitPrice: state.currentPrice,
    lockedProfitPoints: 0,
    reason: 'الصفقة مستمرة في المسار الطبيعي'
  };
}
