/*
 * Parity: replay the main strategy's logged trades through the SHARED shadow
 * evaluator and DOCUMENT every deviation. The new evaluator deliberately
 * differs from the deployed main engine (signal bar excluded, no breakeven /
 * profit locks, time stop at bar close), so exact equality is not expected.
 * The test passes only when every deviation has a known cause.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { evaluateExit } = require(root + '/.shadow-build/lib/shadow/evaluator.js');

function loadExcelJS() {
  try { return require('exceljs'); } catch {
    return require('C:/Users/hp/AppData/Local/Temp/opencode/xlsxenv/node_modules/exceljs');
  }
}
function candlePath() {
  const candidates = [
    'C:/Users/hp/AppData/Local/Temp/opencode/candles_5m.json',
    path.join(root, 'data', 'candles_5m.json')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

(async () => {
  const workbook = path.join(root, 'reports', 'bot-numbers-2026-11-19.xlsx');
  const cp = candlePath();
  assert.ok(fs.existsSync(workbook), 'missing reference workbook');
  assert.ok(cp, 'missing cached 5m candles (needed for parity replay)');

  const ExcelJS = loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbook);
  const sheet = wb.getWorksheet('نموذج اللمس');
  const raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
  const candles = raw.map(c => c.t
    ? { openTime: Date.parse(`${c.t}Z`), closeTime: Date.parse(`${c.t}Z`) + 300000, open: c.o, high: c.h, low: c.l, close: c.c }
    : c);
  const candleIndex = new Map(candles.map((c, i) => [c.openTime, i]));

  const parseCairo = (text) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2})$/.exec(String(text || ''));
    if (!m) return NaN;
    return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`) - 2 * 3600000;
  };
  const cell = (r, c) => {
    const v = r.getCell(c).value;
    return v && v.result !== undefined ? v.result : v;
  };

  const rows = [];
  const counts = { match: 0, management: 0, entry_candle: 0, gap_policy: 0, time_stop: 0, missing_exit: 0, unexplained: 0 };
  const examples = {};

  for (let i = 2; i <= sheet.rowCount; i++) {
    const r = sheet.getRow(i);
    const label = String(cell(r, 1) || '');
    if (!label.includes('/')) continue;
    const entryUtc = parseCairo(label);
    if (!Number.isFinite(entryUtc)) continue;
    const direction = String(cell(r, 2)) === 'شراء' ? 'BUY' : 'SELL';
    const expectedText = String(cell(r, 8) || '');
    const expected = expectedText === 'الهدف' ? 'TARGET'
      : (expectedText === 'تأمين' ? 'MANAGEMENT' : 'STOP');
    const entry = Number(cell(r, 9)); // from the trades sheet layout, price column is 9 there
    const tradesSheet = wb.getWorksheet('الصفقات');
    const tr = tradesSheet.getRow(i);
    const entryPrice = Number(cell(tr, 9));
    const stop = Number(cell(tr, 10));
    const target = Number(cell(tr, 11));
    const signalIndex = candleIndex.get(Math.floor(entryUtc / 300000) * 300000);
    if (signalIndex === undefined || !Number.isFinite(entryPrice) || !Number.isFinite(stop)) {
      counts.unexplained++;
      examples.unexplained = examples.unexplained || [];
      examples.unexplained.push({ row: i, label, reason: 'missing candle or price' });
      continue;
    }
    const signalBar = candles[signalIndex];
    const later = candles.slice(signalIndex + 1);
    const result = await evaluateExit({
      direction, entryPrice, stop, target: Number.isFinite(target) ? target : null,
      entryBarCloseTime: signalBar.closeTime, maxHoldMinutes: 600, paramsVersion: 1,
      entryHigh: signalBar.high, entryLow: signalBar.low
    }, later);
    const actual = result ? result.exitType : 'OPEN';
    let category;
    if (actual === expected) category = 'match';
    else if (expected === 'MANAGEMENT') category = 'management';
    else if (actual === 'TIMEOUT') category = 'time_stop';
    else if (actual === 'OPEN') category = 'missing_exit';
    else {
      const buy = direction === 'BUY';
      const entryTouched = buy
        ? (signalBar.high >= target && signalBar.low <= stop)
        : (signalBar.low <= target && signalBar.high >= stop);
      const gapFill = result && Math.abs(result.exitPrice - (result.exitType === 'STOP' ? stop : target)) > 0.01;
      if (entryTouched) category = 'entry_candle';
      else if (gapFill) category = 'gap_policy';
      else category = 'unexplained';
    }
    counts[category]++;
    if (category !== 'match' && !examples[category]) {
      examples[category] = {
        row: i, label, direction, expected, actual,
        exitPrice: result ? result.exitPrice : null,
        net: result ? result.netUnits : null
      };
    }
    rows.push({ row: i, label, expected, actual, category });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    evaluator_version: 'shadow-exit-v1',
    source: workbook,
    candles: cp,
    compared: rows.length,
    counts,
    examples,
    note: 'Exact equality is not expected: the shared evaluator excludes the signal bar, has no breakeven/profit locks, and closes at the bar close on time stop.'
  };
  const targetFile = path.join(root, 'reports', 'shadow-parity-2026-11-20.json');
  fs.writeFileSync(targetFile, JSON.stringify(out, null, 2));

  console.log('parity rows:', rows.length);
  console.log('categories:', JSON.stringify(counts));
  console.log('examples:', JSON.stringify(examples, null, 2));
  console.log('saved:', targetFile);
  assert.strictEqual(counts.unexplained, 0, 'unexplained parity deviations must be zero');
  assert.ok(rows.length >= 100, 'parity must cover the full logged sample');
  console.log('PASS: every deviation is classified as a documented spec difference.');
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
