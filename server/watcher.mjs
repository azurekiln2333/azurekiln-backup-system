import { watch, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { isWithin, resolveSourcePath } from './config.mjs';
import { isExcluded } from './exclusions.mjs';

const RETRY_MS = 1000;
const CHECK_MS = 10000;

export function createWatcher({ store, config, backupService }) {
  const entries = new Map();
  let started = false;
  let maintenance;

  function clearEntry(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.watcher?.close();
    entry.watcher = null;
  }

  function excluded(entry, filename) {
    if (!filename) return false;
    const absolute = path.resolve(entry.sourcePath, String(filename));
    if (!isWithin(entry.sourcePath, absolute)) return true;
    const parts = path.relative(entry.sourcePath, absolute).split(path.sep);
    return parts.some((_, index) => {
      const relative = parts.slice(0, index + 1).join(path.sep);
      // A pattern such as cache/** excludes changes under cache even when the event names cache itself.
      return isExcluded(relative, entry.excludes) || isExcluded(path.join(relative, '__watch_probe__'), entry.excludes);
    });
  }

  function flush(entry) {
    entry.timer = null;
    if (!started || !entry.pending || entries.get(entry.id) !== entry) return;
    const job = store.getJob(entry.id);
    if (!job?.enabled || job.type !== 'directory' || !job.watch?.enabled) { entry.pending = false; return; }
    // Wait for an active run, and for the initial incremental baseline so the first change is not a full backup.
    if (backupService.isJobActive(entry.id) || entry.capturing) {
      entry.timer = setTimeout(() => flush(entry), RETRY_MS);
      return;
    }
    try {
      backupService.enqueue(entry.id, 'watch');
      entry.pending = false;
      entry.error = null;
    } catch (error) {
      entry.error = error.message;
      entry.timer = setTimeout(() => flush(entry), CHECK_MS);
    }
  }

  function changed(entry, filename, eventType) {
    if (excluded(entry, filename)) return;
    if (eventType === 'change' && filename) {
      // Windows also emits a change event for the parent directory of a changed file.
      try { if (lstatSync(path.resolve(entry.sourcePath, String(filename))).isDirectory()) return; }
      catch { /* A removed entry still needs a backup. */ }
    }
    if (entry.dirty && filename) entry.dirty.add(String(filename).split(path.sep).join('/'));
    entry.pending = true;
    entry.lastEventAt = new Date().toISOString();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(entry), entry.debounceSeconds * 1000);
  }

  function captureBaseline(entry) {
    if (entry.mode !== 'incremental' || typeof backupService.ensureWatchBaseline !== 'function') return false;
    entry.capturing = true;
    entry.dirty = new Set();
    // A path counts as touched when it or one of its parent directories produced an event.
    const isDirty = (name) => name.split('/').some((_, index, parts) => entry.dirty.has(parts.slice(0, index + 1).join('/')));
    Promise.resolve().then(() => backupService.ensureWatchBaseline(entry.id, { isDirty })).then((result) => {
      // An existing baseline may predate changes made while the service was stopped.
      if (!result?.created && entries.get(entry.id) === entry) changed(entry, null);
    }, (error) => { entry.error = error.message; }).finally(() => { entry.capturing = false; entry.dirty = null; });
    return true;
  }

  function attach(entry) {
    try {
      const source = resolveSourcePath(config, entry.sourcePath, { directory: true });
      const info = statSync(source);
      const watcher = watch(source, { recursive: true }, (event, filename) => {
        if (entry.watcher === watcher) changed(entry, filename, event);
      });
      watcher.on('error', (error) => {
        if (entries.get(entry.id) !== entry || entry.watcher !== watcher) return;
        entry.error = error.message;
        watcher.close();
        entry.watcher = null;
      });
      watcher.on('close', () => { if (entry.watcher === watcher) entry.watcher = null; });
      entry.watcher = watcher;
      entry.identity = `${info.dev}:${info.ino}`;
      entry.error = null;
      if (entry.attachedBefore) changed(entry, null);
      else captureBaseline(entry);
      entry.attachedBefore = true;
    } catch (error) {
      entry.error = error.message;
      entry.watcher = null;
    }
  }

  function refresh() {
    if (!started) return;
    const active = new Set();
    for (const job of store.listJobs()) {
      if (job.type !== 'directory' || !job.enabled || !job.watch?.enabled) continue;
      active.add(job.id);
      const mode = job.watch.mode ?? 'full';
      const key = JSON.stringify([job.sourcePath, job.excludes, job.watch.debounceSeconds, mode]);
      let entry = entries.get(job.id);
      if (entry && entry.key !== key) { clearEntry(entry); entries.delete(job.id); entry = null; }
      if (!entry) {
        entry = { id: job.id, key, sourcePath: job.sourcePath, excludes: job.excludes ?? [], debounceSeconds: job.watch.debounceSeconds ?? 5, mode, watcher: null, timer: null, pending: false, error: null, lastEventAt: null, attachedBefore: false, capturing: false, dirty: null };
        entries.set(job.id, entry);
      }
      if (entry.watcher) {
        try {
          const source = resolveSourcePath(config, entry.sourcePath, { directory: true });
          const info = statSync(source);
          if (`${info.dev}:${info.ino}` !== entry.identity) {
            entry.watcher.close();
            entry.watcher = null;
          }
        } catch (error) {
          entry.error = error.message;
          entry.watcher.close();
          entry.watcher = null;
        }
      }
      if (!entry.watcher) attach(entry);
    }
    for (const [id, entry] of entries) if (!active.has(id)) { clearEntry(entry); entries.delete(id); }
  }

  return {
    start() { if (started) return; started = true; refresh(); maintenance = setInterval(refresh, CHECK_MS); maintenance.unref(); },
    refresh,
    status() { return Object.fromEntries([...entries].map(([id, entry]) => [id, { state: entry.error ? 'error' : entry.watcher ? 'watching' : 'error', mode: entry.mode, capturing: entry.capturing, pending: entry.pending, error: entry.error, lastEventAt: entry.lastEventAt }])); },
    stop() { started = false; clearInterval(maintenance); for (const entry of entries.values()) clearEntry(entry); entries.clear(); },
  };
}
