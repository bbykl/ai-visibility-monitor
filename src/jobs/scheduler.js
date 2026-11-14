import cron from 'node-cron';
import { safeError } from '../config.js';

export class Scheduler {
  constructor(store, runner) { this.store = store; this.runner = runner; this.tasks = []; this.lastError = null; this.reload(); }
  reload() {
    this.stop();
    const settings = this.store.settings();
    if (!settings.scheduleEnabled) return;
    for (const time of settings.scheduleTimes) {
      const [hour, minute] = time.split(':').map(Number);
      this.tasks.push(cron.schedule(`${minute} ${hour} * * *`, () => {
        // Scheduled work never accumulates behind a long running manual batch.
        if (this.runner.active || this.runner.queue.length) return;
        try { this.runner.submit([], 'schedule'); this.lastError = null; }
        catch (error) { this.lastError = safeError(error); console.error('定时任务：', this.lastError); }
      }, { timezone: settings.timezone, noOverlap: true }));
    }
  }
  stop() { for (const task of this.tasks) task.destroy(); this.tasks = []; }
}
