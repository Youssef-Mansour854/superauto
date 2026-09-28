/**
 * ============================================================================
 * 📊 Account Configuration & Position Sizing Engine
 * ============================================================================
 * هذا الملف هو المصدر المركزي الوحيد لإعدادات الحساب وإدارة المخاطر.
 * أي تعديل في قيمة ACCOUNT_BALANCE أو RISK_PERCENT أو مواصفات العقد هنا
 * يطبق فورياً وتلقائياً على أي صفقة جديدة دون الحاجة لأي تعديل إضافي.
 */

// ============================================================================
// ⚠️ 1. رصيد الحساب الحالي (Account Balance in USD)
// ============================================================================
// PLACEHOLDER - يحتاج تحديث: رصيد الحساب اليدوي (تم تعديله إلى 100$)
// يدعم القراءة المباشرة من المتغير البيئي ACCOUNT_BALANCE في Vercel أو القيمة المكتوبة أدناه
export const ACCOUNT_BALANCE: number = 100; // ⚠️ PLACEHOLDER - يحتاج تحديث: رصيد الحساب الحالي (100$)

// ============================================================================
// ⚠️ 2. نسبة المخاطرة لكل صفقة (Risk Percentage per Trade)
// ============================================================================
// PLACEHOLDER - يحتاج تحديث: نسبة المخاطرة الافتراضية 1% من رأس المال لكل صفقة
export const RISK_PERCENT: number = 1.0; // ⚠️ PLACEHOLDER - يحتاج تحديث: افتراضي 1% (0.01)

// ============================================================================
// ⚠️ 3. مواصفات العقود وقيمة النقطة (Contract Size & Tick Value)
// ============================================================================
// PLACEHOLDER - يحتاج تحديث: قيم مؤقتة placeholder لحد ما تجيب الأرقام الحقيقية من MT5 Specification
export const CONTRACT_SIZE: number = 100; // ⚠️ PLACEHOLDER - يحتاج تحديث: 100 أونصة لكل 1 لوت ذهب
export const TICK_VALUE: number = 1.0;    // ⚠️ PLACEHOLDER - يحتاج تحديث: قيمة حركة 0.01 على 1 لوت كامل = 1$
export const TICK_SIZE: number = 0.01;    // ⚠️ PLACEHOLDER - يحتاج تحديث: أصغر حركة سعرية للذهب

export interface SymbolSpec {
  contractSize: number;
  tickValue: number;
  tickSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  estimatedSpreadPoints: number;   // فارق السبريد بالنقاط
  estimatedSlippagePoints: number; // الانزلاق السعري التقديري
  commissionPerLotUSD: number;     // عمولة اللوت الكامل (0 لحساب Standard)
}

export const SYMBOL_SPECS: Record<string, SymbolSpec> = {
  'XAU/USD': {
    contractSize: CONTRACT_SIZE, // 100
    tickValue: TICK_VALUE,       // 1.0
    tickSize: TICK_SIZE,         // 0.01
    minLot: 0.01,
    maxLot: 50.0,
    lotStep: 0.01,
    estimatedSpreadPoints: 0.25,   // 0.25$ فارق سبريد الذهب المعتاد
    estimatedSlippagePoints: 0.05, // 0.05$ انزلاق سعري تقديري
    commissionPerLotUSD: 0.0       // 0$ لحساب Standard (قابل للتعديل عبر env COMMISSION_PER_LOT)
  },
  'QQQ': {
    // Placeholder for Nasdaq ETF / CFDs
    contractSize: 1,
    tickValue: 0.01,
    tickSize: 0.01,
    minLot: 0.01,
    maxLot: 100.0,
    lotStep: 0.01,
    estimatedSpreadPoints: 0.05,
    estimatedSlippagePoints: 0.02,
    commissionPerLotUSD: 0.0
  },
  'EUR/USD': {
    // Standard Forex Lot
    contractSize: 100000,
    tickValue: 1.0,
    tickSize: 0.00001,
    minLot: 0.01,
    maxLot: 100.0,
    lotStep: 0.01,
    estimatedSpreadPoints: 0.00012, // 1.2 pips
    estimatedSlippagePoints: 0.00003, // 0.3 pips
    commissionPerLotUSD: 0.0
  }
};

/**
 * دالة مساعدة لجلب رصيد الحساب الفعلي:
 * تقرأ أولاً المتغير البيئي ACCOUNT_BALANCE في Vercel (إذا وُجد)،
 * وإلا تستخدم القيمة المحددة في هذا الملف تلقائياً.
 */
