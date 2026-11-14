import cron from 'node-cron';
import { safeError } from '../config.js';

export class Scheduler {
  constructor(store, runner, { schedule = (...args) => cron.schedule(...args) } = {}) {
    this.store = store; this.runner = runner; this.schedule = schedule;
    this.tasks = []; this.lastError = null; this.reload();
  }
  status() {
    if (!this.store.settings().scheduleEnabled) return { state:'disabled', message:'定时查询已关闭' };
    if (!this.runner.configured) return { state:'waiting_api_key', message:'定时已保存，等待配置 API Key；配置后从下个计划时间执行' };
    if (!this.store.keywords().some(k => k.enabled)) return { state:'waiting_keywords', message:'定时已保存，等待添加并启用关键词' };
    if (this.lastError) return { state:'error', message:this.lastError };
    if (this.runner.active || this.runner.queue.length) return { state:'busy', message:'任务执行中，本轮定时将跳过' };
    return { state:'ready', message:'定时查询已就绪，将在下个计划时间执行' };
  }
  tick() {
    // Missing configuration is a waiting state, not a failed or billable job.
    const state = this.status().state;
    if (['disabled','waiting_api_key','waiting_keywords','busy'].includes(state)) return false;
    if (this.runner.active || this.runner.queue.length) return false;
    try { this.runner.submit([], 'schedule'); this.lastError = null; return true; }
    catch (error) { this.lastError = safeError(error); console.error('定时任务：', this.lastError); return false; }
  }
  reload() {
    this.stop();
    this.lastError = null;
    const settings = this.store.settings();
    if (!settings.scheduleEnabled) return;
    for (const time of settings.scheduleTimes) {
      const [hour, minute] = time.split(':').map(Number);
      this.tasks.push(this.schedule(`${minute} ${hour} * * *`, () => this.tick(), { timezone: settings.timezone, noOverlap: true }));
    }
  }
  stop() { for (const task of this.tasks) task.destroy(); this.tasks = []; }
}
