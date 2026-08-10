// Fork-only module (see FORK_NOTES.md). The bookkeeping half of `datasetTools.ts`:
// which tool runs exist, which one owns a dataset, and when a finished one is
// forgotten. Split out for the same reason as `cron/remoteIntegrity.ts` — the
// module it came from spawns child processes and reaches Prisma through
// `cron/paths`, so none of these rules could be tested without both.
//
// No imports. That is the point.

export interface RegisteredRun {
  runId: string;
  datasetName: string;
  status: 'running' | 'done' | 'failed';
}

const HOUR_MS = 60 * 60 * 1000;

type Timer = (callback: () => void, delayMs: number) => void;

const defaultSetTimer: Timer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  // Never hold the process open for a retention sweep.
  (timer as unknown as { unref?: () => void }).unref?.();
};

export interface ToolRunRegistryOptions {
  retentionMs?: number;
  setTimer?: Timer;
}

export function createToolRunRegistry<T extends RegisteredRun>(options: ToolRunRegistryOptions = {}) {
  const retentionMs = options.retentionMs ?? HOUR_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;

  const runs = new Map<string, T>();
  // one run at a time per dataset — the tools mutate caption/image files
  const activeByDataset = new Map<string, string>();

  return {
    get(runId: string): T | undefined {
      return runs.get(runId);
    },

    /**
     * The dataset's current run, finished or not.
     *
     * A completed run stays discoverable on purpose: this is what backs
     * GET /api/datasets/tools?datasetName=..., so dropping it the moment the
     * child exits makes reopening the Dataset Tools modal show an empty panel
     * instead of the log the user is looking for.
     */
    getActive(datasetName: string): T | undefined {
      const runId = activeByDataset.get(datasetName);
      return runId ? runs.get(runId) : undefined;
    },

    register(run: T): void {
      runs.set(run.runId, run);
      activeByDataset.set(run.datasetName, run.runId);
    },

    /**
     * Start forgetting a run now that its child has exited.
     *
     * The countdown begins here rather than at launch so a tool that runs for
     * two hours cannot be evicted while it is still working — which would let a
     * second writer start against the same dataset.
     */
    scheduleRetirement(run: T): void {
      setTimer(() => {
        // Identity checks, not key checks: a stale run's timer must never
        // retire whatever took its place.
        if (runs.get(run.runId) === run) {
          runs.delete(run.runId);
        }
        if (activeByDataset.get(run.datasetName) === run.runId) {
          activeByDataset.delete(run.datasetName);
        }
      }, retentionMs);
    },
  };
}

export type ToolRunRegistry<T extends RegisteredRun> = ReturnType<typeof createToolRunRegistry<T>>;
