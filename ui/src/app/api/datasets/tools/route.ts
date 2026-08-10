import { NextResponse } from 'next/server';
import fs from 'fs';
import { getDatasetsRoot } from '@/server/settings';
import { startToolRun, getRun, getActiveRun, ToolName } from '@/server/datasetTools';
import { resolveDatasetPath, sanitizeDatasetName } from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Start/poll the QoL dataset tool CLIs.
// POST { datasetName, tool: 'preflight'|'caption'|'prep', options? } -> { runId }
// GET  ?runId=...          -> run status + log
// GET  ?datasetName=...    -> active run for that dataset (if any)

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId');
  const datasetName = url.searchParams.get('datasetName');
  let run;
  if (runId) {
    run = getRun(runId);
  } else if (datasetName) {
    const safeName = sanitizeDatasetName(datasetName.trim());
    if (!safeName) {
      return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
    }
    run = getActiveRun(safeName);
  }
  if (!run) {
    return NextResponse.json({ run: null });
  }
  return NextResponse.json({ run });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { datasetName, tool } = body as { datasetName?: string; tool?: ToolName };
  const options = (body.options ?? {}) as Record<string, unknown>;

  if (!datasetName || typeof datasetName !== 'string') {
    return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
  }
  if (tool !== 'preflight' && tool !== 'caption' && tool !== 'prep') {
    return NextResponse.json({ error: 'tool must be preflight | caption | prep' }, { status: 400 });
  }

  const safeName = sanitizeDatasetName(datasetName.trim());
  if (!safeName) {
    return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
  }

  const datasetsRoot = await getDatasetsRoot();
  const datasetFolder = resolveDatasetPath(datasetsRoot, safeName);
  if (!datasetFolder) {
    return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
  }
  try {
    await fs.promises.access(datasetFolder);
  } catch {
    return NextResponse.json({ error: `Folder '${safeName}' not found` }, { status: 404 });
  }

  const args: string[] = [];
  if (tool === 'preflight') {
    args.push(datasetFolder);
  } else if (tool === 'caption') {
    args.push(datasetFolder);
    const gen = Number(options.generalThresh ?? 0.35);
    const chr = Number(options.charThresh ?? 0.85);
    if (!Number.isFinite(gen) || !Number.isFinite(chr) || gen < 0 || gen > 1 || chr < 0 || chr > 1) {
      return NextResponse.json({ error: 'thresholds must be between 0 and 1' }, { status: 400 });
    }
    args.push('--general-thresh', String(gen), '--char-thresh', String(chr));
    if (typeof options.triggerWord === 'string' && options.triggerWord.trim()) {
      args.push('--trigger-word', options.triggerWord.trim());
    }
    if (options.overwrite) {
      args.push('--overwrite');
    }
  } else {
    // prep writes to a sibling dataset folder — never in place
    const buckets = String(options.buckets ?? '512x768');
    if (!/^\d{3,4}x\d{3,4}$/.test(buckets)) {
      return NextResponse.json({ error: 'buckets must look like 512x768' }, { status: 400 });
    }
    const requestedOutName =
      options.outName === undefined
        ? `${safeName}_prepped`
        : typeof options.outName === 'string'
          ? options.outName.trim()
          : '';
    const outName = sanitizeDatasetName(requestedOutName);
    if (!outName) {
      return NextResponse.json({ error: 'Invalid output dataset name' }, { status: 400 });
    }
    if (outName === safeName) {
      return NextResponse.json({ error: 'output dataset must differ from the source' }, { status: 400 });
    }
    const outputFolder = resolveDatasetPath(datasetsRoot, outName);
    if (!outputFolder) {
      return NextResponse.json({ error: 'Invalid output dataset name' }, { status: 400 });
    }
    args.push(datasetFolder, outputFolder, '--buckets', buckets);
  }

  try {
    const run = startToolRun(tool, safeName, args);
    return NextResponse.json({ runId: run.runId });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
}
