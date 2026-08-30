import processQueue from './actions/processQueue';
import prisma from './prisma';

// Safety net: this process is meant to run forever as the background queue
// processor. Node terminates on an unhandled rejection by default, and
// `npm run start` auto-restarts it (concurrently --restart-tries -1), so an
// unhandled rejection here silently turns into a crash-restart loop instead
// of a visible error — log and keep running instead.
process.on('unhandledRejection', reason => {
  console.error('[cron worker] Unhandled promise rejection (ignored to keep the queue processor alive):', reason);
});
process.on('uncaughtException', error => {
  console.error('[cron worker] Uncaught exception (ignored to keep the queue processor alive):', error);
});

// Journal mode for the main sqlite db. WAL keeps readers from blocking while
// the trainer/worker write, which is what we want on a local disk. Users on
// setups where WAL can't work (e.g. db on a network filesystem) can override
// with AI_TOOLKIT_DB_JOURNAL_MODE=DELETE (or any other valid sqlite mode).
const DEFAULT_JOURNAL_MODE = 'WAL';
const VALID_JOURNAL_MODES = ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF'];

async function ensureJournalMode() {
  const envMode = process.env.AI_TOOLKIT_DB_JOURNAL_MODE;
  let targetMode = (envMode || DEFAULT_JOURNAL_MODE).toUpperCase();
  if (!VALID_JOURNAL_MODES.includes(targetMode)) {
    console.warn(
      `Invalid AI_TOOLKIT_DB_JOURNAL_MODE "${envMode}", expected one of ${VALID_JOURNAL_MODES.join(', ')}. Using ${DEFAULT_JOURNAL_MODE}.`,
    );
    targetMode = DEFAULT_JOURNAL_MODE;
  }

  const current = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode;');
  const currentMode = current[0]?.journal_mode?.toUpperCase();
  if (currentMode === targetMode) {
    return;
  }

  console.log(`Converting database journal mode from ${currentMode} to ${targetMode}...`);
  // targetMode is validated against VALID_JOURNAL_MODES above, safe to interpolate
  const result = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode = ${targetMode};`);
  const resultMode = result[0]?.journal_mode?.toUpperCase();
  if (resultMode === targetMode) {
    console.log(`Database journal mode is now ${resultMode}.`);
  } else {
    // sqlite refuses the switch rather than corrupting anything (e.g. WAL on a
    // network filesystem), so just report what we're actually running with.
    console.warn(`Could not convert database journal mode to ${targetMode}, still using ${resultMode}.`);
  }
}

// Fork: queue scan cadence. Each tick is one `queue.findMany` plus one or two
// `job.find*` per queue against the same sqlite file the trainer writes its step
// counter to — at 1 s that was the largest steady-state source of lock contention
// on aitk_db.db (PLAN.md 2026-08-29 performance pass). Nothing here needs
// sub-second latency: the only effect of a slower tick is how soon a queued job
// starts after the previous one ends. Override with AI_TOOLKIT_QUEUE_POLL_MS.
const DEFAULT_QUEUE_POLL_MS = 2000;
const queuePollMs = (() => {
  const raw = Number(process.env.AI_TOOLKIT_QUEUE_POLL_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : DEFAULT_QUEUE_POLL_MS;
})();

class CronWorker {
  interval: number;
  is_running: boolean;
  intervalId: NodeJS.Timeout;
  constructor() {
    this.interval = queuePollMs;
    this.is_running = false;
    this.intervalId = setInterval(() => {
      this.run();
    }, this.interval);
  }
  async run() {
    if (this.is_running) {
      return;
    }
    this.is_running = true;
    try {
      // Loop logic here
      await this.loop();
    } catch (error) {
      console.error('Error in cron worker loop:', error);
    }
    this.is_running = false;
  }

  async loop() {
    await processQueue();
  }
}

// make sure the db journal mode is set before the loop starts hitting the db
ensureJournalMode()
  .catch(error => {
    console.warn('Could not check/convert database journal mode:', error);
  })
  .finally(() => {
    // it automatically starts the loop
    const cronWorker = new CronWorker();
    console.log('Cron worker started with interval:', cronWorker.interval, 'ms');
  });
