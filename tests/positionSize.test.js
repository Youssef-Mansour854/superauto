const assert = require('assert');
const {
  calculatePositionSize,
  calculatePnLUSD,
  getSymbolSpec,
  ACCOUNT_BALANCE,
  RISK_PERCENT,
  CONTRACT_SIZE
} = require('../config/accountConfig');

console.log('====================================================');
console.log('   🧪 UNIT TEST: Position Sizing & PnL Engine       ');
console.log('====================================================');

// Test 1: Default Gold Position Size
console.log('\n[Test 1] Testing Default Gold Position Size (Balance: 10,000$, Risk: 1%, Contract: 100 oz)...');
const entry1 = 4396.04;
const sl1 = 4402.03; // Distance = 5.99 points
const res1 = calculatePositionSize(entry1, sl1, 10000, 1.0, 100);

console.log(`   SL Distance: ${res1.slDistance} pts`);
console.log(`   Risk Amount: $${res1.riskAmountUSD}`);
console.log(`   Calculated Lot Size: ${res1.lotSize} lots`);

// Math: 100 / (5.99 * 100) = 0.16694... -> 0.17 lots
assert.strictEqual(res1.lotSize, 0.17, 'Lot size should round to 0.17');
assert.strictEqual(res1.riskAmountUSD, 100, 'Risk amount should be 100$');
console.log('   ✅ Test 1 Passed: Exact lot size calculated and rounded accurately.');

// Test 2: Dynamic Account Balance Scaling
console.log('\n[Test 2] Testing Dynamic Account Balance Scaling (Balance: 50,000$, Risk: 1%, Distance: 10 pts)...');
const res2 = calculatePositionSize(2500, 2490, 50000, 1.0, 100);
// 50000 * 0.01 = 500$; 500 / (10 * 100) = 0.50 lots
console.log(`   Lot Size for $50k Account: ${res2.lotSize} lots`);
assert.strictEqual(res2.lotSize, 0.50, 'Lot size should be 0.50');
console.log('   ✅ Test 2 Passed: Dynamic balance scaling verified.');

// Test 3: Clamping to minimum lot size (0.01)
console.log('\n[Test 3] Testing Clamping for very wide stops / small balances...');
const res3 = calculatePositionSize(2500, 2000, 1000, 0.5, 100); // 5$ risk / 50000 = 0.0001 -> clamped to 0.01
console.log(`   Clamped Min Lot Size: ${res3.lotSize} lots`);
assert.strictEqual(res3.lotSize, 0.01, 'Minimum lot size should clamp to 0.01');
console.log('   ✅ Test 3 Passed: Clamping works properly.');

// Test 4: Real-Dollar PnL Calculations
console.log('\n[Test 4] Testing Real-Dollar PnL Calculation...');
const lot = 0.20;
const pnlWinPoints = 8.50; // +8.50 points gain on Gold
const pnlWinUSD = calculatePnLUSD(pnlWinPoints, lot, 100);
// 8.50 * 0.20 * 100 = 170.00$
assert.strictEqual(pnlWinUSD, 170.00, 'Profit in USD should be $170.00');
console.log(`   WIN PnL ($): +$${pnlWinUSD}`);

const pnlLossPoints = -5.00; // -5.00 points loss on Gold
const pnlLossUSD = calculatePnLUSD(pnlLossPoints, lot, 100);
// -5.00 * 0.20 * 100 = -100.00$
assert.strictEqual(pnlLossUSD, -100.00, 'Loss in USD should be -$100.00');
console.log(`   LOSS PnL ($): -$${Math.abs(pnlLossUSD)}`);

const pnlBEPoints = 0.00;
const pnlBEUSD = calculatePnLUSD(pnlBEPoints, lot, 100);
assert.strictEqual(pnlBEUSD, 0.00, 'Breakeven in USD should be $0.00');
console.log(`   BREAKEVEN PnL ($): $${pnlBEUSD}`);
console.log('   ✅ Test 4 Passed: Real-dollar PnL formulas verified.');

