/* Plain assert tests for the shared shadow evaluator and local indicators. */
const assert = require('assert');
const root = __dirname + '/..';
const { evaluateExit } = require(root + '/.shadow-build/lib/shadow/evaluator.js');
const { EVALUATOR_VERSION, COST_UNITS } = require(root + '/.shadow-build/lib/shadow/config.js');
const { atrWilder, rsi, ema, bollinger, buildIndicatorSet } = require(root + '/.shadow-build/lib/shadow/indicators.js');
const { resample } = require(root + '/.shadow-build/lib/shadow/resample.js');
const { getStrategy } = require(root + '/.shadow-build/lib/shadow/strategies/index.js');
const { buildContext } = require(root + '/.shadow-build/lib/shadow/engine.js');

const FIVE = 5 * 60 * 1000;
const T0 = Date.parse('2026-11-20T08:00:00Z');
let pass = 0;

function bar(i, o, h, l, c) {
  const openTime = T0 + i * FIVE;
  return { openTime, closeTime: openTime + FIVE, open: o, high: h, low: l, close: c };
}
function input(over = {}) {
  return Object.assign({
    direction: 'BUY', entryPrice: 100, stop: 95, target: 110,
    entryBarCloseTime: T0 + FIVE, maxHoldMinutes: 600,
    paramsVersion: 1, strategyId: 'test'
  }, over);
}
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  PASS', name);
}

(async () => {
  console.log('== ExitEvaluator', EVALUATOR_VERSION, '==');

  await check('target only', async () => {
    const r = await evaluateExit(input(), [bar(1, 100, 102, 99, 101), bar(2, 101, 111, 100, 110)]);
    assert.strictEqual(r.exitType, 'TARGET');
    assert.strictEqual(r.exitPrice, 110);
    assert.strictEqual(r.ambiguous, false);
    assert.strictEqual(r.resolvedBy, 'none');
    assert.strictEqual(r.netUnits, 9.7);
    assert.strictEqual(r.R, 1.94);
  });

  await check('stop only', async () => {
    const r = await evaluateExit(input(), [bar(1, 100, 101, 99, 100), bar(2, 99, 100, 94, 95)]);
    assert.strictEqual(r.exitType, 'STOP');
    assert.strictEqual(r.exitPrice, 95);
    assert.strictEqual(r.netUnits, -5.3);
  });

  await check('both in one bar -> assumed stop', async () => {
    let called = 0;
    const r = await evaluateExit(input(), [bar(1, 100, 111, 94, 105)], () => { called++; return null; });
    assert.strictEqual(r.exitType, 'STOP');
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.resolvedBy, 'assumed_stop');
    assert.strictEqual(called, 1);
  });

  await check('both in one bar -> 1m resolver target first', async () => {
    let seen = null;
    const r = await evaluateExit(input(), [bar(1, 100, 111, 94, 105)], (b, levels) => {
      seen = levels;
      return 'target';
    });
    assert.strictEqual(r.exitType, 'TARGET');
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.resolvedBy, '1m');
    assert.deepStrictEqual(seen, { stop: 95, target: 110, direction: 'BUY' });
  });

  await check('gap through stop fills at the open', async () => {
    const r = await evaluateExit(input(), [bar(1, 90, 92, 89, 91)]);
    assert.strictEqual(r.exitType, 'STOP');
    assert.strictEqual(r.exitPrice, 90);
    assert.strictEqual(r.netUnits, -10.3);
  });

  await check('gap through target fills at the target', async () => {
    const r = await evaluateExit(input(), [bar(1, 115, 116, 114, 115)]);
    assert.strictEqual(r.exitType, 'TARGET');
    assert.strictEqual(r.exitPrice, 110); // not 115: resting limit fills at its price
    assert.strictEqual(r.netUnits, 9.7);
  });

  await check('trailing stop is not applied on the same bar', async () => {
    const plan = { kind: 'chandelier', atr: 2, multiplier: 3, period: 55 };
    const bars = [
      bar(1, 100, 110, 96, 105), // would raise the stop to 104, but only after the close
      bar(2, 105, 106, 96, 100)  // old stop 95 and new stop 104 both touched; new stop must be active
    ];
    const r = await evaluateExit(input({ stopPlan: plan, target: null }), bars);
    assert.strictEqual(r.exitType, 'STOP');
    assert.strictEqual(r.exitPrice, 104);
  });

  await check('time stop exits at the bar close', async () => {
    const r = await evaluateExit(input({ target: null, maxHoldMinutes: 10 }),
      [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 98)]);
    assert.strictEqual(r.exitType, 'TIMEOUT');
    assert.strictEqual(r.exitPrice, 98);
    assert.strictEqual(r.durationMinutes, 10);
  });

  await check('flat cost is charged once', async () => {
    const r = await evaluateExit(input(), [bar(1, 100, 110, 99, 109)]);
    assert.strictEqual(r.costUnits, COST_UNITS);
    assert.strictEqual(r.grossUnits, 10);
    assert.strictEqual(r.netUnits, 10 - COST_UNITS);
  });

  await check('the signal bar is never evaluated for exit', async () => {
    const signalBar = bar(1, 100, 112, 90, 105); // touches both levels
    const r = await evaluateExit(input({ entryBarCloseTime: signalBar.closeTime }),
      [signalBar, bar(2, 105, 106, 104, 105)]);
    assert.strictEqual(r, null);
  });

  console.log('== Indicators / resampling ==');

  await check('Wilder ATR and RSI are causal', async () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 102 + i, 99 + i, 100 + i));
    const full = atrWilder(bars, 14);
    const shorter = atrWilder(bars.slice(0, 50), 14);
    assert.deepStrictEqual(full.slice(0, 50), shorter);
    const rs = rsi(bars.map(b => b.close), 14);
    assert.strictEqual(Number.isNaN(rs[0]), true);
    assert.strictEqual(Number.isFinite(rs[20]), true);
    const es = ema(bars.map(b => b.close), 20);
    assert.strictEqual(Number.isNaN(es[18]), true);
    assert.strictEqual(Number.isFinite(es[19]), true);
  });

  await check('Bollinger bands are computed locally', async () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);
    const bb = bollinger(closes, 20, 2);
    assert.strictEqual(Number.isFinite(bb.lower[19]), true);
    assert.ok(bb.lower[19] < bb.sma[19] && bb.upper[19] > bb.sma[19]);
  });

  await check('5m bars resample into 15m OHLC', async () => {
    const bars = [bar(0, 100, 105, 99, 102), bar(1, 102, 108, 101, 107), bar(2, 107, 109, 106, 108)];
    const m15 = resample(bars, 15);
    assert.strictEqual(m15.length, 1);
    assert.strictEqual(m15[0].open, 100);
    assert.strictEqual(m15[0].high, 109);
    assert.strictEqual(m15[0].low, 99);
    assert.strictEqual(m15[0].close, 108);
  });

  await check('onClosedBar is pure for a repeated identical context', async () => {
    const strategy = getStrategy('c0_random');
    const bars = Array.from({ length: 300 }, (_, i) => bar(i, 100 + (i % 7), 101 + (i % 7), 99 + (i % 7), 100 + (i % 7)));
    const ctx1 = buildContext('c0_random', bars, bars[bars.length - 1].closeTime, []);
    const ctx2 = buildContext('c0_random', bars, bars[bars.length - 1].closeTime, []);
    assert.deepStrictEqual(strategy.onClosedBar(ctx1), strategy.onClosedBar(ctx2));
  });

  console.log(`\n${pass} checks passed.`);
})().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
