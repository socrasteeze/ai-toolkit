import { spawn } from 'child_process';
import path from 'path';

// Fork-only module (see FORK_NOTES.md). Runs the fork's QoL dataset CLIs
// (scripts/preflight.py, scripts/auto_caption.py, scripts/smart_prep.py) as
// child processes and buffers their output for polling. Deliberately NOT
// integrated with the Prisma job queue (fork rule: no schema changes) — these
// are short-lived local prep tools, not training jobs.

import { resolvePythonPath } from '../../cron/pythonPath';
import { TOOLKIT_ROOT } from '../../cron/paths';

export type ToolName = 'preflight' | 'caption' | 'prep';

export interface ToolRun {
  runId: string;
  tool: ToolName;
  datasetName: string;
  status: 'running' | 'done' | 'failed';
  exitCode: number | null;
  log: string;
  startedAt: number;
}

const runs = new Map<string, ToolRun>();
// one run at a time per dataset — the tools mutate caption/image files
const activeByDataset = new Map<string, string>();

const SCRIPTS: Record<ToolName, string> = {
  preflight: 'preflight.py',
  caption: 'auto_caption.py',
  prep: 'smart_prep.py',
};

export function getRun(runId: string): ToolRun | undefined {
  return runs.get(runId);
}

export function getActiveRun(datasetName: string): ToolRun | undefined {
  const id = activeByDataset.get(datasetName);
  return id ? runs.get(id) : undefined;
}

export function startToolRun(tool: ToolName, datasetName: string, args: string[]): ToolRun {
  const active = getActiveRun(datasetName);
  if (active && active.status === 'running') {
    throw new Error(`a ${active.tool} run is already in progress for this dataset`);
  }

  const runId = `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run: ToolRun = {
    runId,
    tool,
    datasetName,
    status: 'running',
    exitCode: null,
    log: '',
    startedAt: Date.now(),
  };
  runs.set(runId, run);
  activeByDataset.set(datasetName, runId);

  const script = path.join(TOOLKIT_ROOT, 'scripts', SCRIPTS[tool]);
  const child = spawn(resolvePythonPath(), ['-u', script, ...args], {
    cwd: TOOLKIT_ROOT,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  });

  const append = (chunk: Buffer) => {
    run.log += chunk.toString('utf-8');
    // cap the buffer; these tools log modestly but never trust a child process
    if (run.log.length > 200_000) {
      run.log = run.log.slice(-150_000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', err => {
    run.log += `\nfailed to start: ${err.message}`;
    run.status = 'failed';
    run.exitCode = -1;
  });
  child.on('close', code => {
    run.exitCode = code;
    run.status = code === 0 ? 'done' : 'failed';
  });

  // drop finished runs after an hour so the map can't grow unbounded
  setTimeout(() => runs.delete(runId), 60 * 60 * 1000).unref?.();

  return run;
}
