import { formatPrice } from './indicators';

export interface TradeDiagnosisInput {
  action: 'BUY' | 'SELL';
  status: 'WIN' | 'LOSS' | 'BREAKEVEN';
  exitReason: 'TAKE_PROFIT' | 'SOFT_STOP' | 'HARD_STOP' | 'BREAKEVEN' | 'FRIDAY_CLOSE' | 'TIMEOUT';
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  pnlPoints: number;
  netPnLUSD: number;
  durationMinutes: number;
  highestHighDuringTrade?: number;
  lowestLowDuringTrade?: number;
  rsi?: number;
  exitRsi?: number;
  sessionName?: string;
  triggerReason?: string;
  groqScore?: number;
}

export interface TradeDiagnosisResult {
  maxDrawdownPoints: number;
  maxFavorablePoints: number;
  outcomeReasonArabic: string;
  postTradeLesson: string;
}

/**
 * 🔍 التشخيص الجنائي الفني والكمي لأسباب نجاح أو خسارة أو تعادل الصفقة
 */
export function diagnoseTradeOutcome(input: TradeDiagnosisInput): TradeDiagnosisResult {
  const {
    action,
    status,
    exitReason,
    entryPrice,
    exitPrice,
    slPrice,
    tpPrice,
    pnlPoints,
    netPnLUSD,
    durationMinutes,
    highestHighDuringTrade = entryPrice,
    lowestLowDuringTrade = entryPrice,
    rsi,
    exitRsi,
    sessionName = 'GLOBAL',
    triggerReason = 'PULLBACK',
    groqScore
  } = input;

  // 1. حساب أقصى انعكاس سلبي (Max Drawdown) وأقصى تحرك إيجابي (Max Favorable Excursion)
  let maxDrawdownPoints = 0;
  let maxFavorablePoints = 0;

  if (action === 'BUY') {
    maxDrawdownPoints = Math.max(0, Number((entryPrice - lowestLowDuringTrade).toFixed(2)));
    maxFavorablePoints = Math.max(0, Number((highestHighDuringTrade - entryPrice).toFixed(2)));
  } else {
    maxDrawdownPoints = Math.max(0, Number((highestHighDuringTrade - entryPrice).toFixed(2)));
    maxFavorablePoints = Math.max(0, Number((entryPrice - lowestLowDuringTrade).toFixed(2)));
  }

  let outcomeReasonArabic = '';
  let postTradeLesson = '';

  // 2. تحليل سبب النتيجة بالتفصيل
  if (status === 'WIN') {
    if (maxDrawdownPoints <= 1.5) {
      outcomeReasonArabic = `🎯 نجاح مثالي ومباشر: تحرك السعر بقوة مع اتجاه الزخم نحو الهدف (${formatPrice(tpPrice)}) دون أي انعكاس يذكر ضد الصفقة (أقصى انعكاس كان ${maxDrawdownPoints} نقطة فقط). تم تحقيق الهدف كاملاً خلال ${durationMinutes} دقيقة بربح صافي +${netPnLUSD.toFixed(2)}$`;
      postTradeLesson = `توافق الدخول من ارتداد نظيف مع ترند قوي يمنح نسبة دقة مرتفعة وانزلاق سعري منعدم.`;
    } else {
      outcomeReasonArabic = `🎯 نجاح بعد امتصاص التذبذب: واجهت الصفقة انعكاساً مؤقتاً بـ ${maxDrawdownPoints} نقطة لكن وقف الخسارة المحسوب (${formatPrice(slPrice)}) استوعب التذبذب بنجاح، ليعاود السعر الصعود بقوة ويحقق الهدف (${formatPrice(tpPrice)}) بعد ${durationMinutes} دقيقة.`;
      postTradeLesson = `تحديد الستوب بناءً على (1.5x ATR) أثبت كفاءته في حماية الصفقة من التذبذبات الطبيعية قبل بلوغ الهدف.`;
    }
  } else if (status === 'BREAKEVEN') {
    outcomeReasonArabic = `🛡️ خروج آمن بتأمين الدخول (Breakeven): السعر قطع أكثر من 50% من المسافة نحو الهدف وحقق تحركاً إيجابياً بـ +${maxFavorablePoints} نقطة، فقام قاطع الحماية بنقل الستوب لنقطة الدخول. ارتداد السعر لاحقاً أخرج الصفقة بربح رمزي (+${netPnLUSD.toFixed(2)}$) وحمى الحساب من انعكاس السوق.`;
    postTradeLesson = `نظام تأمين الأرباح عند 50% منع تحول صفقة كانت رابحة إلى خسارة رأس مال.`;
  } else if (status === 'LOSS') {
    if (exitReason === 'HARD_STOP') {
      outcomeReasonArabic = `🛑 خسارة بسبب ذيل شمعة عنيف (Flash Wick): تعرض السوق لتقلب مفاجئ سريع في جلسة ${sessionName} كسر ذيل الشمعة الوقف (${formatPrice(slPrice)}) بأقصى انعكاس بلغ ${maxDrawdownPoints} نقطة، مما أدى لخسارة (${Math.abs(netPnLUSD).toFixed(2)}$).`;
      postTradeLesson = `الخسارة ناتجة عن تقلب سعري حاد ومفاجئ، وقطع الخسارة الميكانيكي حمى الحساب من انهيار أكبر.`;
    } else if (exitReason === 'TIMEOUT') {
      outcomeReasonArabic = `⏱️ خروج زمني (Time Stop): مرور 120 دقيقة في تذبذب عرضي ضعيف السيولة مع بقاء الصفقة في النطاق السلبي، فتم الإغلاق التلقائي لحماية الحساب من احتجاز رأس المال.`;
      postTradeLesson = `إغلاق الصفقات الراكدة يحمي المحفظة من الانفجارات السعرية المفاجئة في نهاية الجلسات.`;
    } else {
      outcomeReasonArabic = `🛑 خسارة بكسر الاتجاه (Soft Stop): أغلقت شمعة 5 دقائق متجاوزة مستوى الوقف (${formatPrice(slPrice)}) بعد تراجع زخم مؤشر الـ RSI إلى (${exitRsi ? exitRsi.toFixed(1) : 'مستوى ضعيف'})، فقام البوت بتنفيذ الوقف المعتمد بخسارة (${Math.abs(netPnLUSD).toFixed(2)}$).`;
      postTradeLesson = `التزام صارم بإدارة المخاطر بإغلاق الصفقة فور تأكيد الكسر دون أي مكابرة.`;
    }
  }

  return {
    maxDrawdownPoints,
    maxFavorablePoints,
    outcomeReasonArabic,
    postTradeLesson
  };
}
