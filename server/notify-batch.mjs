import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { redact } from './process.mjs';
import { newApiSecrets } from './newapi.mjs';
import { settingsSchema } from '../shared/contracts.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const waiting = new Set(['pending', 'batched']);
const maxWaitMs = 30 * 60 * 1000;
const templateModule = new URL('./notify-template.mjs', import.meta.url);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function defaultNotification(ctx) {
  const subject = ctx.items.map((item) => `[备份 ${item.status}] ${item.jobName}`).join('');
  const rows = ctx.items.map((item) => `\n- ${item.jobName} (${item.type}) ${item.status} 耗时 ${item.durationSec} 秒 体积 ${item.archiveBytes ?? ''} 字节${item.error}\n`).join('');
  const text = [`备份汇总:共 ${ctx.total} 个,成功 ${ctx.successCount},警告 ${ctx.warningCount},失败 ${ctx.failedCount}`, `主机:${ctx.hostName}`, `开始:${ctx.startedAt}  结束:${ctx.finishedAt}`, '', rows].join('\n').trim();
  return { subject, text, html: `<div style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(text)}</div>` };
}

async function render(template, ctx) {
  if (!existsSync(templateModule)) return defaultNotification(ctx);
  const { renderNotification } = await import(templateModule.href);
  return renderNotification(template, ctx);
}

// Run notification states are the queue: no in-memory batch membership needs to survive a restart.
export function createNotificationBatcher({ store, sendEmail, now = Date.now }) {
  let stopped = false, timer;
  let operation = Promise.resolve();

  function allRuns() {
    const runs = [];
    for (let offset = 0; ; offset += 500) {
      const page = store.listRuns({ limit: 500, offset });
      runs.push(...page.items);
      if (runs.length >= page.total || !page.items.length) return runs;
    }
  }

  function schedule(at) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Leave persisted states intact if a storage failure temporarily prevents a flush.
      flush().catch(() => schedule(now() + 60000));
    }, Math.max(1, at - now()));
    timer.unref();
  }

  function prepare(run, settings) {
    if (!terminal.has(run.status) || !run.finishedAt || !waiting.has(run.notificationStatus)) return null;
    // A batched record already passed the per-job preference check, even if its job was later removed.
    if (run.notificationStatus === 'pending') {
      const job = store.getJob(run.jobId);
      const kind = run.status === 'succeeded' ? 'success' : 'failure';
      if (!job?.notification?.[kind] || !settings.smtp.enabled) {
        store.updateRun(run.id, { notificationStatus: 'disabled' });
        return null;
      }
      return store.updateRun(run.id, { notificationStatus: 'batched' });
    }
    if (!settings.smtp.enabled) {
      store.updateRun(run.id, { notificationStatus: 'disabled' });
      return null;
    }
    return run;
  }

  async function deliver(runs, settings) {
    const jobs = runs.map((run) => store.getJob(run.jobId, { includeSecrets: true })).filter(Boolean);
    const secrets = [settings.smtp.password, settings.rclone?.configPassword, ...jobs.flatMap((job) => [
      job.archive?.password, job.vaultwarden?.database?.password, ...newApiSecrets(job),
    ])].filter(Boolean);
    const clean = (value) => redact(value, secrets).replace(/[\r\n]+/g, ' ');
    const items = runs.map((run) => ({
      jobName: clean(run.jobName), type: clean(run.type),
      status: run.status === 'succeeded' && run.warnings?.length ? 'warning' : run.status,
      durationSec: Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt || run.createdAt)) / 1000)) || 0,
      archiveBytes: run.archiveBytes ?? null,
      error: clean((typeof run.error === 'string' ? run.error : run.error?.message) || (run.warnings ?? []).join('; ')),
      nodeName: clean(run.nodeName || ''),
    }));
    const ctx = {
      total: items.length,
      successCount: items.filter((item) => item.status === 'succeeded').length,
      warningCount: items.filter((item) => item.status === 'warning').length,
      failedCount: items.filter((item) => !['succeeded', 'warning'].includes(item.status)).length,
      startedAt: new Date(runs.reduce((oldest, run) => Math.min(oldest, Date.parse(run.startedAt || run.createdAt)), Infinity)).toISOString(),
      finishedAt: new Date(runs.reduce((latest, run) => Math.max(latest, Date.parse(run.finishedAt)), -Infinity)).toISOString(),
      hostName: clean(hostname()), items,
    };
    try {
      const template = settings.notification?.template;
      const message = await render(template && {
        subject: redact(template.subject, secrets), body: redact(template.body, secrets),
      }, ctx);
      const result = await sendEmail(settings, {
        subject: redact(message.subject, secrets), text: redact(message.text, secrets), html: redact(message.html, secrets),
      });
      for (const run of runs) store.updateRun(run.id, { notificationStatus: result?.disabled ? 'disabled' : 'sent' });
    } catch (error) {
      const warning = redact(`Email notification failed: ${error.message}`, secrets);
      for (const run of runs) {
        const current = store.getRun(run.id);
        store.appendLog(run.id, { level: 'warn', message: warning });
        store.updateRun(run.id, { notificationStatus: 'failed', warnings: [...(current.warnings ?? []), warning] });
      }
    }
  }

  async function check() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    const runs = allRuns();
    const settings = store.getSettings({ includeSecrets: true });
    const candidates = runs.map((run) => prepare(run, settings)).filter(Boolean)
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    if (!candidates.length) return;
    const windowSec = settings.notification?.aggregateWindowSec ?? settingsSchema.shape.notification.parse({}).aggregateWindowSec;
    if (windowSec === 0) {
      for (const run of candidates) {
        if (stopped) break;
        await deliver([run], settings);
      }
      return;
    }
    const deadline = Date.parse(candidates[0].finishedAt) + maxWaitMs;
    const lastFinished = runs.reduce((latest, run) => terminal.has(run.status) && run.finishedAt ? Math.max(latest, Date.parse(run.finishedAt)) : latest, -Infinity);
    const busy = runs.some((run) => ['queued', 'running'].includes(run.status));
    const due = busy ? deadline : Math.min(deadline, lastFinished + windowSec * 1000);
    if (now() < due) { schedule(due); return; }
    await deliver(candidates, settings);
  }

  function flush() {
    const next = operation.then(check);
    operation = next.catch(() => {});
    return next;
  }

  return {
    // Persist eligibility immediately, including while shutdown is waiting for an active backup to finish.
    complete(runId) {
      const run = store.getRun(runId);
      if (run) prepare(run, store.getSettings({ includeSecrets: true }));
      return stopped ? Promise.resolve() : flush();
    },
    recover: flush,
    flush,
    async shutdown() {
      stopped = true;
      clearTimeout(timer);
      await operation;
    },
  };
}
