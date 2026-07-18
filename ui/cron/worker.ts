import processQueue from './actions/processQueue';

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

class CronWorker {
  interval: number;
  is_running: boolean;
  intervalId: NodeJS.Timeout;
  constructor() {
    this.interval = 1000; // Default interval of 1 second
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

// it automatically starts the loop
const cronWorker = new CronWorker();
console.log('Cron worker started with interval:', cronWorker.interval, 'ms');
