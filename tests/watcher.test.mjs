import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../server/config.mjs';
import { createWatcher } from '../server/watcher.mjs';

async function until(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('Timed out waiting for watcher event');
}

test('recursive watcher merges writes, ignores exclusions, and runs again after an active backup', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-watch-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: path.join(root, 'sources') }, root);
  const source = path.join(config.sourceRoots[0], 'project');
  mkdirSync(path.join(source, 'nested'), { recursive: true });
  const job = { id: 'directory-1', type: 'directory', enabled: true, sourcePath: source, excludes: ['*.log', 'cache/**'], watch: { enabled: true, debounceSeconds: 1 } };
  const runs = [];
  let active = false;
  const watcher = createWatcher({ store: { listJobs: () => [job], getJob: () => job }, config, backupService: { isJobActive: () => active, enqueue: (_id, trigger) => { runs.push(trigger); active = true; } } });
  t.after(() => { watcher.stop(); rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  assert.equal(watcher.status()[job.id].state, 'watching');

  writeFileSync(path.join(source, 'nested', 'one.txt'), 'first');
  writeFileSync(path.join(source, 'nested', 'one.txt'), 'second');
  await until(() => runs.length === 1);
  assert.deepEqual(runs, ['watch']);

  writeFileSync(path.join(source, 'nested', 'two.txt'), 'later');
  await until(() => watcher.status()[job.id].pending);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(runs.length, 1);
  active = false;
  await until(() => runs.length === 2);
  assert.equal(watcher.status()[job.id].pending, false);

  mkdirSync(path.join(source, 'cache'));
  writeFileSync(path.join(source, 'cache', 'ignored.txt'), 'ignored');
  writeFileSync(path.join(source, 'nested', 'ignored.log'), 'ignored');
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(runs.length, 2);
  assert.equal(watcher.status()[job.id].pending, false);

  job.enabled = false;
  watcher.refresh();
  assert.equal(watcher.status()[job.id], undefined);
  writeFileSync(path.join(source, 'nested', 'paused.txt'), 'ignored');
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(runs.length, 2);
});

test('incremental watcher holds runs while capturing its baseline and marks files touched during capture', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-watch-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: path.join(root, 'sources') }, root);
  const source = path.join(config.sourceRoots[0], 'incremental');
  mkdirSync(path.join(source, 'nested'), { recursive: true });
  const job = { id: 'directory-3', type: 'directory', enabled: true, sourcePath: source, excludes: [], watch: { enabled: true, mode: 'incremental', debounceSeconds: 1 } };
  const runs = [];
  let finishCapture, dirtyCheck;
  const backupService = {
    isJobActive: () => false,
    enqueue: (_id, trigger) => runs.push(trigger),
    ensureWatchBaseline: (_id, { isDirty }) => { dirtyCheck = isDirty; return new Promise((resolve) => { finishCapture = resolve; }); },
  };
  const watcher = createWatcher({ store: { listJobs: () => [job], getJob: () => job }, config, backupService });
  t.after(() => { watcher.stop(); rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  await until(() => finishCapture);
  assert.equal(watcher.status()[job.id].capturing, true);
  writeFileSync(path.join(source, 'nested', 'during.txt'), 'during capture');
  await until(() => watcher.status()[job.id].pending);
  assert.equal(dirtyCheck('nested/during.txt'), true);
  assert.equal(dirtyCheck('untouched.txt'), false);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(runs.length, 0, 'no run starts before the baseline exists');
  finishCapture({ created: true });
  await until(() => runs.length === 1);
  assert.deepEqual(runs, ['watch']);
  assert.equal(watcher.status()[job.id].capturing, false);
});

test('incremental watcher checks for offline changes when a baseline already exists', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-watch-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: path.join(root, 'sources') }, root);
  const source = path.join(config.sourceRoots[0], 'existing');
  mkdirSync(source, { recursive: true });
  const job = { id: 'directory-4', type: 'directory', enabled: true, sourcePath: source, excludes: [], watch: { enabled: true, mode: 'incremental', debounceSeconds: 1 } };
  const runs = [];
  const backupService = { isJobActive: () => false, enqueue: (_id, trigger) => runs.push(trigger), ensureWatchBaseline: async () => ({ created: false }) };
  const watcher = createWatcher({ store: { listJobs: () => [job], getJob: () => job }, config, backupService });
  t.after(() => { watcher.stop(); rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  await until(() => runs.length === 1);
});

test('missing watched directory reports an error and reattaches when restored', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-watch-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: path.join(root, 'sources') }, root);
  const source = path.join(config.sourceRoots[0], 'missing');
  const job = { id: 'directory-2', type: 'directory', enabled: true, sourcePath: source, excludes: [], watch: { enabled: true, debounceSeconds: 1 } };
  const runs = [];
  const watcher = createWatcher({ store: { listJobs: () => [job], getJob: () => job }, config, backupService: { isJobActive: () => false, enqueue: (_id, trigger) => runs.push(trigger) } });
  t.after(() => { watcher.stop(); rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  assert.equal(watcher.status()[job.id].state, 'error');
  mkdirSync(source);
  watcher.refresh();
  assert.equal(watcher.status()[job.id].state, 'watching');
  writeFileSync(path.join(source, 'restored.txt'), 'ready');
  await until(() => runs.length === 1);
});