// Test 5: Symbol Specification Lookup
console.log('\n[Test 5] Testing Symbol Specification Lookup...');
const goldSpec = getSymbolSpec('XAU/USD');
assert.strictEqual(goldSpec.contractSize, 100, 'Gold contract size should be 100');
const qqqSpec = getSymbolSpec('QQQ');
assert.strictEqual(qqqSpec.contractSize, 1, 'QQQ contract size should be 1');
console.log('   ✅ Test 5 Passed: Symbol specifications mapped correctly.');

// Test 6: Small Account ($100) Clamping & Real Risk Warning Test
console.log('\n[Test 6] Testing $100 Small Account Risk Calculation & Warning...');
// Case 6A: 4.00 Points Stop Loss
console.log('   [Case 6A] Testing SL Distance = 4.00 pts (Entry: 2500, SL: 2496)...');
const res6A = calculatePositionSize(2500, 2496, 100, 1.0, 100);
console.log(`      - Clamped Lot Size: ${res6A.lotSize} lots (Raw: ${res6A.rawLotSize})`);
console.log(`      - Target Risk: $${res6A.targetRiskUSD} (${res6A.targetRiskPercent}%)`);
console.log(`      - Actual Risk: $${res6A.actualRiskUSD} (${res6A.actualRiskPercent}%)`);
console.log(`      - Has Warning: ${res6A.hasRiskWarning}`);
console.log(`      - Warning Msg: "${res6A.riskWarningMessage}"`);

assert.strictEqual(res6A.lotSize, 0.01, 'Lot size must clamp to 0.01');
assert.strictEqual(res6A.targetRiskUSD, 1.00, 'Target risk should be $1.00');
assert.strictEqual(res6A.actualRiskUSD, 4.00, 'Actual risk should be $4.00');
assert.strictEqual(res6A.actualRiskPercent, 4.00, 'Actual risk percent should be 4.00%');
assert.strictEqual(res6A.hasRiskWarning, true, 'Warning should be triggered (> 20% deviation)');
assert.ok(res6A.riskWarningMessage.includes('4%'), 'Warning message should contain actual risk 4%');

// Case 6B: 6.00 Points Stop Loss
console.log('   [Case 6B] Testing SL Distance = 6.00 pts (Entry: 2500, SL: 2494)...');
const res6B = calculatePositionSize(2500, 2494, 100, 1.0, 100);
console.log(`      - Clamped Lot Size: ${res6B.lotSize} lots (Raw: ${res6B.rawLotSize})`);
console.log(`      - Target Risk: $${res6B.targetRiskUSD} (${res6B.targetRiskPercent}%)`);
console.log(`      - Actual Risk: $${res6B.actualRiskUSD} (${res6B.actualRiskPercent}%)`);
console.log(`      - Has Warning: ${res6B.hasRiskWarning}`);
console.log(`      - Warning Msg: "${res6B.riskWarningMessage}"`);

assert.strictEqual(res6B.lotSize, 0.01, 'Lot size must clamp to 0.01');
assert.strictEqual(res6B.targetRiskUSD, 1.00, 'Target risk should be $1.00');
assert.strictEqual(res6B.actualRiskUSD, 6.00, 'Actual risk should be $6.00');
assert.strictEqual(res6B.actualRiskPercent, 6.00, 'Actual risk percent should be 6.00%');
assert.strictEqual(res6B.hasRiskWarning, true, 'Warning should be triggered (> 20% deviation)');
assert.ok(res6B.riskWarningMessage.includes('6%'), 'Warning message should contain actual risk 6%');
console.log('   ✅ Test 6 Passed: $100 Account risk calculation & warning messages verified.');

console.log('\n====================================================');
console.log('   🎉 ALL UNIT TESTS PASSED SUCCESSFULLY!          ');
console.log('====================================================');
