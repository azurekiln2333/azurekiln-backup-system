import { Cron } from 'croner';

export function createScheduler({ store, backupService }) {
  const timers = new Map();
  let started = false;
  function stop() {
    started = false;
    for (const timer of timers.values()) timer.stop();
    timers.clear();
  }
  function refresh() {
    if (!started) return;
    for (const timer of timers.values()) timer.stop();
    timers.clear();
    for (const job of store.listJobs()) {
      if (!job.enabled || !job.schedule.enabled) {
        store.updateJob(job.id, { nextRunAt: null });
        continue;
      }
      const timer = new Cron(job.schedule.cron, { timezone: job.schedule.timezone, protect: true }, () => {
        const current = store.getJob(job.id);
        if (current?.enabled) {
          try { backupService.enqueue(job.id, 'schedule'); } catch { /* A deleted or queued task needs no duplicate run. */ }
        }
        store.updateJob(job.id, { nextRunAt: timer.nextRun()?.toISOString() ?? null });
      });
      timers.set(job.id, timer);
      store.updateJob(job.id, { nextRunAt: timer.nextRun()?.toISOString() ?? null });
    }
  }
  return { start() { started = true; refresh(); }, stop, refresh };
}
