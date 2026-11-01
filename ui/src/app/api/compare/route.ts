import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getTrainingFolder } from '@/server/settings';
import { getCompareOutputFolder, setCompareOutputFolder } from '@/server/compareOutput';
import { resolveEngine } from '@/server/inferenceEngine';
import { getImageDimensions } from '@/server/imageSize';
import {
  bucketFor,
  buildPlan,
  listCheckpoints,
  listReferences,
  listRunFolders,
  promoteCheckpoint,
  promoteDest,
  promotedName,
  readCaption,
  readRunInfo,
  resolveReference,
  resolveRunFolder,
  validateOutputFolder,
} from '@/server/compare';
import { cancelRender, getJob, readScores, scoreKey, startRender } from '@/server/compareRun';

// Fork-only (see FORK_NOTES.md). Checkpoint Compare: run info, render state, promote.
export const dynamic = 'force-dynamic';

const fail = (e: any, status = 400) => NextResponse.json({ error: e?.message || String(e) }, { status });

const loadRun = async (run: unknown) => {
  if (typeof run !== 'string' || !run.trim()) throw new Error('Pick a run.');
  const trainingRoot = await getTrainingFolder();
  return readRunInfo(resolveRunFolder(run.trim(), trainingRoot), trainingRoot, await getCompareOutputFolder());
};

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  try {
    const run = q.get('run');
    if (!run) {
      return NextResponse.json({
        runs: listRunFolders(await getTrainingFolder()),
        outputFolder: await getCompareOutputFolder(),
      });
    }
    const info = await loadRun(run);
    const rel = q.get('reference');
    if (rel) {
      const full = resolveReference(info, rel);
      const size = await getImageDimensions(full);
      if (!size) throw new Error("Could not read that image's size.");
      return NextResponse.json({
        caption: readCaption(full),
        bucket: bucketFor(size.width, size.height, info.resolution, info.divisibility),
      });
    }
    return NextResponse.json({
      runName: info.runName,
      arch: info.arch,
      supported: info.supported,
      hasTrigger: !!info.trigger,
      blockedDatasets: info.blockedDatasets,
      outputDir: info.outputDir,
      promoteFolder: info.supported ? path.dirname(promoteDest(info.arch, info.runName, info.runName)) : null,
      sample: info.sample,
      checkpoints: listCheckpoints(info.folder).map(c => ({ file: c.file, label: c.label })),
      references: listReferences(info),
    });
  } catch (e) {
    return fail(e);
  }
}

const planState = async (body: any) => {
  const info = await loadRun(body.run);
  const items = buildPlan(info, body);
  const reference = resolveReference(info, body.reference);
  const dir = info.outputDir;
  const scores = readScores(dir);
  const engine = await resolveEngine();
  const rows = items.map(i => {
    const scored = scores[scoreKey(i.key, reference)];
    return {
      key: i.key,
      kind: i.kind,
      label: i.label,
      file: i.file,
      cached: fs.existsSync(path.join(dir, i.key)),
      score: scored?.score ?? null,
      method: scored?.method ?? null,
    };
  });
  return { info, items, reference, rows, engine };
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(new Error('Malformed request.'));
  try {
    if (body.action === 'output') {
      const folder = validateOutputFolder(body.folder);
      await fs.promises.mkdir(folder, { recursive: true });
      await setCompareOutputFolder(folder);
      return NextResponse.json({ outputFolder: folder });
    }
    if (body.action === 'state') {
      const { info, rows, engine } = await planState(body);
      return NextResponse.json({ rows, engineReady: !!engine?.endpoint, job: getJob(info.runName) });
    }
    if (body.action === 'render') {
      const { info, items, reference, engine } = await planState(body);
      if (!info.supported) throw new Error(`Not supported for ${info.arch || 'this arch'} yet.`);
      if (!engine?.endpoint) throw new Error('The inference engine is off. Start it on the Generate page.');
      return NextResponse.json({ job: startRender(info, items, reference, engine.endpoint) });
    }
    if (body.action === 'cancel') {
      const info = await loadRun(body.run);
      return NextResponse.json({ cancelled: await cancelRender(info.runName) });
    }
    if (body.action === 'promote') {
      const info = await loadRun(body.run);
      const checkpoint = listCheckpoints(info.folder).find(c => c.file === body.file);
      if (!checkpoint) throw new Error('Checkpoint not found in this run.');
      const dest = promoteDest(info.arch, info.runName, promotedName(info.runName, checkpoint));
      const result = await promoteCheckpoint(checkpoint.path, dest, body.overwrite === true);
      if (result === 'exists') return NextResponse.json({ error: 'exists', dest }, { status: 409 });
      return NextResponse.json({ dest });
    }
    return fail(new Error('Unknown action.'));
  } catch (e) {
    return fail(e);
  }
}
