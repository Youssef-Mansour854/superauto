/**
 * Read-only review of the counterfactual (shadow) data.
 *
 * Every closed trade stores the result of several exit rule-sets replayed on
 * the same candles, so this report answers "what would X have done?" without
 * touching the live strategy.
 *
 * The deployed engine used to re-check a stop raised from a candle's extreme on
 * that same candle and fill immediately, which turned a profit lock into an
 * early limit exit. CURRENT reproduces that legacy behaviour; CURRENT_CLEAN
 * applies the same rules with the level active only from the next candle. The
 * gap between them is what that one bug cost.
 *
 * That bug is fixed (lib/exitEngine.ts, deployed 2026-11-15T23:43Z). Trades
 * closed after the deploy are judged by the touch engine, so the default
 * baseline moved to the deploy time: the verdict below is now about whether the
 * fixed model still holds on data it has never seen, not about whether to adopt
 * it. Shadow rows remain counterfactuals and never feed a trading decision.
 *
 * Usage: npm run shadow:report [-- --baseline=YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const f2 = n => `${n >= 0 ? '' : '-'}$${Math.abs(n).toFixed(2)}`;
const pct = n => `${(n * 100).toFixed(1)}%`;
const median = arr => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function argValue(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const MIN_SAMPLE = 25;
// The fix is an asymmetric option: it never lowers a stop level, so the check
// is "does it stay harmless while gaining on a minority of trades?" rather than
// "does it improve most trades?".
const MIN_MATERIAL_GAIN = 5;
const MIN_IMPROVED_TRADES = 5;

(async () => {
  loadEnv();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const all = await mongoose.connection.db
    .collection('detailed_trade_logs')
    .find({ shadowVariants: { $exists: true, $ne: [] } })
    .sort({ closedAt: 1 })
    .toArray();
  await mongoose.disconnect();

  // The trades used to discover the issue are training data; the verdict must
  // come from trades closed after the touch model went live (out-of-sample).
  const baseline = new Date(argValue('baseline', '2026-11-15T23:43:00Z'));
  const inSample = all.filter(t => new Date(t.closedAt) <= baseline);
  const outSample = all.filter(t => new Date(t.closedAt) > baseline);

  const describe = (set, label) => {
    if (set.length === 0) {
      console.log(`\n=== ${label} ===\n  no trades yet`);
      return null;
    }
    const totals = {};
    const mix = {};
    for (const t of set) {
      for (const v of t.shadowVariants) {
        totals[v.name] = (totals[v.name] || 0) + (v.netPnLUSD || 0);
        mix[v.name] = mix[v.name] || {};
        mix[v.name][v.exitKind] = (mix[v.name][v.exitKind] || 0) + 1;
      }
    }
    const pairs = set
      .map(t => ({
        t,
        faithful: t.shadowVariants.find(v => v.name === 'CURRENT'),
        clean: t.shadowVariants.find(v => v.name === 'CURRENT_CLEAN')
      }))
      .filter(p => p.faithful && p.clean);

    const deltas = pairs.map(p => p.clean.netPnLUSD - p.faithful.netPnLUSD);
    const improved = deltas.filter(d => d > 0.05);
    const worse = deltas.filter(d => d < -0.05);
    const gap = deltas.reduce((a, b) => a + b, 0);

    console.log(`\n=== ${label} (n=${set.length}) ===`);
    console.log(`  recorded net        ${f2(set.reduce((a, t) => a + (t.netPnLUSD || 0), 0))}`);
    console.log(`  current rules       ${f2(totals.CURRENT || 0)}  ${JSON.stringify(mix.CURRENT || {})}`);
    for (const [name, net] of Object.entries(totals)) {
      if (name === 'CURRENT') continue;
      const base = totals.CURRENT_CLEAN || 0;
      console.log(`  ${name.padEnd(18)} ${f2(net).padStart(10)}  vs clean ${f2(net - base).padStart(9)}  ${JSON.stringify(mix[name] || {})}`);
    }
    console.log(`\n  same-candle gap: ${f2(gap)} total | median ${f2(median(deltas))} | improved ${improved.length} (${pct(improved.length / pairs.length)}) | worse ${worse.length}`);
    if (improved.length + worse.length > 0) {
      const rows = pairs
        .map((p, i) => ({ ...p, delta: deltas[i] }))
        .filter(r => Math.abs(r.delta) > 0.05)
        .sort((a, b) => b.delta - a.delta);
      for (const r of rows) {
        console.log(`    ${r.t.entryCairoTime} ${r.t.action} ${f2(r.faithful.netPnLUSD).padStart(9)} -> ${f2(r.clean.netPnLUSD).padStart(9)} (${f2(r.delta)}) ${r.faithful.exitKind}@${r.faithful.minutesHeld}m -> ${r.clean.exitKind}@${r.clean.minutesHeld}m`);
      }
    }
    return { n: set.length, gap, medianGain: median(deltas), improved: improved.length, worse: worse.length, pairs: pairs.length };
  };

  console.log(`shadow records: ${all.length} | baseline ${baseline.toISOString()}`);
  describe(inSample, 'IN-SAMPLE (used to find the issue)');
  const out = describe(outSample, 'OUT-OF-SAMPLE (decides it)');

  const post = all.filter(t => t.postExit);
  if (post.length > 0) {
    const tpAfter = post.filter(t => t.postExit.tpHit).length;
    console.log(`\n=== POST-EXIT ===\n  original target reached within 180m after the exit: ${tpAfter}/${post.length} (${pct(tpAfter / post.length)})`);
  }

  console.log(`\n=== VERDICT (touch model on fresh data) ===`);
  if (!out || out.pairs < MIN_SAMPLE) {
    console.log(`  HOLD — ${out ? out.pairs : 0}/${MIN_SAMPLE} out-of-sample trades since the deploy. Keep collecting.`);
    return;
  }
  const improvedShare = out.improved / out.pairs;
  const harmless = out.worse === 0 && out.medianGain >= 0;
  const material = out.gap >= MIN_MATERIAL_GAIN && out.improved >= MIN_IMPROVED_TRADES;
  const passes = harmless && material;
  console.log(`  sample ${out.pairs}, improved ${pct(improvedShare)} (${out.improved} trades), median ${f2(out.medianGain)}, worse ${out.worse}, total ${f2(out.gap)}`);
  console.log(`  harmless=${harmless} material=${material}`);
  console.log(`  ${passes
    ? 'CONFIRMED — the fix still pays on trades it never saw. Keep it.'
    : 'REVIEW — on fresh data the fix is not clearly beneficial. The live journal is now the truth; revisit with a larger sample before touching rules again.'}`);
})().catch(e => {
  console.error('ERR', e.message);
  process.exit(1);
});
