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
  /** المخاطرة المخططة بالدولار (المسافة من الدخول إلى الوقف 1.5×ATR) — لمقارنة الخسارة الفعلية بالمخططة */
  riskAmountUSD?: number;
  /** ATR عند الدخول — يُستخدم لتحديد مستوى الوقف الكارثي وتفسير تجاوز الوقف بدقة */
  atr?: number;
  /** مضاعف الوقف الكارثي (الذهب 3.0×ATR، QQQ 2.5×ATR) */
  hardStopMultiplier?: number;
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
    groqScore,
    atr,
    riskAmountUSD,
    hardStopMultiplier = 3.0
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

  // مقاييس مساعدة: المخاطرة بالنقاط، وحركة السعر كنسبة من R ومن مسافة الهدف
  const riskPoints = Math.abs(entryPrice - slPrice);
  const mfeR = riskPoints > 0 ? maxFavorablePoints / riskPoints : 0;
  const maeR = riskPoints > 0 ? maxDrawdownPoints / riskPoints : 0;
  const tpDistance = Math.abs(tpPrice - entryPrice);
  const mfePercentOfTp = tpDistance > 0 ? (maxFavorablePoints / tpDistance) * 100 : 0;
  const triggerLabel =
    triggerReason === 'CROSSOVER' ? 'تقاطع المتوسطات'
    : triggerReason === 'PULLBACK' ? 'ارتداد من المتوسطات'
    : triggerReason;
  const directionWord = action === 'BUY' ? 'الصعود' : 'الهبوط';

  // 2. تحليل سبب النتيجة بالتفصيل
  if (status === 'WIN') {
    const resultLine = `الربح الصافي: +${Math.abs(netPnLUSD).toFixed(2)}$, وأقصى ربح خلال الصفقة ${mfeR.toFixed(2)}R.`;
    if (maxDrawdownPoints <= 1.5) {
      outcomeReasonArabic = `🎯 نجاح مباشر: دخلت الصفقة بإشارة ${triggerLabel} في جلسة ${sessionName} وتحرّك السعر في اتجاه ${directionWord} حتى الهدف (${formatPrice(tpPrice)}) خلال ${durationMinutes} دقيقة، دون أي انعكاس يُذكر (أقصى انعكاس ${maxDrawdownPoints} نقطة = ${maeR.toFixed(2)}R). ${resultLine}`;
      postTradeLesson = `دخول بإشارة ${triggerLabel} في اتجاه ${directionWord} بجلسة ${sessionName} حقّق الهدف دون ضغط معاكس — هذه هي الصفقة النموذجية التي يجب تكرارها.`;
    } else {
      const absorbedPct = tpDistance > 0 ? (maxDrawdownPoints / tpDistance) * 100 : 0;
      outcomeReasonArabic = `🎯 نجاح بعد امتصاص التذبذب: واجهت الصفقة انعكاساً مؤقتاً بـ ${maxDrawdownPoints} نقطة (${maeR.toFixed(2)}R = ${absorbedPct.toFixed(0)}% من مسافة الهدف)، لكن الوقف المحسوب (${formatPrice(slPrice)}) استوعبه، ثم تحرّك السعر في اتجاه ${directionWord} حتى الهدف (${formatPrice(tpPrice)}) بعد ${durationMinutes} دقيقة. ${resultLine}`;
      postTradeLesson = `الوقف عند 1.5×ATR (${riskPoints.toFixed(2)} نقطة) استوعب انعكاساً بـ ${maeR.toFixed(2)}R قبل أن يتحقق الهدف — المخاطرة كانت مضبوطة ولم تُضطَر لإغلاق مبكر.`;
    }
  } else if (status === 'BREAKEVEN') {
    const exitMovePoints = action === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const capturedPercent = tpDistance > 0 ? (exitMovePoints / tpDistance) * 100 : 0;
    const netText = netPnLUSD >= 0
      ? `+${Math.abs(netPnLUSD).toFixed(2)}$`
      : `−${Math.abs(netPnLUSD).toFixed(2)}$ (بعد الفروق والعمولات)`;
    const isTrueBreakeven = exitMovePoints <= 0.75;

    if (isTrueBreakeven) {
      outcomeReasonArabic = `🛡️ تعادل مُدار (True Breakeven): تحرّكت الصفقة لصالحها حتى ${maxFavorablePoints} نقطة (${mfeR.toFixed(2)}R = ${mfePercentOfTp.toFixed(0)}% من مسافة الهدف) في جلسة ${sessionName}، فرفع البوت الوقف إلى نقطة الدخول (مع هامش بسيط) وتم الإغلاق عند (${formatPrice(exitPrice)}) بعد ${durationMinutes} دقيقة بصافي ${netText}.`;
      postTradeLesson = `تأمين الدخول منع تحوّل صفقة وصلت إلى ${mfePercentOfTp.toFixed(0)}% من الهدف إلى خسارة — لكن الربح لم يُقفل، فراجع آلية تتبع الوقف بعد 50% من الهدف.`;
    } else {
      const captured = Math.max(0, capturedPercent);
      const wasted = Math.max(0, mfePercentOfTp - captured);
      const wastedText = wasted >= 2
        ? `${wasted.toFixed(0)}% من الحركة ضاعت في الارتداد، وهي مساحة لتحسين تتبّع الوقف.`
        : `والربح المقفل جاء قريباً من أقصى حركة سجّلتها الصفقة.`;
      outcomeReasonArabic = `🔒 خروج بقفل ربح (Profit Lock): تحرّكت الصفقة لصالحها حتى ${maxFavorablePoints} نقطة (${mfeR.toFixed(2)}R = ${mfePercentOfTp.toFixed(0)}% من مسافة الهدف) في جلسة ${sessionName}، ثم ارتد السعر فأُغلق المركز عند الوقف المرفوع (${formatPrice(exitPrice)}) بعد ${durationMinutes} دقيقة، مقفلاً ${captured.toFixed(0)}% من مسافة الهدف بصافي ${netText}.`;
      postTradeLesson = `قفل الأرباح حوّل صفقة وصلت إلى ${mfePercentOfTp.toFixed(0)}% من الهدف إلى ربح محصّل ${netText} بدل التعادل — ${wastedText}`;
    }
  } else if (status === 'LOSS') {
    // مستوى الوقف الكارثي الفعلي = الدخول ∓ (مضاعف الوقف × ATR)
    const hardStopPrice = atr && atr > 0
      ? (action === 'BUY' ? entryPrice - atr * hardStopMultiplier : entryPrice + atr * hardStopMultiplier)
      : null;
    // مقدار تجاوز التنفيذ لمستوى الوقف (انزلاق أو فجوة سعرية)
    const overshootPts = hardStopPrice != null
      ? (action === 'BUY'
          ? Math.max(0, Number((hardStopPrice - exitPrice).toFixed(2)))
          : Math.max(0, Number((exitPrice - hardStopPrice).toFixed(2))))
      : 0;

    if (exitReason === 'HARD_STOP') {
      const hardStopText = hardStopPrice != null ? formatPrice(hardStopPrice) : formatPrice(slPrice);
      const realizedLoss = Math.abs(netPnLUSD);
      const plannedRisk = riskAmountUSD && riskAmountUSD > 0 ? riskAmountUSD : null;
      const multiple = plannedRisk ? realizedLoss / plannedRisk : null;
      outcomeReasonArabic = `🛑 خسارة عند الوقف الكارثي (Hard Stop ${hardStopMultiplier}×ATR): تحرّك السعر ضد الصفقة في جلسة ${sessionName} حتى اخترق الوقف الكارثي عند (${hardStopText})، فتم الإغلاق عند (${formatPrice(exitPrice)}) بعد ${durationMinutes} دقيقة. أقصى انعكاس ضد الصفقة: ${maxDrawdownPoints} نقطة، والخسارة الصافية: ${realizedLoss.toFixed(2)}$${plannedRisk ? ` (${multiple!.toFixed(2)}× المخاطرة المخططة البالغة ${plannedRisk.toFixed(2)}$)` : ''}.`;
      if (overshootPts > 0.3) {
        outcomeReasonArabic += ` ⚠️ التنفيذ جاء أسوأ من مستوى الوقف بـ ${overshootPts} نقطة (انزلاق/فجوة سعرية).`;
      }
      postTradeLesson = overshootPts > 0.3
        ? `قفزة سعرية تجاوزت الوقف الكارثي قبل التنفيذ؛ الانزلاق جعل الخسارة أكبر من المخاطرة المخططة.`
        : `الوقف الكارثي (${hardStopMultiplier}×ATR) أوقف الحركة عند حده، لكن الخسارة الفعلية تجاوزت المخاطرة المخططة (1.5×ATR) — هذا هو السيناريو الوحيد الذي يكسر سقف المخاطرة لكل صفقة.`;
    } else if (exitReason === 'TIMEOUT') {
      outcomeReasonArabic = `⏱️ خروج زمني (Time Stop): مرور ${durationMinutes} دقيقة في تذبذب عرضي ضعيف السيولة مع بقاء الصفقة في النطاق السلبي، فتم الإغلاق التلقائي عند (${formatPrice(exitPrice)}) لحماية الحساب من احتجاز رأس المال (خسارة ${Math.abs(netPnLUSD).toFixed(2)}$).`;
      postTradeLesson = `إغلاق الصفقات الراكدة يحمي المحفظة من الانفجارات السعرية المفاجئة في نهاية الجلسات.`;
    } else {
      // SOFT_STOP: الوقف المعتمد (1.5×ATR) يُنفَّذ عند إغلاق شمعة 5 دقائق خارجه
      const realizedLoss = Math.abs(netPnLUSD);
      const plannedRisk = riskAmountUSD && riskAmountUSD > 0 ? riskAmountUSD : null;
      const riskCompare = plannedRisk
        ? ` الخسارة الصافية: ${realizedLoss.toFixed(2)}$ مقابل مخاطرة مخططة ${plannedRisk.toFixed(2)}$`
        : ` الخسارة الصافية: ${realizedLoss.toFixed(2)}$`;
      outcomeReasonArabic = `🛑 خسارة عند وقف الخسارة (Soft Stop 1.5×ATR): أُغلقت شمعة 5 دقائق خارج الوقف (${formatPrice(slPrice)}) بعد ${durationMinutes} دقيقة، فنُفِّذ الإغلاق عند (${formatPrice(exitPrice)}) بعد أن بلغ أقصى انعكاس ضد الصفقة ${maxDrawdownPoints} نقطة.${riskCompare}.`;
      const excessPct = plannedRisk ? ((realizedLoss / plannedRisk - 1) * 100) : null;
      postTradeLesson = excessPct != null && excessPct > 15
        ? `الخسارة تجاوزت المخاطرة المخططة بنسبة ${excessPct.toFixed(0)}% — راجع الفروق والانزلاق على هذا الرمز.`
        : `الوقف نُفِّذ عند إغلاق الشمعة دون تجاوز مادي؛ الفرق الطفيف عن المخاطرة المخططة سببه الفروق والعمولات.`;
    }
  }

  return {
    maxDrawdownPoints,
    maxFavorablePoints,
    outcomeReasonArabic,
    postTradeLesson
  };
}
