// Site inventory + many-to-many backup-task association acceptance.
//
// Everything here goes through the real shared contract, the real express
// routes and the real SQLite store; the system-restore cases rebuild a real
// state database and run the real restore machinery (no mocked restore).
//
// Contract pinned by .trellis/tasks/10-24-site-management/design.md:
//   SiteInput { name, domains[], tags[], backupJobIds[] }
//   Site      = SiteInput + { id, createdAt, updatedAt }
//   domains   -> normalized absolute HTTP(S) hrefs, deduplicated
//   backupJobIds -> a projection of site_jobs, never stored in site JSON
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, statSync, rmSync, existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createRcloneService } from '../server/rclone.mjs';
import { createBackupService } from '../server/backup.mjs';
import { applyPendingSystemRestore, stageSystemRestore } from '../server/system-restore.mjs';

const rcloneBinary = process.env.RCLONE_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/rclone-v1.75.1-windows-amd64/rclone.exe') : 'rclone');
const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/7zip/x64/7za.exe') : '7z');
const liveTools = process.platform !== 'win32' || (existsSync(rcloneBinary) && existsSync(sevenZipBinary));

function setupFiles(prefix = 'azurekiln-sites-') {
  const folder = mkdtempSync(path.join(os.tmpdir(), prefix));
  const config = loadConfig({ SOURCE_ROOTS: path.join(folder, 'sources'), DATA_DIR: path.join(folder, 'data') }, folder);
  mkdirSync(path.join(config.sourceRoots[0], 'directory-a'));
  mkdirSync(path.join(config.sourceRoots[0], 'directory-b'));
  // The real system snapshot includes an rclone config; the mocked rclone below
  // never reads it, but the restore bundle format requires the file to exist.
  writeFileSync(config.rcloneConfigPath, '[fixture]\ntype = alias\nremote = /tmp/fixture\n');
  return { folder, config };
}

function mocks(config, store) {
  const scheduler = { start() {}, stop() {}, refresh() {} };
  const backupService = {
    isJobActive() { return false; },
    enqueue(jobId, trigger) { return store.createRun(store.getJob(jobId), trigger); },
    async cancel(id) { store.updateRun(id, { status: 'cancelled' }); },
    async shutdown() {}, async getArchives() { return []; },
    async storage() { return { tempBytes: 0, retainedBytes: 0, localArchives: [], ...store.getSettings().storage }; },
    async clearLocalArchive() { return { cleaned: true }; },
    async clearLocalArchives() { return { cleaned: 0 }; },
    async health() { return { rclone: { available: false, error: 'Tool not installed.' }, sqlite: { available: true, version: 'native' } }; },
  };
  const rclone = {
    async status() { return { available: false, configured: false, version: null, configPath: config.rcloneConfigPath, error: 'Tool not installed.' }; },
    async listRemotes() { throw Object.assign(new Error('rclone is not installed.'), { status: 503, code: 'TOOL_MISSING' }); },
  };
  return { scheduler, backupService, rclone };
}

/**
 * Real app + store on a real temporary data directory. `boot()`/`shutdown()`
 * allow a restart on the same state; the cookie jar survives a restart so the
 * same administrator session can be reused after a system restore.
 */
