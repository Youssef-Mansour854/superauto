/**
 * ============================================================================
 * 📊 Account Configuration & Position Sizing Engine (CommonJS Runtime)
 * ============================================================================
 */

// ⚠️ PLACEHOLDER - يحتاج تحديث: رصيد الحساب الحالي (100$)
const ACCOUNT_BALANCE = 100;

// ⚠️ PLACEHOLDER - يحتاج تحديث: نسبة المخاطرة الافتراضية 1%
const RISK_PERCENT = 1.0;

// ⚠️ PLACEHOLDER - يحتاج تحديث: مواصفات الذهب
const CONTRACT_SIZE = 100;
const TICK_VALUE = 1.0;
const TICK_SIZE = 0.01;

const SYMBOL_SPECS = {
  'XAU/USD': {
    contractSize: CONTRACT_SIZE,
    tickValue: TICK_VALUE,
    tickSize: TICK_SIZE,
    minLot: 0.01,
    maxLot: 50.0,
    lotStep: 0.01
  },
  'QQQ': {
    contractSize: 1,
    tickValue: 0.01,
    tickSize: 0.01,
    minLot: 0.01,
    maxLot: 100.0,
    lotStep: 0.01
  },
  'EUR/USD': {
    contractSize: 100000,
    tickValue: 1.0,
    tickSize: 0.00001,
    minLot: 0.01,
    maxLot: 100.0,
    lotStep: 0.01
  }
};

function getLiveAccountBalance() {
  if (process.env.ACCOUNT_BALANCE) {
    const parsed = parseFloat(process.env.ACCOUNT_BALANCE);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return ACCOUNT_BALANCE;
}

function getLiveRiskPercent() {
  if (process.env.RISK_PERCENT) {
    const parsed = parseFloat(process.env.RISK_PERCENT);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return RISK_PERCENT;
}

function getSymbolSpec(symbol) {
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
  return SYMBOL_SPECS['XAU/USD'];
}

function calculatePositionSize(
  entryPrice,
  slPrice,
  accountBalance = getLiveAccountBalance(),
  riskPercent = getLiveRiskPercent(),
  contractSize = CONTRACT_SIZE
) {
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

  const lossPerOneLot = slDistance * contractSize;
  const rawLot = targetRiskUSD / lossPerOneLot;
  const roundedLot = Math.max(0.01, Math.round(rawLot * 100) / 100);

  const actualRiskUSD = Number((slDistance * contractSize * roundedLot).toFixed(2));
  const actualRiskPercent = Number(((actualRiskUSD / accountBalance) * 100).toFixed(2));

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

function calculatePnLUSD(pnlPoints, lotSize, contractSize = CONTRACT_SIZE) {
  return Number((pnlPoints * lotSize * contractSize).toFixed(2));
}

module.exports = {
  ACCOUNT_BALANCE,
  RISK_PERCENT,
  CONTRACT_SIZE,
  TICK_VALUE,
  TICK_SIZE,
  SYMBOL_SPECS,
  getLiveAccountBalance,
  getLiveRiskPercent,
  getSymbolSpec,
  calculatePositionSize,
  calculatePnLUSD
};
