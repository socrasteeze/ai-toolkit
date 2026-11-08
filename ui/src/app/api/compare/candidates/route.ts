import { NextRequest, NextResponse } from 'next/server';
import { getTrainingFolder } from '@/server/settings';
import { resolveRunFolder } from '@/server/compare';
import { loadCandidates } from '@/server/royalCandidates';

// Fork-only (see FORK_NOTES.md). Checkpoint Compare: which saves the loss log recommends.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const run = request.nextUrl.searchParams.get('run');
    if (!run?.trim()) throw new Error('Pick a run.');
    const trainingRoot = await getTrainingFolder();
    return NextResponse.json(await loadCandidates(resolveRunFolder(run.trim(), trainingRoot), trainingRoot));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
