import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createBackupService } from '../server/backup.mjs';
import { createRcloneService } from '../server/rclone.mjs';
import { runProcess } from '../server/process.mjs';
import { SITE_BACKUP_JOB_LIMIT } from '../shared/contracts.mjs';

// Real compression/rclone cases are opt-in so focused HTTP/store checks cannot
// accidentally start a second integration suite beside the parent's final run.
const realIntegration = process.env.RUN_BACKUP_INTEGRATION === '1';
const rcloneBinary = process.env.RCLONE_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/rclone-v1.75.1-windows-amd64/rclone.exe') : 'rclone');
const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/7zip/x64/7za.exe') : '7z');
const archiveSecret = 'file-clone-archive-fixture-secret';

async function stateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-file-clone-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: JSON.stringify([path.join(root, 'sources')]), RCLONE_BINARY: rcloneBinary, SEVEN_ZIP_BINARY: sevenZipBinary }, root);
  const source = path.join(config.sourceRoots[0], 'directory');
  const selected = path.join(source, 'selected.conf');
  await mkdir(source);
  await writeFile(selected, 'selected fixture bytes\n');
  await writeFile(path.join(source, 'sibling-secret.conf'), 'sibling bytes must never be archived');
  const store = createStore(config);
  return { root, config, source, selected, store };
}

const jobInput = (context, patch = {}) => ({
  name: 'Source task', type: 'directory', sourcePath: context.source,
  destinations: [{ remote: 'test', path: 'backups/source' }],
  archive: { format: '7z', encrypted: true, password: archiveSecret, level: 1 },
  ...patch,
});

async function apiFixture() {
  const context = await stateFixture();
  const calls = { scheduleRefresh: 0, watchRefresh: 0, enqueues: 0 };
  const scheduler = { start() {}, stop() {}, refresh() { calls.scheduleRefresh++; } };
  const watcher = { start() {}, stop() {}, refresh() { calls.watchRefresh++; }, status() { return {}; } };
  const backupService = {
    isJobActive() { return false; },
    enqueue(id, trigger) { calls.enqueues++; return context.store.createRun(context.store.getJob(id), trigger); },
    async shutdown() {}, async getArchives() { return []; },
    async storage() { return { tempBytes: 0, retainedBytes: 0, localArchives: [] }; },
    async health() { return {}; },
  };
  const runtime = await createApp({ config: context.config, store: context.store, scheduler, watcher, backupService, rclone: {} });
  const server = await new Promise(resolve => { const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  context.config.publicUrl = url;
  let session = '', csrfToken = '';
  const request = async (route, { method = 'GET', body, csrf = true, authenticated = true, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authenticated && session) headers.cookie = session;
    if (csrf && csrfToken) headers['x-csrf-token'] = csrfToken;
    if (origin) headers.origin = origin;
    const response = await fetch(`${url}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('backup_session=')) session = cookie.split(';')[0];
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data };
  };
  const setup = await request('/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-file-clone-admin-password' } });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  return {
    ...context, request, calls,
    async close() {
      await runtime.close();
      await new Promise(resolve => server.close(resolve));
      context.store.close();
      await rm(context.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const assertError = (response, status, code) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(response.data.error.code, code);
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rawDatabase = context => new DatabaseSync(path.join(context.config.dataDir, 'state.sqlite'));

async function finish(store, runId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = store.getRun(runId);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) && run.finishedAt && run.cleanupStatus !== 'pending' && run.notificationStatus !== 'pending') return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Run did not settle: ${JSON.stringify(store.getRun(runId))}`);
}

test('file API accepts regular and zero-byte sources, enforces type/root boundaries and keeps directory-only settings', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const empty = path.join(context.source, 'empty.dump');
  await writeFile(empty, '');
  for (const sourcePath of [context.selected, empty]) {
    const created = await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath, excludes: ['*.conf'], schedule: { enabled: true, cron: '0 4 * * *', timezone: 'Asia/Shanghai' } }) });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.type, 'file');
    assert.equal(created.data.sourcePath, sourcePath);
    assert.deepEqual(created.data.excludes, []);
    assert.equal(created.data.schedule.enabled, true);
    const queued = await context.request(`/jobs/${created.data.id}/run`, { method: 'POST' });
    assert.equal(queued.status, 202);
    assert.equal(queued.data.type, 'file');
    assert.equal(queued.data.trigger, 'manual');
  }
  const invalidSources = [
    [context.source, 400, 'SOURCE_NOT_FILE'],
    [path.join(context.root, 'outside.txt'), 403, 'SOURCE_PATH_FORBIDDEN'],
    [path.join(context.config.dataDir, 'state.sqlite'), 403, 'SOURCE_PATH_FORBIDDEN'],
    [path.join(context.source, 'missing.txt'), 404, 'SOURCE_PATH_MISSING'],
    ['relative-file.txt', 400, 'SOURCE_PATH_INVALID'],
  ];
  for (const [sourcePath, status, code] of invalidSources) {
    assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath }) }), status, code);
  }
  assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { sourcePath: context.selected }) }), 400, 'SOURCE_NOT_DIRECTORY');
  assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath: context.selected, watch: { enabled: true } }) }), 400, 'WATCH_DIRECTORY_ONLY');
  const listing = await context.request(`/sources?path=${encodeURIComponent(context.source)}`);
  assert.ok(listing.data.entries.some(entry => entry.path === context.selected && !entry.isDirectory), 'existing browsing exposes the selectable file');
});