export function getLiveAccountBalance(): number {
  if (process.env.ACCOUNT_BALANCE) {
    const parsed = parseFloat(process.env.ACCOUNT_BALANCE);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return ACCOUNT_BALANCE;
}

/**
 * دالة مساعدة لجلب نسبة المخاطرة الفعلية
 */
export function getLiveRiskPercent(): number {
  if (process.env.RISK_PERCENT) {
    const parsed = parseFloat(process.env.RISK_PERCENT);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return RISK_PERCENT;
}

/**
 * جلب مواصفات الرمز
 */
export function getSymbolSpec(symbol: string): SymbolSpec {
  const norm = (symbol || '').toUpperCase().replace(/[\^=\-]/g, '');
  if (norm.includes('XAU') || norm.includes('GOLD') || norm.includes('GC')) {
    return SYMBOL_SPECS['XAU/USD'];
  }
  if (norm.includes('QQQ') || norm.includes('IXIC') || norm.includes('NAS')) {
    return SYMBOL_SPECS['QQQ'];
  }
  if (norm.includes('EUR')) {
    return SYMBOL_SPECS['EUR/USD'];
  }
  return SYMBOL_SPECS['XAU/USD']; // Default fallback to Gold
}

export interface PositionSizeResult {
  lotSize: number;
  rawLotSize: number;
  targetRiskUSD: number;
  actualRiskUSD: number;
  targetRiskPercent: number;
  actualRiskPercent: number;
  riskAmountUSD: number; // For backward compatibility (= actualRiskUSD)
  riskPercent: number;   // For backward compatibility (= targetRiskPercent)
  slDistance: number;
  contractSize: number;
  accountBalance: number;
  hasRiskWarning: boolean;
  riskWarningMessage: string;
}

/**
 * 2. دالة حساب حجم الصفقة التلقائي والمخاطرة الفعلية
 * تحسب حجم اللوت المطلوب بحيث لو الصفقة ضربت الوقف الأصلي
 * تكون الخسارة مساوية بالظبط لـ: accountBalance × (riskPercent / 100)
 * كما تحسب المخاطرة الفعلية الحقيقية الناتجة عن التقريب للحد الأدنى (0.01)
 *
 * @param entryPrice سعر الدخول للصفقة
 * @param slPrice سعر وقف الخسارة الأصلي
 * @param accountBalance رصيد الحساب بالدولار (افتراضي 100$)
 * @param riskPercent نسبة المخاطرة % (افتراضي 1%)
 * @param contractSize حجم العقد لكل 1 لوت (افتراضي 100 للذهب)
 * @returns تفاصيل حجم اللوت والمخاطرة المستهدفة والفعلية والتحذيرات
 */
export function calculatePositionSize(
  entryPrice: number,
  slPrice: number,
  accountBalance: number = getLiveAccountBalance(),
  riskPercent: number = getLiveRiskPercent(),
  contractSize: number = CONTRACT_SIZE
): PositionSizeResult {
  const slDistance = Math.abs(entryPrice - slPrice);
  const targetRiskUSD = Number((accountBalance * (riskPercent / 100)).toFixed(2));

  if (slDistance <= 0 || contractSize <= 0 || accountBalance <= 0) {
    return {
      lotSize: 0.01,
      rawLotSize: 0.01,
      targetRiskUSD,
      actualRiskUSD: 0,
      targetRiskPercent: riskPercent,
      actualRiskPercent: 0,
      riskAmountUSD: 0,
      riskPercent,
      slDistance,
      contractSize,
      accountBalance,
      hasRiskWarning: false,
      riskWarningMessage: ''
    };
  }

  // خسارة اللوت الكامل (1.00 لوت) عند ضرب الوقف = فارق السعر × حجم العقد
  const lossPerOneLot = slDistance * contractSize;

  // حجم اللوت النظري المطلوب = المبلغ المعرض للمخاطرة / خسارة اللوت الكامل
  const rawLot = targetRiskUSD / lossPerOneLot;

  // تقريب حجم اللوت لأقرب خطوة لوت (0.01) مع حده الأدنى 0.01
  const roundedLot = Math.max(0.01, Math.round(rawLot * 100) / 100);

  // حساب المخاطرة الفعلية الحقيقية الناتجة عن التقريب للحد الأدنى:
  // actualRiskPercent = (slDistance × contractSize × finalLotSize) / accountBalance × 100
  const actualRiskUSD = Number((slDistance * contractSize * roundedLot).toFixed(2));
  const actualRiskPercent = Number(((actualRiskUSD / accountBalance) * 100).toFixed(2));

  // التحقق مما إذا كانت المخاطرة الفعلية تختلف عن المستهدفة بأكثر من 20%
  // (مثلاً إذا كانت النسبة المستهدفة 1% والفعلية تجاوزت 1.2%)
  const hasRiskWarning = (actualRiskPercent - riskPercent) / riskPercent > 0.20;

  const riskWarningMessage = hasRiskWarning
    ? `⚠️ تحذير: المخاطرة الفعلية ${actualRiskPercent}% أعلى من المستهدف ${riskPercent}% بسبب الحد الأدنى للوت (0.01) — الإعدادات الحالية (Contract Size/Tick Value) لسه placeholder ومش دقيقة لحساب بهذا الحجم.`
    : '';

  return {
    lotSize: roundedLot,
    rawLotSize: Number(rawLot.toFixed(6)),
    targetRiskUSD,
    actualRiskUSD,
    targetRiskPercent: riskPercent,
    actualRiskPercent,
    riskAmountUSD: targetRiskUSD,
    riskPercent,
    slDistance: Number(slDistance.toFixed(4)),
    contractSize,
    accountBalance,
    hasRiskWarning,
    riskWarningMessage
  };
}

export interface PnLBreakdown {
  grossPnLUSD: number;
  tradingFeeUSD: number;
  netPnLUSD: number;
  spreadCostUSD: number;
  slippageCostUSD: number;
  commissionUSD: number;
}

/**
 * دالة مساعدة لحساب الربح أو الخسارة بالدولار مع احتساب تكاليف التداول (السبريد والعمولة والانزلاق):
 * - Gross PnL: الربح الإجمالي النظري المباشر من حركة السعر
 * - Trading Fee: مجموع السبريد + الانزلاق + عمولة البروكر
 * - Net PnL: الربح الصافي الفعلي بعد خصم كل التكاليف (المطابق لـ MT5)
 */
export function calculateDetailedPnL(
  pnlPoints: number,
  lotSize: number,
  symbol: string,
  isBreakeven: boolean = false
): PnLBreakdown {
  const spec = getSymbolSpec(symbol);
  const contractSize = spec.contractSize;

  // 1. Gross PnL (الربح الإجمالي النظري)
  const grossPnLUSD = isBreakeven ? 0 : Number((pnlPoints * lotSize * contractSize).toFixed(2));

  // 2. تكاليف التداول (السبريد + الانزلاق + العمولة)
  const envCommission = process.env.COMMISSION_PER_LOT ? parseFloat(process.env.COMMISSION_PER_LOT) : spec.commissionPerLotUSD;
  const envSpread = process.env.ESTIMATED_SPREAD_POINTS ? parseFloat(process.env.ESTIMATED_SPREAD_POINTS) : spec.estimatedSpreadPoints;

  const spreadCostUSD = Number((envSpread * lotSize * contractSize).toFixed(2));
  const slippageCostUSD = Number((spec.estimatedSlippagePoints * lotSize * contractSize).toFixed(2));
  const commissionUSD = Number((envCommission * lotSize).toFixed(2));

  const tradingFeeUSD = Number((spreadCostUSD + slippageCostUSD + commissionUSD).toFixed(2));

  // 3. Net PnL (الربح الصافي الفعلي)
  // في صفقات التعادل: تكون النتيجة سالب تكلفة السبريد والعمولة فقط (-0.30$)
  const netPnLUSD = Number((grossPnLUSD - tradingFeeUSD).toFixed(2));

  return {
    grossPnLUSD,
    tradingFeeUSD,
    netPnLUSD,
    spreadCostUSD,
    slippageCostUSD,
    commissionUSD
  };
}

/**
 * دالة مساعدة لحساب الربح أو الخسارة بالدولار الحقيقي
 * بناءً على: فرق السعر (pnlPoints) × حجم اللوت (lotSize) × حجم العقد (contractSize)
 */
export function calculatePnLUSD(
  pnlPoints: number,
  lotSize: number,
  contractSize: number = CONTRACT_SIZE
): number {
  return Number((pnlPoints * lotSize * contractSize).toFixed(2));
}
