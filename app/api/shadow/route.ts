/**
 * Isolated shadow worker. Completely separate from /api/scalp.
 * Call it with the same scheduler that calls /api/scalp (e.g. every 5 minutes).
 */
import type { NextRequest } from 'next/server';
import { loadShadowEnv } from '@/lib/shadow/env';
import { EVALUATOR_VERSION, isShadowEnabled } from '@/lib/shadow/config';
import { runShadowCycle } from '@/lib/shadow/runner';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  loadShadowEnv();
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isShadowEnabled()) {
    return Response.json({ skipped: true, reason: 'SHADOW_ENABLED is false', evaluator_version: EVALUATOR_VERSION });
  }
  try {
    const report = await runShadowCycle();
    return Response.json({ ...report, evaluator_version: EVALUATOR_VERSION });
  } catch (error: any) {
    // Shadow errors must never break the main bot; they stay in this endpoint only.
    return Response.json({ error: error?.message || 'shadow cycle failed', evaluator_version: EVALUATOR_VERSION }, { status: 200 });
  }
}
