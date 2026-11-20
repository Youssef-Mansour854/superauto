/** CLI: report | replay | backfill | health. Run through the npm scripts. */
import { loadShadowEnv } from '../lib/shadow/env';
import { EVALUATOR_VERSION, PARAMS_VERSION, STRATEGY_IDS, isShadowEnabled } from '../lib/shadow/config';
import { buildReport } from '../lib/shadow/report';
import { replayStrategy } from '../lib/shadow/replay';
import { backfillDays } from '../lib/shadow/runner';
import { connectToDatabase } from '../lib/mongodb';
import { ApiUsageLog, ShadowHealth } from '../lib/shadow/store';
import { utcDateKey } from '../lib/shadow/budget';

loadShadowEnv();

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true';
  }
  return out;
}

async function health(): Promise<void> {
  await connectToDatabase();
  const date = utcDateKey();
  const rows = await ShadowHealth.find({ date }).lean().catch(() => []) as any[];
  const usage = await ApiUsageLog.find({ date }).lean().catch(() => []) as any[];
  const credits = usage.reduce((s, r) => s + Number(r.credits || 0), 0);
  console.log('date(UTC)', date, '| SHADOW_ENABLED', isShadowEnabled(), '| credits', credits,
    '| evaluator', EVALUATOR_VERSION, '| params', PARAMS_VERSION);
  for (const id of STRATEGY_IDS) {
    const r = rows.find(x => x.strategy_id === id);
    console.log(`  ${id.padEnd(28)} signals=${r?.signals || 0} exits=${r?.exits || 0} errors=${r?.errorCount || 0} ambiguous=${r?.ambiguous || 0} credits=${r?.credits || 0}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'report';
  const o = args();
  if (command === 'health') return health();
  if (command === 'backfill') {
    const r = await backfillDays(Number(o.days || 30));
    console.log(JSON.stringify(r));
    return;
  }
  if (command === 'replay') {
    const strategy = o.strategy || 'orb_london';
    const from = o.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = o.to || new Date().toISOString().slice(0, 10);
    const replay = await replayStrategy(strategy, from, to);
    console.log(JSON.stringify(replay));
    const file = await buildReport({
      strategy, since: from, source: 'replay', split: 'test',
      outPath: o.out || `reports/shadow-replay-${strategy}-${to}.xlsx`
    });
    console.log('report:', file);
    return;
  }
  if (command === 'report') {
    const file = await buildReport({
      strategy: o.strategy || 'all',
      since: o.since,
      source: (o.source as 'live' | 'replay') || 'live',
      split: o.split === 'test' ? 'test' : undefined,
      outPath: o.out
    });
    console.log('report:', file);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch(e => {
    console.error('ERROR', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect().catch(() => undefined);
  });