async function fixture({ init, session: seedSession = '', csrfToken: seedCsrf = '' } = {}) {
  const { folder, config } = init ?? setupFiles();
  let session = seedSession;
  let csrfToken = seedCsrf;
  let url = '';
  let current = null;

  const request = async (route, { method = 'GET', body, csrf = true, origin, useSession = true, extraCookie = '' } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (useSession && session) headers.cookie = session;
    if (extraCookie) headers.cookie = [headers.cookie, extraCookie].filter(Boolean).join('; ');
    if (csrf && csrfToken) headers['x-csrf-token'] = csrfToken;
    if (origin) headers.origin = origin;
    const response = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('backup_session=')) session = cookie.split(';')[0];
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data, response };
  };

  const boot = async () => {
    const store = createStore(config);
    const runtime = await createApp({ config, store, ...mocks(config, store) });
    const server = await new Promise((resolve) => { const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance)); });
    url = `http://127.0.0.1:${server.address().port}`;
    config.publicUrl = url;
    current = { store, runtime, server };
    return current;
  };
  const shutdown = async () => {
    if (!current) return;
    await current.runtime.close();
    await new Promise((resolve) => current.server.close(resolve));
    current.store.close();
    current = null;
  };

  await boot();
  return {
    folder, config, request, boot, shutdown,
    setup: () => request('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password' } }),
    get store() { return current?.store; },
    get runtime() { return current?.runtime; },
    get session() { return session; },
    get csrfToken() { return csrfToken; },
    async close() { await shutdown(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

function inputJob(config, extra = {}) {
  return {
    name: 'Directory A', type: 'directory',
    sourcePath: path.join(config.sourceRoots[0], 'directory-a'),
    destinations: [{ remote: 'AB', path: 'backups/A' }],
    archive: { format: '7z', encrypted: true, password: 'private-archive-password' },
    ...extra,
  };
}

const asUrl = (value, label) => {
  assert.equal(typeof value, 'string', `${label}: domain must be a string`);
  try { return new URL(value); } catch { assert.fail(`${label}: expected an absolute HTTP(S) href, got ${JSON.stringify(value)}`); }
};

const siteInput = (patch = {}) => ({ name: 'Site', domains: [], tags: [], backupJobIds: [], ...patch });

const createJob = async (context, patch = {}) => {
  const created = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, patch) });
  assert.equal(created.status, 201, `job create: ${JSON.stringify(created.data)}`);
  return created.data;
};

const createSite = async (context, patch = {}) => {
  const created = await context.request('/api/sites', { method: 'POST', body: siteInput(patch) });
  assert.equal(created.status, 201, `site create: ${JSON.stringify(created.data)}`);
  return created.data;
};

const foreignKeyViolations = (statePath) => {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return db.prepare('PRAGMA foreign_key_check').all(); } finally { db.close(); }
};

test('site CRUD persists exact values and links one job to several sites and one site to several jobs', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await context.request('/api/sites')).status, 401);
  await context.setup();
  assert.deepEqual((await context.request('/api/sites')).data, []);

  const jobA = await createJob(context, { name: 'Database A', tags: ['job-only'] });
  const jobB = await createJob(context, { name: 'Files A', sourcePath: path.join(context.config.sourceRoots[0], 'directory-b'), destinations: [{ remote: 'AB', path: 'backups/F' }] });

  const siteOne = await createSite(context, {
    name: '  Example Site  ',
    domains: ['example.com', 'https://Admin.Example.com/Login?ReturnUrl=%2Fapp', 'example.com'],
    tags: [' Web ', 'web', 'prod'],
    backupJobIds: [jobA.id, jobB.id, jobA.id],
  });
  assert.equal(siteOne.name, 'Example Site', 'names are trimmed');
  assert.equal(typeof siteOne.id, 'string');
  assert.ok(!Number.isNaN(Date.parse(siteOne.createdAt)), 'createdAt is an ISO timestamp');
  assert.ok(!Number.isNaN(Date.parse(siteOne.updatedAt)), 'updatedAt is an ISO timestamp');
  assert.deepEqual(siteOne.tags, ['Web', 'prod'], 'site tags reuse the case-insensitive dedupe keeping the first spelling');
  assert.deepEqual([...siteOne.backupJobIds].sort(), [jobA.id, jobB.id].sort(), 'duplicate job ids collapse');

  // Addresses normalize to absolute HTTP(S) hrefs. A bare host defaults to HTTPS.
  assert.equal(siteOne.domains.length, 2, `bare host and explicit https href dedupe to one entry: ${JSON.stringify(siteOne.domains)}`);
  const [firstDomain, secondDomain] = siteOne.domains;
  const first = asUrl(firstDomain, 'bare host');
  assert.equal(first.protocol, 'https:', 'bare host defaults to https');
  assert.equal(first.hostname, 'example.com');
  // Case-sensitive path/query semantics must survive normalization.
  const explicit = siteOne.domains.map((domain) => asUrl(domain, 'explicit')).find((url) => url.pathname !== '/');
  assert.ok(explicit, `the explicit path href is preserved: ${JSON.stringify(siteOne.domains)}`);
  assert.equal(explicit.hostname, 'admin.example.com', 'hostnames are normalized to lower case');
  assert.equal(explicit.pathname, '/Login', 'path case is preserved');
  assert.equal(explicit.searchParams.get('ReturnUrl'), '/app');

  const siteTwo = await createSite(context, { name: 'Shared Site', domains: [], tags: ['prod'], backupJobIds: [jobA.id] });
  assert.deepEqual(siteTwo.domains, [], 'a site may start without addresses');
  assert.deepEqual(siteTwo.backupJobIds, [jobA.id]);

  const list = (await context.request('/api/sites')).data;
  assert.equal(list.length, 2);
  const readOne = (await context.request(`/api/sites/${siteOne.id}`)).data;
  assert.deepEqual(readOne, siteOne, 'GET by id returns the authoritative record');
  const shared = list.find((site) => site.id === siteTwo.id);
  assert.deepEqual(shared.backupJobIds, [jobA.id], 'the same job is linked to a second site without being transferred');
  const multi = list.find((site) => site.id === siteOne.id);
  assert.equal(multi.backupJobIds.length, 2, 'one site keeps several jobs');

  // Site tags are independent of job tags: neither value set leaks into the other.
  const jobs = (await context.request('/api/jobs')).data;
  assert.deepEqual(jobs.find((job) => job.id === jobA.id).tags, ['job-only'], 'binding jobs never rewrites job tags');
  assert.equal(JSON.stringify(list).includes('job-only'), false, 'job tags are not copied into sites');
  assert.equal(JSON.stringify(list).includes('private-archive-password'), false, 'site payloads expose no secrets');

  // The whole record survives a restart.
  await context.shutdown();
  await context.boot();
  const reopened = (await context.request('/api/sites')).data;
  assert.deepEqual(reopened.find((site) => site.id === siteOne.id), siteOne, 'sites and links persist across a store reopen');

  // The relation table is the single source of truth: link ids are never
  // duplicated into the site JSON blob.
  const rawDb = new DatabaseSync(path.join(context.config.dataDir, 'state.sqlite'), { readOnly: true });
  try {
    for (const row of rawDb.prepare('SELECT data FROM sites').all()) {
      const stored = JSON.parse(row.data);
      assert.equal(Object.prototype.hasOwnProperty.call(stored, 'backupJobIds'), false, 'backupJobIds is not duplicated into site JSON');
    }
    assert.equal(rawDb.prepare('SELECT site_id,job_id FROM site_jobs').all().length, 3, 'site_jobs holds exactly the projected link set');
  } finally { rawDb.close(); }
  assert.deepEqual(foreignKeyViolations(path.join(context.config.dataDir, 'state.sqlite')), []);
});

