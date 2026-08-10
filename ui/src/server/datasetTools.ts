import { spawn } from 'child_process';
import path from 'path';

// Fork-only module (see FORK_NOTES.md). Runs the fork's QoL dataset CLIs
// (scripts/preflight.py, scripts/auto_caption.py, scripts/smart_prep.py) as
// child processes and buffers their output for polling. Deliberately NOT
// integrated with the Prisma job queue (fork rule: no schema changes) — these
// are short-lived local prep tools, not training jobs.

import { resolvePythonPath } from '../../cron/pythonPath';
import { TOOLKIT_ROOT } from '../../cron/paths';
import { createToolRunRegistry } from './toolRunRegistry';

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

// Registration, per-dataset ownership and retention live in the registry so they
// can be tested without spawning Python or loading Prisma — see toolRunRegistry.ts.
const registry = createToolRunRegistry<ToolRun>();

const SCRIPTS: Record<ToolName, string> = {
  preflight: 'preflight.py',
  caption: 'auto_caption.py',
  prep: 'smart_prep.py',
};

export function getRun(runId: string): ToolRun | undefined {
  return registry.get(runId);
}

export function getActiveRun(datasetName: string): ToolRun | undefined {
  return registry.getActive(datasetName);
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
  registry.register(run);

  const script = path.join(TOOLKIT_ROOT, 'scripts', SCRIPTS[tool]);
  const append = (chunk: Buffer | string) => {
    run.log += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    // cap the buffer; these tools log modestly but never trust a child process
    if (run.log.length > 200_000) {
      run.log = run.log.slice(-150_000);
    }
  };

  let finalized = false;
  const finalize = (status: 'done' | 'failed', exitCode: number) => {
    if (finalized) return;
    finalized = true;
    run.status = status;
    run.exitCode = exitCode;

    // The finished run stays discoverable until retention expires — exclusivity
    // does not depend on unregistering it, since the guard below tests
    // `status === 'running'`.
    registry.scheduleRetirement(run);
  };

  let child;
  try {
    child = spawn(resolvePythonPath(), ['-u', script, ...args], {
      cwd: TOOLKIT_ROOT,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(`\nfailed to start: ${message}`);
    finalize('failed', -1);
    return run;
  }

  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', err => {
    append(`\nfailed to start: ${err.message}`);
    finalize('failed', -1);
  });
  child.on('close', code => {
    finalize(code === 0 ? 'done' : 'failed', code ?? -1);
  });

  return run;
}
