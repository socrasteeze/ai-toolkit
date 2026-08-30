import { NextResponse } from 'next/server';
import fs from 'fs';
import { getDatasetsRoot } from '@/server/settings';
import { startToolRun, getRun, getActiveRun, cancelToolRun, ToolName } from '@/server/datasetTools';
import { resolveDatasetPath, sanitizeDatasetName } from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Start/poll/cancel the QoL dataset tool CLIs.
// POST   { datasetName, tool: 'preflight'|'caption'|'prep', options? } -> { runId, outputName? }
// GET    ?runId=...          -> run status + log
// GET    ?datasetName=...    -> active run for that dataset (if any)
// DELETE ?runId=...          -> cancel a running tool

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
  } else {
    // was a 200 {run: null}, indistinguishable from "no run exists"
    return NextResponse.json({ error: 'runId or datasetName is required' }, { status: 400 });
  }
  if (!run) {
    return NextResponse.json({ run: null });
  }
  return NextResponse.json({ run });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }
  const run = cancelToolRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'No such run' }, { status: 404 });
  }
  return NextResponse.json({ run });
}

// smart_prep's own rule (scripts/smart_prep.py): MINxMAX, both multiples of 64, MIN <= MAX.
// Enforced here too so a bad value is a field error, not an argparse trace in the log pane.
const parseBuckets = (value: string): { ok: true } | { ok: false; error: string } => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  if (!m) return { ok: false, error: 'buckets must look like 512x768' };
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min % 64 !== 0 || max % 64 !== 0) return { ok: false, error: 'bucket sides must be multiples of 64' };
  if (min > max) return { ok: false, error: 'buckets must be MINxMAX with MIN <= MAX' };
  return { ok: true };
};

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const { datasetName, tool } = (body ?? {}) as { datasetName?: string; tool?: ToolName };
  const options = (body?.options ?? {}) as Record<string, unknown>;

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
  let outputName: string | undefined;
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
    const parsed = parseBuckets(buckets);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
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
    // An existing output folder means either "resume the prep I started earlier"
    // (smart_prep skips files already at their bucket size) or "I typed the name of
    // another dataset" — and the second silently merges into it. Make the user say which.
    const outputExists = await fs.promises.access(outputFolder).then(
      () => true,
      () => false,
    );
    if (outputExists && options.resume !== true) {
      return NextResponse.json(
        {
          error:
            `Output dataset '${outName}' already exists — pick another name, or tick ` +
            `"Allow existing output" to resume a previous prep into it`,
        },
        { status: 409 },
      );
    }
    outputName = outName;
    args.push(datasetFolder, outputFolder, '--buckets', buckets);
  }

  try {
    const run = startToolRun(tool, safeName, args, { locks: outputName ? [outputName] : [] });
    return NextResponse.json({ runId: run.runId, outputName });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
}