test('site validation rejects unsafe addresses, oversized fields and unknown jobs without partial writes', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const job = await createJob(context);

  const bad = async (patch, label, expectedCode) => {
    const response = await context.request('/api/sites', { method: 'POST', body: siteInput(patch) });
    assert.ok(response.status >= 400 && response.status < 500, `${label}: expected a client error, got ${response.status}`);
    assert.ok(response.data?.error?.code, `${label}: error carries a stable code`);
    if (expectedCode) assert.equal(response.data.error.code, expectedCode, `${label}: stable error code`);
  };

  await bad({ name: '' }, 'empty name');
  await bad({ name: '   ' }, 'whitespace name');
  await bad({ name: 'x'.repeat(101) }, 'name longer than 100');
  await bad({ domains: ['ftp://example.com'] }, 'unsupported scheme');
  await bad({ domains: ['javascript:alert(1)'] }, 'javascript scheme');
  await bad({ domains: ['file:///etc/passwd'] }, 'file scheme');
  await bad({ domains: ['https://user:password@example.com'] }, 'embedded credentials');
  await bad({ domains: ['   '] }, 'blank address');
  await bad({ domains: Array.from({ length: 21 }, (_, index) => `example${index}.com`) }, 'more than 20 addresses');
  await bad({ domains: [`https://example.com/${'a'.repeat(2048)}`] }, 'address longer than 2048');
  await bad({ tags: ['a,b'] }, 'tag with a comma');
  await bad({ tags: Array.from({ length: 11 }, (_, index) => `t${index}`) }, 'more than 10 tags');
  await bad({ tags: ['x'.repeat(33)] }, 'tag longer than 32');
  await bad({ backupJobIds: ['missing-job-id'] }, 'unknown job id', 'SITE_JOB_NOT_FOUND');
  await bad({ backupJobIds: [job.id, 'missing-job-id'] }, 'unknown job id among valid ones', 'SITE_JOB_NOT_FOUND');

  assert.deepEqual((await context.request('/api/sites')).data, [], 'no rejected create left a record behind');

  // A rejected update must leave the previous record and links untouched, even
  // when the invalid request also carried other field changes.
  const site = await createSite(context, { name: 'Stable', domains: ['stable.example.com'], tags: ['keep'], backupJobIds: [job.id] });
  const rejected = await context.request(`/api/sites/${site.id}`, { method: 'PATCH', body: { name: 'Should not apply', backupJobIds: ['missing-job-id'] } });
  assert.ok(rejected.status >= 400 && rejected.status < 500, `transactional update rejected: ${rejected.status}`);
  const unchanged = (await context.request(`/api/sites/${site.id}`)).data;
  assert.equal(unchanged.name, 'Stable', 'a failed update does not apply the rest of the patch');
  assert.deepEqual(unchanged.backupJobIds, [job.id], 'a failed update does not drop the existing relation');
  assert.deepEqual(unchanged.updatedAt, site.updatedAt, 'a failed update does not rewrite the timestamp');

  // Kept jobs stay eligible even when paused/offline, and the built-in system
  // task is allowed as clearly-labelled metadata.
  const paused = await createJob(context, { name: 'Paused', enabled: false });
  const withSystem = await createSite(context, { name: 'Eligible', backupJobIds: [paused.id, 'system-config'] });
  assert.deepEqual([...withSystem.backupJobIds].sort(), [paused.id, 'system-config'].sort());
});

