import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// Fork-only module (see FORK_NOTES.md). Runs the fork's QoL dataset CLIs
// (scripts/preflight.py, scripts/auto_caption.py, scripts/smart_prep.py) as
// child processes and buffers their output for polling. Deliberately NOT
// integrated with the Prisma job queue (fork rule: no schema changes) — these
// are short-lived local prep tools, not training jobs.
//
// Known limit (documented, not fixed): the registry is process memory. A UI
// restart forgets every finished log. Running children are killed on a clean
// shutdown (`process.on('exit')`), so a restart cannot leave an orphaned tagger
// writing into a dataset the new server thinks is idle — but a hard kill of the
// node process (`taskkill /F`, which `stop.bat` uses) skips exit handlers, and
// the child then finishes on its own.

import { resolvePythonPath } from '../../cron/pythonPath';
import { TOOLKIT_ROOT } from '../../cron/paths';
import { createToolRunRegistry, RegisteredRunStatus } from './toolRunRegistry';

export type ToolName = 'preflight' | 'caption' | 'prep';

export interface ToolRun {
  runId: string;
  tool: ToolName;
  datasetName: string;
  // other datasets this run writes to (prep's output) — see toolRunRegistry.ts
  locks?: string[];
  status: RegisteredRunStatus;
  exitCode: number | null;
  log: string;
  startedAt: number;
}

// Registration, per-dataset ownership and retention live in the registry so they
// can be tested without spawning Python or loading Prisma — see toolRunRegistry.ts.
const registry = createToolRunRegistry<ToolRun>();
// Children are kept here, not on the run object, so the run stays JSON-serializable
// for the polling route.
const children = new Map<string, ChildProcess>();
// runId -> "stop this run"; each closure owns its run's cancel flag and finalizer
const cancellers = new Map<string, () => boolean>();

const SCRIPTS: Record<ToolName, string> = {
  preflight: 'preflight.py',
  caption: 'auto_caption.py',
  prep: 'smart_prep.py',
};

let exitHookInstalled = false;
const installExitHook = () => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of children.values()) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  });
};

export function getRun(runId: string): ToolRun | undefined {
  return registry.get(runId);
}

export function getActiveRun(datasetName: string): ToolRun | undefined {
  return registry.getActive(datasetName);
}

export interface StartToolRunOptions {
  // datasets the run writes to besides its source (prep's output folder)
  locks?: string[];
}

export function startToolRun(
  tool: ToolName,
  datasetName: string,
  args: string[],
  options: StartToolRunOptions = {},
): ToolRun {
  const locks = (options.locks ?? []).filter(name => name !== datasetName);
  const active = registry.findRunningWriter([datasetName, ...locks]);
  if (active) {
    const where = active.datasetName === datasetName ? 'this dataset' : `'${active.datasetName}'`;
    throw new Error(`a ${active.tool} run is already in progress for ${where}`);
  }

  const runId = `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run: ToolRun = {
    runId,
    tool,
    datasetName,
    locks: locks.length > 0 ? locks : undefined,
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
  let cancelRequested = false;
  const finalize = (status: Exclude<RegisteredRunStatus, 'running'>, exitCode: number) => {
    if (finalized) return;
    finalized = true;
    run.status = status;
    run.exitCode = exitCode;
    children.delete(runId);

    // The finished run stays discoverable until retention expires — exclusivity
    // does not depend on unregistering it, since the guard above tests
    // `status === 'running'`.
    registry.scheduleRetirement(run);
  };

  let child: ChildProcess;
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

  children.set(runId, child);
  installExitHook();

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', err => {
    append(`\nfailed to start: ${err.message}`);
    finalize('failed', -1);
  });
  child.on('close', code => {
    if (cancelRequested) {
      append('\ncancelled by user');
      finalize('cancelled', code ?? -1);
      return;
    }
    finalize(code === 0 ? 'done' : 'failed', code ?? -1);
  });

  // Reached through cancelToolRun below; kept in the closure so `cancelRequested`
  // and `finalize` stay private to this run.
  cancellers.set(runId, () => {
    if (finalized) return false;
    cancelRequested = true;
    try {
      child.kill();
    } catch {
      // already gone; the close handler will still fire (or already did)
    }
    return true;
  });

  return run;
}

/**
 * Stop a running tool. Returns the run (now finishing) or undefined if no such run.
 * The status flips to 'cancelled' when the child actually exits, not here — the
 * poller sees "running" for one more tick at most.
 */
export function cancelToolRun(runId: string): ToolRun | undefined {
  const run = registry.get(runId);
  if (!run) return undefined;
  const cancel = cancellers.get(runId);
  if (cancel && run.status === 'running') {
    cancel();
  }
  cancellers.delete(runId);
  return run;
}