test('file validation rejects a symlink ancestor and a direct file symlink', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const ancestor = path.join(context.config.sourceRoots[0], 'state-link');
  await symlink(context.config.dataDir, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath: path.join(ancestor, 'state.sqlite') }) }), 403, 'SOURCE_SYMLINK_FORBIDDEN');
  await t.test('direct file link', async child => {
    const link = path.join(context.source, 'selected-link.conf');
    try { await symlink(context.selected, link, 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return child.skip('Host does not permit file symlinks.'); throw error; }
    assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath: link }) }), 403, 'SOURCE_SYMLINK_FORBIDDEN');
  });
});

test('file validation rejects a special socket source', { skip: process.platform === 'win32' }, async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const socketPath = path.join(context.source, 'service.sock');
  const socket = createServer();
  await new Promise(resolve => socket.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  assertError(await context.request('/jobs', { method: 'POST', body: jobInput(context, { type: 'file', sourcePath: socketPath }) }), 400, 'SOURCE_NOT_FILE');
});

test('clone preserves secrets and every site link while an active source and its timestamps/history stay unchanged', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const secrets = [archiveSecret, 'vaultwarden-clone-fixture-secret', 'newapi-main-clone-fixture-secret', 'newapi-log-clone-fixture-secret'];
  const source = context.store.saveJob(jobInput(context, {
    description: 'Copy this configuration', tags: ['prod', 'shared'],
    watch: { enabled: true, mode: 'incremental', debounceSeconds: 11 },
    schedule: { enabled: true, cron: '0 4 * * *', timezone: 'Asia/Shanghai' },
    retention: { days: 40, keepLast: 9 }, retry: { attempts: 2, delaySeconds: 8 },
    vaultwarden: { database: { password: secrets[1] } },
    newapi: { database: { password: secrets[2] }, logDatabase: { password: secrets[3] } },
  }));
  const unrelated = context.store.saveJob(jobInput(context, { name: 'Unrelated task' }));
  const firstSite = context.store.saveSite({ name: 'First shared site', domains: ['first.example.com'], tags: ['site'], notes: 'Keep site metadata', repositoryUrls: ['https://github.com/fixture/site'], backupJobIds: [unrelated.id, source.id] });
  const secondSite = context.store.saveSite({ name: 'Second shared site', backupJobIds: [source.id] });
  context.store.saveWatchBaseline(source.id, source.sourcePath, { 'selected.conf': [23, 1000] });
  const historical = context.store.createRun(source, 'manual');
  context.store.updateRun(historical.id, { status: 'succeeded', finishedAt: '2025-01-01T00:00:00.000Z', cleanupStatus: 'cleaned', notificationStatus: 'disabled', archiveName: 'original.7z', targets: [{ destinationId: source.destinations[0].id, remote: 'test', path: 'original-owned-archive', status: 'verified' }] });
  context.store.appendLog(historical.id, { message: 'Original history remains owned by source' });
  const active = context.store.createRun(source, 'schedule');
  context.store.updateRun(active.id, { status: 'running', startedAt: new Date().toISOString() });
  const before = context.store.getJob(source.id, { includeSecrets: true });
  const beforeRuns = context.store.listRuns({ jobId: source.id });
  const beforeBaseline = context.store.getWatchBaseline(source.id, source.sourcePath);
  const calls = { ...context.calls };
  const response = await context.request(`/jobs/${source.id}/clone`, { method: 'POST' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const clone = response.data;
  assert.notEqual(clone.id, source.id);
  assert.notEqual(clone.name, source.name);
  assert.equal(clone.enabled, false);
  assert.equal(clone.lastRun, null);
  assert.equal(clone.nextRunAt, null);
  assert.ok(Number.isFinite(Date.parse(clone.createdAt)) && Number.isFinite(Date.parse(clone.updatedAt)));
  assert.deepEqual(context.calls, calls, 'clone neither queues a run nor refreshes scheduler/watchers');
  assert.deepEqual(context.store.getJob(source.id, { includeSecrets: true }), before, 'even original updatedAt/lastRun/nextRunAt remain unchanged');
  assert.deepEqual(context.store.listRuns({ jobId: source.id }), beforeRuns);
  assert.deepEqual(context.store.getWatchBaseline(source.id, source.sourcePath), beforeBaseline);
  assert.deepEqual(context.store.listRuns({ jobId: clone.id }), { items: [], total: 0 });
  assert.equal(context.store.getWatchBaseline(clone.id, clone.sourcePath), null);
  assert.equal(existsSync(path.join(context.config.tempDir, clone.id)), false);
  const privateClone = context.store.getJob(clone.id, { includeSecrets: true });
  for (const field of ['type', 'sourcePath', 'description', 'tags', 'destinations', 'archive', 'vaultwarden', 'newapi', 'schedule', 'watch', 'retention', 'retry', 'notification', 'excludes']) assert.deepEqual(privateClone[field], before[field], `${field} configuration survives`);
  for (const secret of secrets) assert.equal(JSON.stringify(clone).includes(secret), false, 'HTTP clone result never returns plaintext secrets');
  assert.equal(clone.archive.passwordSet, true);
  assert.equal(clone.vaultwarden.database.passwordSet, true);
  assert.equal(clone.newapi.database.passwordSet, true);
  assert.equal(clone.newapi.logDatabase.passwordSet, true);
  for (const site of [firstSite, secondSite]) {
    const after = context.store.getSite(site.id);
    assert.deepEqual(after.backupJobIds, [...site.backupJobIds, clone.id], 'copy the reverse job-to-sites relation, preserving existing links');
    assert.deepEqual({ ...after, backupJobIds: site.backupJobIds }, site, 'site metadata/timestamps are not rewritten');
  }
  const raw = rawDatabase(context);
  try {
    const encoded = raw.prepare('SELECT data FROM jobs WHERE id=?').get(clone.id).data;
    for (const secret of secrets) assert.equal(encoded.includes(secret), false, 'clone secrets are encrypted at rest');
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw.close(); }
  assert.equal((await context.request(`/jobs/${clone.id}`, { method: 'PATCH', body: { name: 'Independent clone edit' } })).status, 200);
  assert.deepEqual(context.store.getJob(source.id, { includeSecrets: true }), before);
  assert.equal((await context.request(`/jobs/${clone.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(context.store.getSite(firstSite.id), firstSite);
  assert.deepEqual(context.store.listRuns({ jobId: source.id }), beforeRuns);
});

test('clone auth, strict body, missing/system source and UTF-16 name boundaries create no phantom jobs', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const source = context.store.saveJob(jobInput(context, { name: '😀'.repeat(50) }));
  assert.equal(source.name.length, 100);
  const count = context.store.listJobs().length;
  assertError(await context.request(`/jobs/${source.id}/clone`, { method: 'POST', authenticated: false }), 401, 'UNAUTHENTICATED');
  assertError(await context.request(`/jobs/${source.id}/clone`, { method: 'POST', csrf: false }), 403, 'CSRF_INVALID');
  const foreignOrigin = await context.request(`/jobs/${source.id}/clone`, { method: 'POST', origin: 'https://foreign.example.com' });
  assert.equal(foreignOrigin.status, 403);
  assertError(await context.request('/jobs/missing-id/clone', { method: 'POST' }), 404, 'JOB_NOT_FOUND');
  assertError(await context.request('/jobs/system-config/clone', { method: 'POST' }), 409, 'SYSTEM_JOB_CLONE_FORBIDDEN');
  for (const body of [{ name: '' }, { name: 'x'.repeat(101) }, { enabled: true }, { id: source.id }, { name: 'override', archive: { password: 'override-secret' } }, []]) {
    assertError(await context.request(`/jobs/${source.id}/clone`, { method: 'POST', body }), 400, 'VALIDATION_FAILED');
  }
  assert.equal(context.store.listJobs().length, count, 'rejected clones leave no job');
  const generated = await context.request(`/jobs/${source.id}/clone`, { method: 'POST' });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.ok(generated.data.name.length <= 100, 'emoji names obey the schema UTF-16 length limit after appending a suffix');
  assert.equal(generated.data.name.isWellFormed(), true, 'truncation must not split a surrogate pair');
  const custom = await context.request(`/jobs/${source.id}/clone`, { method: 'POST', body: { name: '  Named copy  ' } });
  assert.equal(custom.status, 201);
  assert.equal(custom.data.name, 'Named copy');
});

test('clone keeps actual Vaultwarden and new-api database credentials privately', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const env = path.join(context.source, '.env');
  await writeFile(env, 'CRYPTO_SECRET=fixture-env-value\n');
  const inputs = [
    { type: 'vaultwarden', vaultwarden: { dataDir: context.source, dbType: 'postgresql', database: { host: 'db.example.test', name: 'vaultwarden', username: 'backup', password: 'vaultwarden-db-fixture' } } },
    { type: 'newapi', newapi: { dataDir: context.source, envFilePath: env, dbType: 'postgresql', database: { host: 'db.example.test', name: 'new-api', username: 'backup', password: 'newapi-main-db-fixture' }, logDbType: 'mysql', logDatabase: { host: 'logs.example.test', name: 'logs', username: 'backup', password: 'newapi-log-db-fixture' } } },
  ];
  for (const input of inputs) {
    const created = await context.request('/jobs', { method: 'POST', body: jobInput(context, input) });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const before = context.store.getJob(created.data.id, { includeSecrets: true });
    const response = await context.request(`/jobs/${before.id}/clone`, { method: 'POST', body: { name: `${input.type} clone` } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const privateCopy = context.store.getJob(response.data.id, { includeSecrets: true });
    assert.deepEqual(privateCopy[input.type], before[input.type]);
    assert.equal(privateCopy.archive.password, archiveSecret);
    assert.equal(response.data.enabled, false);
    for (const password of [archiveSecret, input.vaultwarden?.database.password, input.newapi?.database.password, input.newapi?.logDatabase.password].filter(Boolean)) assert.equal(JSON.stringify(response.data).includes(password), false);
  }
});

test('a paused file clone can keep an absent allowed source while pause/enable and source deletion stay independent', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const source = context.store.saveJob(jobInput(context, { type: 'file', sourcePath: context.selected }));
  await rm(context.selected);
  const response = await context.request(`/jobs/${source.id}/clone`, { method: 'POST' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const clone = response.data;
  assert.equal(clone.type, 'file');
  assert.equal(clone.sourcePath, source.sourcePath);
  assert.equal(clone.enabled, false);
  assert.equal((await context.request(`/jobs/${source.id}`, { method: 'PATCH', body: { enabled: false } })).status, 200);
  assertError(await context.request(`/jobs/${clone.id}`, { method: 'PATCH', body: { enabled: true } }), 404, 'SOURCE_PATH_MISSING');
  await mkdir(context.selected);
  assertError(await context.request(`/jobs/${source.id}/clone`, { method: 'POST' }), 400, 'SOURCE_NOT_FILE');
  await rm(context.selected, { recursive: true });
  await writeFile(context.selected, 'Source restored\n');
  const site = context.store.saveSite({ name: 'Shared file site', backupJobIds: [source.id, clone.id] });
  assert.equal((await context.request(`/jobs/${source.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(context.store.getJob(clone.id, { includeSecrets: true }).archive.password, archiveSecret);
  assert.deepEqual(context.store.getSite(site.id).backupJobIds, [clone.id]);
});

test('clone rejects the 200-job site cap atomically even when another linked site has room', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const source = context.store.saveJob(jobInput(context));
  const room = context.store.saveSite({ name: 'Room for a copy', backupJobIds: [source.id] });
  const ids = [source.id];
  while (ids.length < SITE_BACKUP_JOB_LIMIT) ids.push(context.store.saveJob(jobInput(context, { name: `Existing ${ids.length}` })).id);
  const full = context.store.saveSite({ name: 'Full site', backupJobIds: ids });
  const beforeJobs = context.store.listJobs();
  assertError(await context.request(`/jobs/${source.id}/clone`, { method: 'POST' }), 409, 'SITE_JOB_LIMIT_REACHED');
  assert.deepEqual(context.store.listJobs(), beforeJobs);
  assert.deepEqual(context.store.getSite(room.id), room);
  assert.deepEqual(context.store.getSite(full.id), full);
});

test('an actual SQLite relation insertion failure rolls back the new clone and every link', async t => {
  const context = await apiFixture();
  t.after(() => context.close());
  const source = context.store.saveJob(jobInput(context));
  const first = context.store.saveSite({ name: 'First linked site', backupJobIds: [source.id] });
  const second = context.store.saveSite({ name: 'Second linked site', backupJobIds: [source.id] });
  const beforeJobs = context.store.listJobs();
  const raw = rawDatabase(context);
  try {
    raw.exec(`CREATE TRIGGER fail_clone_second_link BEFORE INSERT ON site_jobs
      WHEN NEW.site_id = '${second.id}' AND (SELECT json_extract(data,'$.name') FROM jobs WHERE id=NEW.job_id) = 'Failing clone'
      BEGIN SELECT RAISE(ABORT, 'fixture clone link insertion failed'); END;`);
    const response = await context.request(`/jobs/${source.id}/clone`, { method: 'POST', body: { name: 'Failing clone' } });
    assert.equal(response.status, 500, JSON.stringify(response.data));
    assert.deepEqual(context.store.listJobs(), beforeJobs, 'the job INSERT is rolled back, not just its links');
    assert.deepEqual(context.store.getSite(first.id), first, 'a first successful link INSERT is also rolled back');
    assert.deepEqual(context.store.getSite(second.id), second);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw.exec('DROP TRIGGER fail_clone_second_link'); raw.close(); }
});

test('file execution rechecks a deleted or wrong-type source and cleans staging without uploading', async t => {
  const context = await stateFixture();
  const remoteCalls = [];
  const service = createBackupService({ store: context.store, config: context.config, rclone: { async listRemotes() { remoteCalls.push('list'); return []; } }, runTool: async () => { assert.fail('Invalid file sources must fail before invoking archive tools.'); } });
  t.after(async () => { await service.shutdown(); context.store.close(); await rm(context.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  for (const replacement of ['missing', 'directory']) {
    const file = path.join(context.source, `${replacement}.dump`);
    await writeFile(file, 'Saved while regular\n');
    const job = context.store.saveJob(jobInput(context, { type: 'file', sourcePath: file, notification: { failure: false } }));
    await rm(file);
    if (replacement === 'directory') await mkdir(file);
    const run = await finish(context.store, service.enqueue(job.id).id);
    assert.equal(run.status, 'failed', JSON.stringify(run));
    assert.match(run.error, replacement === 'missing' ? /does not exist/ : /regular file/);
    assert.equal(run.cleanupStatus, 'cleaned');
    assert.equal(run.archiveName, null);
    assert.ok(run.targets.every(target => target.status !== 'verified'));
    await assert.rejects(access(path.join(context.config.tempDir, job.id, run.id)), { code: 'ENOENT' });
  }
  assert.deepEqual(remoteCalls, []);
});

test('real encrypted file backup extracts only the selected basename, preserves exact bytes and supports empty files', { skip: !realIntegration, timeout: 120000 }, async t => {
  const context = await stateFixture();
  const remote = path.join(context.root, 'remote');
  await mkdir(remote);
  const sourceConfig = path.join(context.root, 'rclone-source.conf');
  await writeFile(sourceConfig, `[test]\ntype = alias\nremote = ${remote.replace(/\\/g, '/')}\n`);
  const rclone = createRcloneService({ config: context.config, getSettings: () => context.store.getSettings({ includeSecrets: true }), saveSettings: patch => context.store.saveSettings(patch) });
  await rclone.importConfig(sourceConfig);
  const service = createBackupService({ store: context.store, config: context.config, rclone });
  t.after(async () => { await service.shutdown(); context.store.close(); await rm(context.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const fixtures = [{ name: '-配置 settings.bin', contents: Buffer.concat([Buffer.from([0, 255, 1, 0]), Buffer.from('Exact UTF-8 bytes\n')]) }, { name: 'empty.dump', contents: Buffer.alloc(0) }];
  for (const [index, fixture] of fixtures.entries()) {
    const selected = path.join(context.source, fixture.name);
    await writeFile(selected, fixture.contents);
    await chmod(selected, 0o640);
    const timestamp = new Date('2024-01-02T03:04:06.000Z');
    await utimes(selected, timestamp, timestamp);
    const before = await stat(selected);
    const job = context.store.saveJob(jobInput(context, { name: `File round trip ${index}`, type: 'file', sourcePath: selected, destinations: [{ remote: 'test', path: `single-file/${index}` }], retry: { attempts: 1, delaySeconds: 1 } }));
    const run = await finish(context.store, service.enqueue(job.id, index ? 'schedule' : 'manual').id, 90000);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(run.cleanupStatus, 'cleaned');
    assert.equal(run.targets[0].status, 'verified');
    const archive = path.join(remote, ...run.targets[0].path.split('/'));
    await assert.rejects(runProcess(sevenZipBinary, ['t', archive, '-pwrong-fixture-password', '-y']));
    const outer = path.join(context.root, `outer-${index}`);
    const restored = path.join(context.root, `restored-${index}`);
    await mkdir(outer); await mkdir(restored);
    await runProcess(sevenZipBinary, ['x', archive, `-o${outer}`, `-p${archiveSecret}`, '-y'], { secrets: [archiveSecret] });
    const payloadNames = await readdir(outer);
    assert.equal(payloadNames.length, 1, 'outer archive contains only the one-file tar payload');
    assert.match(payloadNames[0], /^file\..+\.tar$/);
    const inner = path.join(outer, payloadNames[0]);
    const listing = await runProcess('tar', ['-tf', inner]);
    // A platform tar may use a different encoding for its text listing than
    // runProcess's UTF-8 decoder. Extracted filesystem names below are authoritative.
    assert.equal(listing.stdout.trim().split(/\r?\n/).length, 1, 'inner tar has exactly one member');
    await runProcess('tar', ['-xf', inner, '-C', restored]);
    assert.deepEqual(await readdir(restored), [fixture.name], 'no sibling or source directory is included');
    const restoredBytes = await readFile(path.join(restored, fixture.name));
    assert.deepEqual(restoredBytes, fixture.contents);
    assert.equal(sha256(restoredBytes), sha256(fixture.contents));
    const after = await stat(path.join(restored, fixture.name));
    assert.equal(Math.floor(after.mtimeMs / 1000), Math.floor(before.mtimeMs / 1000));
    if (process.platform !== 'win32') assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(JSON.stringify(context.store.getRun(run.id)).includes(archiveSecret), false);
    await assert.rejects(access(path.join(context.config.tempDir, job.id, run.id)), { code: 'ENOENT' });
  }
});