test('safe URL fragments are preserved instead of being rejected', async (t) => {
  // The approved contract only forbids unsupported schemes and embedded
  // credentials. A same-origin fragment is safe navigation metadata, so it must
  // survive normalization rather than being blocked by an extra restriction.
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const response = await context.request('/api/sites', { method: 'POST', body: siteInput({ name: 'Docs', domains: ['https://docs.example.com/guide#install'], tags: [], backupJobIds: [] }) });
  assert.equal(response.status, 201, `fragment address accepted: ${JSON.stringify(response.data)}`);
  const saved = asUrl(response.data.domains[0], 'fragment domain');
  assert.equal(saved.pathname, '/guide');
  assert.equal(saved.hash, '#install', 'the safe fragment is preserved');
});

test('PATCH merges omitted fields, replaces supplied arrays and keeps tags independent', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const jobA = await createJob(context, { name: 'Task One' });
  const jobB = await createJob(context, { name: 'Task Two', sourcePath: path.join(context.config.sourceRoots[0], 'directory-b') });
  const site = await createSite(context, { name: 'Original', domains: ['original.example.com'], tags: ['one', 'two'], backupJobIds: [jobA.id] });

  const renamed = await context.request(`/api/sites/${site.id}`, { method: 'PATCH', body: { name: 'Renamed' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.name, 'Renamed');
  assert.deepEqual(renamed.data.domains, site.domains, 'omitted domains are retained');
  assert.deepEqual(renamed.data.tags, ['one', 'two'], 'omitted tags are retained');
  assert.deepEqual(renamed.data.backupJobIds, [jobA.id], 'omitted links are retained');
  assert.equal(renamed.data.createdAt, site.createdAt, 'createdAt is stable');

  const replaced = await context.request(`/api/sites/${site.id}`, { method: 'PATCH', body: { domains: ['new.example.com'], tags: ['three'], backupJobIds: [jobB.id, jobA.id] } });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
  assert.deepEqual(replaced.data.backupJobIds, [jobB.id, jobA.id], 'supplied link array replaces the set');
  assert.deepEqual(replaced.data.tags, ['three'], 'supplied tag array replaces the set');
  assert.equal(asUrl(replaced.data.domains[0], 'replaced domain').hostname, 'new.example.com');

  const cleared = await context.request(`/api/sites/${site.id}`, { method: 'PATCH', body: { domains: [], tags: [], backupJobIds: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.domains, [], 'empty array clears addresses');
  assert.deepEqual(cleared.data.tags, [], 'empty array clears tags');
  assert.deepEqual(cleared.data.backupJobIds, [], 'empty array clears links');

  // Job tags are never touched by site edits.
  const jobs = (await context.request('/api/jobs')).data;
  assert.deepEqual(jobs.find((job) => job.id === jobA.id).tags, [], 'site edits never write job tags');
});

test('site API requires authentication and CSRF and returns 404 for unknown members', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await context.request('/api/sites')).status, 401);
  assert.equal((await context.request('/api/sites/anything')).status, 401);
  assert.equal((await context.request('/api/sites', { method: 'POST', body: siteInput(), useSession: false })).status, 401);
  await context.setup();
  assert.equal((await context.request('/api/sites', { method: 'POST', body: siteInput({ name: 'No CSRF' }), csrf: false })).status, 403);
  assert.equal((await context.request('/api/sites', { method: 'POST', body: siteInput({ name: 'Bad origin' }), origin: 'https://evil.example' })).status, 403);
  assert.equal((await context.request('/api/sites/does-not-exist')).status, 404);
  assert.equal((await context.request('/api/sites/does-not-exist')).data.error.code, 'SITE_NOT_FOUND');
  assert.equal((await context.request('/api/sites/does-not-exist', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  assert.equal((await context.request('/api/sites/does-not-exist', { method: 'PATCH', body: { name: 'x' } })).data.error.code, 'SITE_NOT_FOUND');
  assert.equal((await context.request('/api/sites/does-not-exist', { method: 'DELETE' })).status, 404);
  const created = await createSite(context, { name: 'CSRF target' });
  assert.equal((await context.request(`/api/sites/${created.id}`, { method: 'PATCH', body: { name: 'y' }, csrf: false })).status, 403, 'PATCH requires CSRF');
  assert.equal((await context.request(`/api/sites/${created.id}`, { method: 'DELETE', csrf: false })).status, 403, 'DELETE requires CSRF');
  assert.equal((await context.request(`/api/sites/${created.id}`, { method: 'DELETE' })).status, 204);
  // Site writes never mutate the scheduler-driven job state.
  const job = await createJob(context);
  const site = await createSite(context, { name: 'No side effects', backupJobIds: [job.id] });
  const after = (await context.request(`/api/jobs/${job.id}`)).data;
  assert.equal(after.updatedAt, job.updatedAt, 'creating a relation does not rewrite the job timestamp');
  assert.equal(after.enabled, job.enabled, 'creating a relation does not toggle the job');
  assert.equal(after.schedule.enabled, job.schedule.enabled, 'creating a relation does not reschedule the job');
  assert.equal((await context.request(`/api/sites/${site.id}`, { method: 'DELETE' })).status, 204);
});

test('deleting a site keeps jobs, runs and other sites; deleting a job unlinks every site without rewriting timestamps', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const jobA = await createJob(context, { name: 'Alpha' });
  const jobB = await createJob(context, { name: 'Beta', sourcePath: path.join(context.config.sourceRoots[0], 'directory-b') });
  const system = (await context.request('/api/jobs')).data.find((job) => job.type === 'system');
  assert.equal(system.id, 'system-config');

  const siteOne = await createSite(context, { name: 'One', domains: ['one.example.com'], tags: ['prod'], backupJobIds: [jobA.id, jobB.id] });
  const siteTwo = await createSite(context, { name: 'Two', domains: ['two.example.com'], tags: ['prod'], backupJobIds: [jobA.id, jobB.id] });

  // A queued run exists for job A. Deleting a site must not touch it.
  const run = context.store.createRun(context.store.getJob(jobA.id));
  assert.equal(run.status, 'queued');

  assert.equal((await context.request(`/api/sites/${siteOne.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await context.request(`/api/sites/${siteOne.id}`)).status, 404);
  const jobsAfterSiteDelete = (await context.request('/api/jobs')).data.map((job) => job.id);
  assert.ok(jobsAfterSiteDelete.includes(jobA.id) && jobsAfterSiteDelete.includes(jobB.id), 'deleting a site never deletes its jobs');
  assert.equal(context.store.getRun(run.id).status, 'queued', 'deleting a site never cancels or deletes runs');
  const siteTwoBefore = (await context.request(`/api/sites/${siteTwo.id}`)).data;
  assert.deepEqual(siteTwoBefore.backupJobIds, [jobA.id, jobB.id], "deleting one site never unlinks another site's jobs");

  // Deleting a job cleans every link but keeps each site's metadata and links.
  assert.equal((await context.request(`/api/jobs/${jobB.id}`, { method: 'DELETE' })).status, 204);
  const siteTwoAfter = (await context.request(`/api/sites/${siteTwo.id}`)).data;
  assert.deepEqual(siteTwoAfter.backupJobIds, [jobA.id], 'deleting a job removes only its own relation rows');
  assert.equal(siteTwoAfter.name, siteTwoBefore.name);
  assert.deepEqual(siteTwoAfter.domains, siteTwoBefore.domains);
  assert.deepEqual(siteTwoAfter.tags, siteTwoBefore.tags);
  assert.equal(siteTwoAfter.updatedAt, siteTwoBefore.updatedAt, 'automatic unlink does not rewrite site metadata timestamps');
  assert.deepEqual(foreignKeyViolations(path.join(context.config.dataDir, 'state.sqlite')), [], 'no dangling relation rows after a job delete');

  // Existing job-delete protections still hold.
  assert.equal((await context.request(`/api/jobs/${system.id}`, { method: 'DELETE' })).status, 403, 'the system task stays protected');
  assert.equal((await context.request(`/api/jobs/${jobA.id}`, { method: 'DELETE' })).status, 409, 'a job with an active run stays protected');
  context.store.updateRun(run.id, { status: 'cancelled' });
  assert.equal((await context.request(`/api/jobs/${jobA.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await context.request(`/api/sites/${siteTwo.id}`)).data.backupJobIds, [], 'the final link is cleaned when the last job is deleted');
  assert.deepEqual(foreignKeyViolations(path.join(context.config.dataDir, 'state.sqlite')), []);
});

test('a database without site tables upgrades additively and keeps every existing job', async (t) => {
  const { folder, config } = setupFiles();
  let store = createStore(config);
  const job = store.saveJob(inputJob(config, { name: 'Legacy job' }));
  store.close();

  // Simulate a pre-feature database: the introduced site tables do not exist.
  const raw = new DatabaseSync(path.join(config.dataDir, 'state.sqlite'));
  try {
    raw.exec('DROP TABLE IF EXISTS site_jobs; DROP TABLE IF EXISTS sites;');
    const remaining = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sites','site_jobs')").all();
    assert.deepEqual(remaining, [], 'the legacy database really has no site tables');
  } finally { raw.close(); }

  const context = await fixture({ init: { folder, config } });
  t.after(() => context.close());
  await context.setup();
  assert.deepEqual((await context.request('/api/sites')).data, [], 'upgrading an old database yields an empty inventory');
  const jobs = (await context.request('/api/jobs')).data;
  assert.ok(jobs.some((item) => item.id === job.id && item.name === 'Legacy job'), 'legacy jobs survive the additive upgrade');
  // The recreated tables are usable and enforce referential integrity.
  const upgraded = await createSite(context, { name: 'Post-upgrade site', domains: ['upgraded.example.com'], tags: ['prod'], backupJobIds: [job.id] });
  assert.deepEqual(upgraded.backupJobIds, [job.id]);
  assert.deepEqual(foreignKeyViolations(path.join(config.dataDir, 'state.sqlite')), []);
});

async function snapshotState(config, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  const source = new DatabaseSync(path.join(config.dataDir, 'state.sqlite'), { readOnly: true, timeout: 10000 });
  try { await sqliteBackup(source, target, { rate: 64 }); } finally { source.close(); }
  const snapshot = new DatabaseSync(target);
  try {
    snapshot.exec('PRAGMA journal_mode=DELETE');
    const check = snapshot.prepare('PRAGMA integrity_check').all();
    assert.equal(Object.values(check[0])[0], 'ok', 'snapshot passes its integrity check');
  } finally { snapshot.close(); }
  return target;
}

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

/**
 * Build a real `system-restore-pending` bundle from a real state snapshot, in
 * the exact on-disk shape `applyPendingSystemRestore` consumes after startup.
 */
async function stageRealRestore(sourceConfig, pendingParent, statePath) {
  const pending = path.join(pendingParent, 'system-restore-pending');
  mkdirSync(pending, { recursive: true });
  copyFileSync(statePath, path.join(pending, 'state.sqlite'));
  copyFileSync(sourceConfig.masterKeyPath, path.join(pending, 'secret.key'));
  copyFileSync(sourceConfig.rcloneConfigPath, path.join(pending, 'rclone.conf'));
  const files = {};
  for (const name of ['state.sqlite', 'secret.key', 'rclone.conf']) {
    const file = path.join(pending, name);
    files[name] = { size: statSync(file).size, sha256: sha256(file) };
  }
  writeFileSync(path.join(pending, 'system.json'), JSON.stringify({ kind: 'azurekiln-system-config', version: 1, createdAt: new Date().toISOString(), files, backup: {} }, null, 2));
  writeFileSync(path.join(pending, 'import.json'), JSON.stringify({ archiveBytes: files['state.sqlite'].size, archiveSha256: 'a'.repeat(64) }));
  return pending;
}

function freshTargetConfig(sourceFolder) {
  const { folder, config } = setupFiles();
  return { folder, config, sourceFolder };
}

test('a current system snapshot restored through the real restore path keeps sites and relations', async (t) => {
  const context = await fixture();
  const target = freshTargetConfig(context.folder);
  t.after(async () => { await context.close(); rmSync(target.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await context.setup();
  const jobA = await createJob(context, { name: 'Restored DB' });
  const jobB = await createJob(context, { name: 'Restored Files', sourcePath: path.join(context.config.sourceRoots[0], 'directory-b') });
  const siteOne = await createSite(context, { name: 'Restored Site One', domains: ['one.example.com', 'https://two.example.com/Path'], tags: ['prod', 'web'], backupJobIds: [jobA.id, jobB.id] });
  const siteTwo = await createSite(context, { name: 'Restored Site Two', domains: [], tags: ['prod'], backupJobIds: [jobA.id] });
  const savedSites = (await context.request('/api/sites')).data;

  const statePath = await snapshotState(context.config, path.join(target.folder, 'snapshot', 'state.sqlite'));
  await stageRealRestore(context.config, target.config.dataDir, statePath);
  await context.shutdown();

  // Run the real restore machinery, then open the restored store.
  const restore = await applyPendingSystemRestore(target.config);
  assert.ok(restore, 'a pending restore bundle was applied');
  await restore.complete();

  const restored = await fixture({ init: { folder: target.folder, config: target.config }, session: context.session, csrfToken: context.csrfToken });
  try {
    const sites = (await restored.request('/api/sites')).data;
    const byId = new Map(sites.map((site) => [site.id, site]));
    assert.deepEqual(byId.get(siteOne.id), savedSites.find((site) => site.id === siteOne.id), 'site identities, domains, tags and links survive a real restore');
    assert.deepEqual(byId.get(siteTwo.id), savedSites.find((site) => site.id === siteTwo.id));
    assert.deepEqual([...byId.get(siteOne.id).backupJobIds].sort(), [jobA.id, jobB.id].sort());
    assert.deepEqual(byId.get(siteTwo.id).backupJobIds, [jobA.id]);
    const jobs = (await restored.request('/api/jobs')).data.map((job) => job.id);
    assert.ok(jobs.includes(jobA.id) && jobs.includes(jobB.id), 'restored jobs are still present');
    assert.deepEqual(foreignKeyViolations(path.join(target.config.dataDir, 'state.sqlite')), [], 'the restored database passes foreign_key_check');
  } finally { await restored.close(); }
});

test('an older system snapshot without site tables restores to an empty inventory and keeps jobs', async (t) => {
  const context = await fixture();
  const target = freshTargetConfig(context.folder);
  t.after(async () => { await context.close(); rmSync(target.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await context.setup();
  const job = await createJob(context, { name: 'Pre-site job' });
  // Create a site so we can prove the old archive genuinely drops it.
  await createSite(context, { name: 'Will vanish', domains: ['gone.example.com'], tags: ['x'], backupJobIds: [job.id] });
  await context.shutdown();

  // Simulate an archive produced before this feature: no site tables at all.
  const legacyPath = path.join(target.folder, 'legacy.sqlite');
  await snapshotState(context.config, legacyPath);
  const legacy = new DatabaseSync(legacyPath);
  try { legacy.exec('DROP TABLE IF EXISTS site_jobs; DROP TABLE IF EXISTS sites;'); } finally { legacy.close(); }
  await stageRealRestore(context.config, target.config.dataDir, legacyPath);

  const restore = await applyPendingSystemRestore(target.config);
  assert.ok(restore, 'the old bundle passes validation and is applied');
  await restore.complete();

  const restored = await fixture({ init: { folder: target.folder, config: target.config }, session: context.session, csrfToken: context.csrfToken });
  try {
    assert.deepEqual((await restored.request('/api/sites')).data, [], 'an older archive restores to an empty site inventory');
    const jobs = (await restored.request('/api/jobs')).data;
    assert.ok(jobs.some((item) => item.id === job.id && item.name === 'Pre-site job'), 'jobs from the old archive are preserved');
    assert.deepEqual(foreignKeyViolations(path.join(target.config.dataDir, 'state.sqlite')), []);
  } finally { await restored.close(); }
});

async function waitForRun(store, id, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const run = store.getRun(id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) && run.cleanupStatus !== 'pending' && run.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${id}`);
}

// Real-tool round trip: export the whole state through the production system-job
// pipeline (snapshot + encrypted 7z + upload), download it, and feed the exact
// archive through the production staged-import path. This exercises archive
// creation/encryption/decryption, not just the in-process snapshot copy used by
// the two restore tests above. Runs only when the real rclone and 7-Zip tools
// are present; the parent runs the final suite sequentially.
test('a site inventory survives a real system-configuration backup export and staged import', { skip: !liveTools }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-sites-system-'));
  const source = path.join(root, 'sources');
  const remote = path.join(root, 'remote');
  mkdirSync(source, { recursive: true });
  mkdirSync(remote, { recursive: true });
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: JSON.stringify([source]), RCLONE_BINARY: rcloneBinary, SEVEN_ZIP_BINARY: sevenZipBinary }, root);
  const store = createStore(config);
  const originalConfig = path.join(root, 'rclone-original.conf');
  writeFileSync(originalConfig, `[test]\ntype = alias\nremote = ${remote.replace(/\\/g, '/')}\n`);
  const rclone = createRcloneService({ config, getSettings: () => store.getSettings({ includeSecrets: true }), saveSettings: (patch) => store.saveSettings(patch) });
  await rclone.importConfig(originalConfig);
  const service = createBackupService({ config, store, rclone });
  const target = freshTargetConfig(root);
  // The staged-import path runs the real 7-Zip binary; point the fresh target at
  // the same resolved tool the source fixture uses (setupFiles has no tool env).
  target.config.sevenZipBinary = sevenZipBinary;
  target.config.rcloneBinary = rcloneBinary;
  try {
    // Seed the state that has to travel inside the system archive.
    const directoryJob = store.saveJob(inputJob(config, { name: 'Exported directory' }));
    const exportedSite = store.saveSite({ name: 'Exported site', domains: ['exported.example.com', 'https://portal.exported.example.com/app'], tags: ['prod', 'edge'], backupJobIds: [directoryJob.id] });
    const systemJob = store.saveJob({ name: '系统配置', type: 'system', enabled: true, destinations: [{ remote: 'test', path: 'system' }], archive: { format: '7z', encrypted: true, password: 'system-export-password' }, retry: { attempts: 1, delaySeconds: 1 } });

    const run = await waitForRun(store, service.enqueue(systemJob.id).id);
    assert.equal(run.status, 'succeeded', `system export run: ${JSON.stringify(run)}`);
    assert.ok(run.archiveName?.endsWith('.7z'), `system archive is an encrypted 7z (${run.archiveName})`);

    const savedSystem = store.getJob(systemJob.id);
    const download = await service.prepareDownload(systemJob.id, run.id, savedSystem.destinations[0].id);
    const stagedArchive = path.join(root, 'downloaded-system.7z');
    copyFileSync(download.path, stagedArchive);
    await download.cleanup();
    assert.ok(existsSync(stagedArchive), 'the real exported 7z archive was downloaded');

    // Feed the archive through the production staged-import path, then restore.
    const staged = await stageSystemRestore(createReadStream(stagedArchive), target.config, 'system-export-password');
    assert.equal(staged.pendingRestart, true, 'the exported archive passes staged import validation');
    const restore = await applyPendingSystemRestore(target.config);
    assert.ok(restore, 'the staged archive is applied');
    await restore.complete();

    const restoredStore = createStore(target.config);
    try {
      const sites = restoredStore.listSites();
      assert.deepEqual(sites, [exportedSite], 'site identity, domains, tags and links round-trip through a real encrypted archive');
      assert.ok(restoredStore.getJob(directoryJob.id), 'the linked job is restored with the site');
      assert.deepEqual(foreignKeyViolations(path.join(target.config.dataDir, 'state.sqlite')), [], 'restored relation rows pass foreign_key_check');
    } finally { restoredStore.close(); }
  } finally {
    await service.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(target.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
