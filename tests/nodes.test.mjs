import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { loadConfig } from '../server/config.mjs';
import { nodeSchema } from '../shared/contracts.mjs';

const newToken = () => `akb_${randomBytes(32).toString('base64url')}`;
const summary = (jobs) => ({ at: new Date().toISOString(), status: 'succeeded', total: jobs.length, synced: jobs.length, unmapped: 0, failed: 0, jobs });

async function fixture(options = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-nodes-'));
  const config = loadConfig({ SOURCE_ROOTS: path.join(folder, 'sources'), DATA_DIR: path.join(folder, 'data') }, folder);
  const source = path.join(config.sourceRoots[0], 'directory');
  mkdirSync(source);
  const pathMappings = new Map();
  const pathMappingCalls = [];
  const mappingKey = (input, rules) => JSON.stringify([input, rules]);
  const nodePathMapper = (input, rules) => {
    pathMappingCalls.push({ input, rules: structuredClone(rules) });
    const output = pathMappings.get(mappingKey(input, rules));
    return output === undefined ? { path: input, mapped: false } : { path: output, mapped: true };
  };
  let store, runtime, server, url, session = '', csrfToken = '';
  const boot = async () => {
    store = createStore(config);
    const scheduler = { start() {}, stop() {}, refresh() {} };
    const watcher = { start() {}, stop() {}, refresh() {}, status() { return []; } };
    const backupService = { isJobActive() { return false; }, async shutdown() {} };
    runtime = await createApp({ config, store, scheduler, watcher, backupService, rclone: {}, nodePathMapper, ...options });
    server = await new Promise((resolve) => { const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance)); });
    url = `http://127.0.0.1:${server.address().port}`;
    config.publicUrl = url;
  };
  const shutdown = async () => { await runtime.close(); await new Promise((resolve) => server.close(resolve)); store.close(); };
  const request = async (route, { method = 'GET', body, csrf = true, useSession = true, bearer, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (useSession && session) headers.cookie = session;
    if (csrf && csrfToken) headers['x-csrf-token'] = csrfToken;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (origin) headers.origin = origin;
    const response = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('backup_session=')) session = cookie.split(';')[0];
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data };
  };
  await boot();
  return {
    folder, config, source, request, pathMappingCalls, get url() { return url; }, get store() { return store; }, get runtime() { return runtime; },
    registerPathMapping(input, rules, output) { pathMappings.set(mappingKey(input, rules), output); },
    async setup() { const result = await request('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password' } }); assert.equal(result.status, 201); },
    async restart() { await shutdown(); await boot(); },
    async close() { await shutdown(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}

function seedToken(f, { token = newToken(), scopes = ['sync'], enabled = true, expiresAt = null } = {}) {
  const db = new DatabaseSync(path.join(f.config.dataDir, 'state.sqlite'));
  try {
    // The separate token-management workstream owns issuance. Its documented table is the compatibility boundary.
    db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      last_four TEXT NOT NULL, scopes TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT
    )`);
    db.prepare('INSERT INTO api_tokens(id,name,hash,prefix,last_four,scopes,enabled,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), 'fixture', createHash('sha256').update(token).digest('hex'), token.slice(0, 8), token.slice(-4), JSON.stringify(scopes), Number(enabled), new Date().toISOString(), expiresAt);
  } finally { db.close(); }
  return token;
}

const jobInput = (f, extra = {}) => ({ name: 'Directory', type: 'directory', sourcePath: f.source, destinations: [{ remote: 'AB', path: 'backups/directory' }], ...extra });
const nodeInput = (f, token = newToken(), extra = {}) => ({ name: 'Node', baseUrl: f.url, token, pathRules: [], jobOverrides: {}, ...extra });

test('node CRUD keeps sealed tokens, preserves blank edits, replaces overrides and persists across restart', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.request('/api/nodes')).status, 401);
  await f.setup();
  const token = newToken();
  const input = nodeInput(f, token, { pathRules: [{ from: f.config.sourceRoots[0], to: f.source }], jobOverrides: { original: { sources: [f.source] } }, lastStatus: 'succeeded', lastSyncAt: new Date().toISOString() });
  assert.equal((await f.request('/api/nodes', { method: 'POST', body: input, csrf: false })).status, 403);
  assert.equal((await f.request('/api/nodes', { method: 'POST', body: input, origin: 'https://other.invalid' })).status, 403);
  const created = await f.request('/api/nodes', { method: 'POST', body: input });
  assert.equal(created.status, 201);
  assert.equal(created.data.token, undefined);
  assert.equal(created.data.tokenSet, true);
  assert.equal(created.data.lastStatus, null);
  assert.equal(created.data.lastSyncAt, null);
  const db = new DatabaseSync(path.join(f.config.dataDir, 'state.sqlite'));
  try { const raw = db.prepare('SELECT data FROM nodes').get().data; assert.equal(raw.includes(token), false); assert.equal(JSON.parse(raw).token.sealed, 1); } finally { db.close(); }
  const edited = await f.request(`/api/nodes/${created.data.id}`, { method: 'PATCH', body: { name: 'Edited', token: '', pathRules: [], jobOverrides: {} } });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.data.pathRules, []);
  assert.deepEqual(edited.data.jobOverrides, {});
  assert.equal(f.store.getNode(created.data.id, { includeSecrets: true }).token, token);
  assert.equal(f.store.redact(`token=${token}`), 'token=[redacted]');
  await f.restart();
  assert.equal((await f.request('/api/nodes')).data[0].name, 'Edited');
  assert.equal(f.store.getNode(created.data.id, { includeSecrets: true }).token, token);
  assert.equal((await f.request(`/api/nodes/${created.data.id}`, { method: 'DELETE' })).status, 204);
  for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await f.request(`/api/nodes/${created.data.id}`, { method, ...(method === 'PATCH' ? { body: { name: 'Gone' } } : {}) })).status, 404);
  assert.equal(f.store.listJobs().length, 1, 'node deletion does not delete the system task');
});

test('node URL and path contracts reject unsafe values and allow explicit private peer URLs', () => {
  for (const baseUrl of ['file:///etc/passwd', 'ftp://node', 'https://user:password@node', 'https://node/?token=secret', 'https://node/#fragment', 'https://node\\evil', 'http://node:0']) {
    assert.equal(nodeSchema.safeParse({ name: 'Node', baseUrl }).success, false, baseUrl);
  }
  const parsed = nodeSchema.parse({ name: ' Node ', baseUrl: 'http://192.168.1.20:16323/backup///', pathRules: [{ from: 'C:\\Data', to: '/sources' }] });
  assert.equal(parsed.baseUrl, 'http://192.168.1.20:16323/backup');
  assert.equal(parsed.name, 'Node');
  assert.equal(nodeSchema.safeParse({ ...parsed, pathRules: [{ from: '/data', to: 'relative' }] }).success, false);
  assert.equal(nodeSchema.safeParse({ ...parsed, jobOverrides: { id: { sources: ['relative'] } } }).success, false);
});

test('receiver requires valid sync-scoped API tokens and never trusts outbound credentials or sessions', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.setup();
  const outbound = newToken();
  f.store.saveNode(nodeInput(f, outbound));
  assert.equal((await f.request('/api/sync/status', { bearer: outbound })).status, 401);
  assert.equal((await f.request('/api/sync/status')).status, 401);
  const sync = seedToken(f);
  for (const token of [newToken(), seedToken(f, { enabled: false }), seedToken(f, { expiresAt: '2020-01-01T00:00:00.000Z' })]) assert.equal((await f.request('/api/sync/status', { bearer: token, useSession: false })).status, 401);
  for (const scope of ['read', 'run']) assert.equal((await f.request('/api/sync/status', { bearer: seedToken(f, { scopes: [scope] }), useSession: false })).status, 403);
  assert.equal((await f.request('/api/sync/status', { bearer: sync, useSession: false })).data.ok, true);
  assert.equal((await f.request('/api/sync/jobs', { method: 'PUT', body: { jobs: [] }, bearer: sync, useSession: false, csrf: false })).status, 200);
  assert.equal((await f.request('/api/sync/jobs', { method: 'PUT', body: { jobs: [] }, bearer: sync, useSession: false, origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.request('/api/nodes', { bearer: sync, useSession: false })).status, 401);
});

test('receiver upserts stable identities across restart, retains node secrets/history and pauses unconfigured definitions', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.setup();
  const token = seedToken(f);
  const input = jobInput(f, { archive: { encrypted: true, format: '7z' }, schedule: { enabled: true, cron: '0 3 * * *' } });
  const receive = (job = input) => f.request('/api/sync/jobs', { method: 'PUT', body: { jobs: [{ syncKey: 'controller-task', job }] }, bearer: token, useSession: false, csrf: false });
  const first = await receive();
  assert.equal(first.status, 200);
  assert.equal(first.data.jobs[0].paused, true);
  const localId = first.data.jobs[0].remoteJobId;
  assert.equal(f.store.getJob(localId).enabled, false);
  assert.equal(f.store.getJob(localId).archive.encrypted, true);
  const password = 'node-local-archive-password';
  assert.equal((await f.request(`/api/jobs/${localId}`, { method: 'PATCH', body: { archive: { password }, enabled: true } })).status, 200);
  const run = f.store.createRun(f.store.getJob(localId));
  f.store.updateRun(run.id, { status: 'succeeded' });
  const createdAt = f.store.getJob(localId).createdAt;
  const updated = await receive({ ...input, name: 'Updated controller name', id: 'system-config', createdAt: '1900-01-01', lastRun: { id: 'foreign-run' }, settings: { smtp: { password: 'do-not-import' } } });
  assert.equal(updated.data.jobs[0].remoteJobId, localId);
  assert.equal(updated.data.jobs[0].paused, undefined);
  assert.equal(f.store.getJob(localId).name, 'Updated controller name');
  assert.equal(f.store.getJob(localId).createdAt, createdAt);
  assert.equal(f.store.getJob(localId).lastRun.id, run.id);
  assert.equal(f.store.getJob(localId).settings, undefined);
  assert.equal(f.store.getJob(localId, { includeSecrets: true }).archive.password, password);
  assert.equal(JSON.stringify(updated.data).includes(password), false);
  await f.restart();
  const repeated = await receive();
  assert.equal(repeated.data.jobs[0].remoteJobId, localId);
  assert.equal(f.store.listJobs().length, 2);
  assert.equal(f.store.listRuns({ jobId: localId }).total, 1);
  assert.equal(f.store.isSyncedJob(localId), true);
  f.store.deleteJob(localId);
  assert.equal(f.store.getSyncedJob('controller-task'), null);
  const recreated = await receive();
  assert.notEqual(recreated.data.jobs[0].remoteJobId, localId);
  assert.equal(f.store.listJobs().length, 2);
});

test('receiver validates each definition, blocks system and secret imports, and rejects duplicate sync keys atomically', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const token = seedToken(f);
  const entries = [
    ['outside', { ...jobInput(f), sourcePath: f.config.dataDir }, 'SOURCE_PATH_FORBIDDEN'],
    ['cron', { ...jobInput(f), schedule: { cron: 'invalid' } }, 'SCHEDULE_INVALID'],
    ['system', { ...jobInput(f), type: 'system' }, 'SYNC_SYSTEM_JOB_FORBIDDEN'],
    ['password', { ...jobInput(f), archive: { password: 'foreign-secret' } }, 'SYNC_SECRETS_FORBIDDEN'],
    ['bad-encryption', { ...jobInput(f), archive: { format: 'tar.gz', encrypted: true } }, 'ARCHIVE_ENCRYPTION_INVALID'],
  ];
  const result = await f.request('/api/sync/jobs', { method: 'PUT', bearer: token, body: { jobs: [...entries.map(([syncKey, job]) => ({ syncKey, job })), { syncKey: 'valid', job: jobInput(f) }] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.synced, 1);
  assert.equal(result.data.failed, entries.length);
  for (const [syncKey, , code] of entries) assert.equal(result.data.jobs.find((job) => job.jobId === syncKey).code, code);
  assert.equal(f.store.listJobs().length, 2);
  const duplicated = await f.request('/api/sync/jobs', { method: 'PUT', bearer: token, body: { jobs: [{ syncKey: 'duplicate', job: jobInput(f) }, { syncKey: 'duplicate', job: jobInput(f) }] } });
  assert.equal(duplicated.status, 400);
  assert.equal(f.store.getSyncedJob('duplicate'), null);
});

test('two nodes receive different mapped definitions without controller credentials, duplicate jobs or echo loops', async (t) => {
  const sent = [];
  const controller = await fixture({ nodeFetch: (url, options) => { sent.push({ url, body: options.body }); return fetch(url, options); } });
  const one = await fixture();
  const two = await fixture();
  t.after(() => controller.close());
  t.after(() => one.close());
  t.after(() => two.close());
  await controller.setup();
  const secret = 'controller-private-archive-password';
  const source = controller.store.saveJob(jobInput(controller, { archive: { encrypted: true, password: secret }, schedule: { enabled: true, cron: '0 4 * * *' }, retention: { days: 14, keepLast: 3 } }));
  controller.store.saveSyncedJob('imported-controller-task', jobInput(controller, { name: 'Do not echo' }));
  const nodes = [];
  for (const [index, destination] of [one, two].entries()) {
    const rules = [{ from: controller.config.sourceRoots[0], to: destination.config.sourceRoots[0] }];
    controller.registerPathMapping(controller.source, rules, destination.source);
    const created = await controller.request('/api/nodes', { method: 'POST', body: nodeInput(destination, seedToken(destination), { name: `Node ${index}`, pathRules: rules }) });
    assert.equal(created.status, 201);
    nodes.push(created.data);
    assert.equal((await controller.request(`/api/nodes/${created.data.id}/test`, { method: 'POST' })).data.ok, true);
    const pushed = await controller.request(`/api/nodes/${created.data.id}/sync`, { method: 'POST' });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.data.total, 1);
    assert.equal(pushed.data.synced, 1);
    assert.equal(pushed.data.jobs[0].paused, true);
    assert.deepEqual(controller.pathMappingCalls.splice(0), [{ input: controller.source, rules }]);
    assert.equal(destination.store.getSyncedJob(source.id).sourcePath, destination.source);
    assert.equal(destination.store.getSyncedJob(source.id).archive.passwordSet, false);
    assert.equal(destination.store.getSyncedJob(source.id).schedule.cron, '0 4 * * *');
    assert.equal(destination.store.getSyncedJob(source.id).retention.keepLast, 3);
  }
  assert.notEqual(one.store.getSyncedJob(source.id).sourcePath, two.store.getSyncedJob(source.id).sourcePath);
  assert.equal(sent.some((request) => request.body?.includes(secret)), false);
  assert.equal(sent.some((request) => request.body?.includes('lastRun')), false);
  const localId = one.store.getSyncedJob(source.id).id;
  await one.restart();
  controller.store.saveNode({ baseUrl: one.url }, nodes[0].id);
  assert.equal((await controller.request(`/api/nodes/${nodes[0].id}/sync`, { method: 'POST' })).data.synced, 1);
  assert.deepEqual(controller.pathMappingCalls, [{ input: controller.source, rules: nodes[0].pathRules }]);
  assert.equal(one.store.getSyncedJob(source.id).id, localId);
  assert.equal(one.store.listJobs().length, 2);
  const saved = controller.store.getNode(nodes[0].id);
  assert.equal(saved.lastStatus, 'succeeded');
  assert.equal(saved.lastSync.jobs[0].jobId, source.id);
  assert.ok(saved.lastSyncAt);
});

test('unmapped source or local destination skips the entire task; explicit job source overrides take precedence', async (t) => {
  const controller = await fixture();
  const receiver = await fixture();
  t.after(() => controller.close());
  t.after(() => receiver.close());
  await controller.setup();
  const source = controller.store.saveJob(jobInput(controller));
  const localDestination = controller.store.saveJob(jobInput(controller, { name: 'Unmapped destination', destinations: [{ remote: 'Local', path: path.join(controller.folder, 'outside-destination') }] }));
  const node = controller.store.saveNode(nodeInput(receiver, seedToken(receiver)));
  const skipped = await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(skipped.data.unmapped, 2);
  assert.equal(receiver.store.listJobs().length, 1);
  assert.equal(controller.pathMappingCalls.filter(({ input }) => input === controller.source).length, 2);
  assert.ok(controller.pathMappingCalls.some(({ input }) => input === localDestination.destinations[0].path));
  for (const { rules } of controller.pathMappingCalls) assert.deepEqual(rules, []);
  controller.pathMappingCalls.length = 0;
  controller.store.saveNode({ jobOverrides: { [source.id]: { sources: [receiver.source] }, [localDestination.id]: { sources: [receiver.source] } } }, node.id);
  const overridden = await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(overridden.data.synced, 1);
  assert.equal(overridden.data.unmapped, 1);
  assert.equal(receiver.store.getSyncedJob(source.id).sourcePath, receiver.source);
  assert.equal(receiver.store.getSyncedJob(localDestination.id), null);
  assert.deepEqual(controller.pathMappingCalls, [{ input: localDestination.destinations[0].path, rules: [] }]);
  controller.store.saveNode({ enabled: false }, node.id);
  assert.equal((await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' })).status, 409);
});

test('Vaultwarden and new-api nested files/TLS follow source overrides while remote archive/database secrets and history survive', async (t) => {
  const sent = [];
  const controller = await fixture({ nodeFetch: (url, options) => { if (options.body) sent.push(JSON.parse(options.body)); return fetch(url, options); } });
  const receiver = await fixture();
  t.after(() => controller.close());
  t.after(() => receiver.close());
  await controller.setup();
  await receiver.setup();
  for (const f of [controller, receiver]) {
    for (const folder of ['attachments', 'sends', 'plugins', 'logs', 'ssl']) mkdirSync(path.join(f.source, folder));
    for (const file of ['vault.db', 'rsa.pem', '.env', 'compose.yaml', 'service.unit', 'proxy.conf', 'ssl/ca.pem', 'ssl/cert.pem', 'ssl/key.pem']) writeFileSync(path.join(f.source, file), 'fixture');
  }
  const tls = (f) => ({ sslCa: path.join(f.source, 'ssl/ca.pem'), sslCert: path.join(f.source, 'ssl/cert.pem'), sslKey: path.join(f.source, 'ssl/key.pem') });
  const database = { host: 'db.internal', name: 'backup', username: 'backup', password: 'controller-db-secret', ...tls(controller) };
  const archive = { encrypted: true, format: '7z', password: 'controller-archive-secret' };
  const vault = controller.store.saveJob(jobInput(controller, {
    name: 'Vaultwarden', type: 'vaultwarden', archive,
    vaultwarden: { dataDir: controller.source, dbType: 'postgresql', sqlitePath: path.join(controller.source, 'vault.db'), rsaKeyPath: path.join(controller.source, 'rsa.pem'), attachmentsPath: path.join(controller.source, 'attachments'), sendsPath: path.join(controller.source, 'sends'), database },
  }));
  const api = controller.store.saveJob(jobInput(controller, {
    name: 'new-api', type: 'newapi', archive,
    newapi: { dataDir: controller.source, dbType: 'postgresql', logDbType: 'mysql', database, logDatabase: { ...database, password: 'controller-log-db-secret' }, envFilePath: path.join(controller.source, '.env'), composeFilePath: path.join(controller.source, 'compose.yaml'), serviceFilePath: path.join(controller.source, 'service.unit'), proxyConfigPath: path.join(controller.source, 'proxy.conf'), pluginsPath: path.join(controller.source, 'plugins'), includeLogs: true, logsPath: path.join(controller.source, 'logs') },
  }));
  const node = controller.store.saveNode(nodeInput(receiver, seedToken(receiver), {
    // Every descendant must follow the explicit job override before this conflicting node-wide rule.
    pathRules: [{ from: controller.source, to: path.join(receiver.folder, 'wrong') }],
    jobOverrides: { [vault.id]: { sources: [receiver.source] }, [api.id]: { sources: [receiver.source] } },
  }));
  const overrideRules = [{ from: controller.source, to: receiver.source }];
  const mappedFiles = ['attachments', 'sends', 'plugins', 'logs', 'vault.db', 'rsa.pem', '.env', 'compose.yaml', 'service.unit', 'proxy.conf', 'ssl/ca.pem', 'ssl/cert.pem', 'ssl/key.pem'];
  for (const filename of mappedFiles) controller.registerPathMapping(path.join(controller.source, filename), overrideRules, path.join(receiver.source, filename));
  const initial = await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(initial.data.synced, 2);
  assert.deepEqual(new Set(controller.pathMappingCalls.map(({ input }) => input)), new Set(mappedFiles.map((filename) => path.join(controller.source, filename))));
  for (const { rules } of controller.pathMappingCalls) assert.deepEqual(rules, overrideRules);
  for (const source of [vault, api]) {
    const local = receiver.store.getSyncedJob(source.id);
    assert.equal(local.sourcePath, receiver.source);
    assert.equal(local.enabled, false);
    const adapter = source.type === 'newapi' ? local.newapi : local.vaultwarden;
    assert.equal(adapter.dataDir, receiver.source);
    assert.deepEqual({ sslCa: adapter.database.sslCa, sslCert: adapter.database.sslCert, sslKey: adapter.database.sslKey }, tls(receiver));
    assert.equal(adapter.database.passwordSet, false);
    const credentials = source.type === 'newapi'
      ? { newapi: { database: { password: 'receiver-main-db-secret' }, logDatabase: { password: 'receiver-log-db-secret' } } }
      : { vaultwarden: { database: { password: 'receiver-main-db-secret' } } };
    const configured = await receiver.request(`/api/jobs/${local.id}`, { method: 'PATCH', body: { ...credentials, archive: { password: 'receiver-archive-secret' }, enabled: true } });
    assert.equal(configured.status, 200);
    const run = receiver.store.createRun(receiver.store.getJob(local.id));
    receiver.store.updateRun(run.id, { status: 'succeeded' });
  }
  const apiLocal = receiver.store.getSyncedJob(api.id);
  assert.equal(apiLocal.newapi.envFilePath, path.join(receiver.source, '.env'));
  assert.equal(apiLocal.newapi.pluginsPath, path.join(receiver.source, 'plugins'));
  assert.equal(apiLocal.newapi.logsPath, path.join(receiver.source, 'logs'));
  assert.equal(apiLocal.newapi.logDatabase.sslCa, tls(receiver).sslCa);
  const vaultLocal = receiver.store.getSyncedJob(vault.id);
  assert.equal(vaultLocal.vaultwarden.attachmentsPath, path.join(receiver.source, 'attachments'));
  assert.equal(vaultLocal.vaultwarden.sendsPath, path.join(receiver.source, 'sends'));
  assert.equal(vaultLocal.vaultwarden.rsaKeyPath, path.join(receiver.source, 'rsa.pem'));
  const repeated = await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(repeated.data.synced, 2);
  for (const { rules } of controller.pathMappingCalls) assert.deepEqual(rules, overrideRules);
  for (const source of [vault, api]) {
    const local = receiver.store.getSyncedJob(source.id, { includeSecrets: true });
    assert.equal(local.archive.password, 'receiver-archive-secret');
    assert.equal((local.type === 'newapi' ? local.newapi : local.vaultwarden).database.password, 'receiver-main-db-secret');
    if (local.type === 'newapi') assert.equal(local.newapi.logDatabase.password, 'receiver-log-db-secret');
    assert.equal(local.enabled, true);
    assert.equal(receiver.store.listRuns({ jobId: local.id }).total, 1);
    assert.equal(local.lastRun.status, 'succeeded');
  }
  for (const secret of ['controller-db-secret', 'controller-log-db-secret', 'controller-archive-secret', 'receiver-main-db-secret', 'receiver-log-db-secret', 'receiver-archive-secret']) assert.equal(JSON.stringify(sent).includes(secret), false);
});

test('SQLite Vaultwarden maps retained TLS paths before receiver source validation', async (t) => {
  const controller = await fixture();
  const receiver = await fixture();
  t.after(() => controller.close());
  t.after(() => receiver.close());
  await controller.setup();
  const tls = (f) => Object.fromEntries(['sslCa', 'sslCert', 'sslKey'].map((key) => [key, path.join(f.source, `${key.toLowerCase()}.pem`)]));
  for (const f of [controller, receiver]) for (const filename of Object.values(tls(f))) writeFileSync(filename, 'retained TLS asset');
  const source = controller.store.saveJob(jobInput(controller, {
    type: 'vaultwarden',
    vaultwarden: { dataDir: controller.source, dbType: 'sqlite', database: tls(controller) },
  }));
  const rules = [{ from: controller.config.sourceRoots[0], to: receiver.config.sourceRoots[0] }];
  controller.registerPathMapping(controller.source, rules, receiver.source);
  for (const key of ['sslCa', 'sslCert', 'sslKey']) controller.registerPathMapping(tls(controller)[key], rules, tls(receiver)[key]);
  const node = controller.store.saveNode(nodeInput(receiver, seedToken(receiver), { pathRules: rules }));
  const pushed = await controller.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(pushed.data.synced, 1);
  assert.deepEqual(controller.pathMappingCalls, [controller.source, ...Object.values(tls(controller))].map((input) => ({ input, rules })));
  const local = receiver.store.getSyncedJob(source.id);
  assert.equal(local.vaultwarden.dbType, 'sqlite');
  const database = local.vaultwarden.database;
  assert.deepEqual({ sslCa: database.sslCa, sslCert: database.sslCert, sslKey: database.sslKey }, tls(receiver));
});

test('transport rejects redirects and does not reflect remote credential-bearing errors', async (t) => {
  let forwarded = false;
  const target = createServer((_req, res) => { forwarded = true; res.end('{}'); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const peer = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}` }); res.end(); });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const f = await fixture();
  t.after(() => f.close());
  await f.setup();
  const token = newToken();
  const node = f.store.saveNode(nodeInput(f, token, { baseUrl: `http://127.0.0.1:${peer.address().port}` }));
  const result = await f.request(`/api/nodes/${node.id}/test`, { method: 'POST' });
  assert.equal(result.status, 502);
  assert.equal(result.data.error.code, 'NODE_REDIRECT_FORBIDDEN');
  assert.equal(forwarded, false);
  assert.equal(JSON.stringify(result.data).includes(token), false);
  peer.removeAllListeners('request');
  peer.on('request', (_req, res) => { res.writeHead(500); res.end(JSON.stringify({ error: token })); });
  const failed = await f.request(`/api/nodes/${node.id}/test`, { method: 'POST' });
  assert.equal(failed.data.error.code, 'NODE_REQUEST_FAILED');
  assert.equal(JSON.stringify(failed.data).includes(token), false);
});

test('connection timeouts and failed pushes persist sanitized outcomes', async (t) => {
  const token = newToken();
  const f = await fixture({ nodeRequestTimeoutMs: 20, nodeFetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(`failed with ${token}`)), { once: true })) });
  t.after(() => f.close());
  await f.setup();
  const source = f.store.saveJob(jobInput(f));
  const node = f.store.saveNode(nodeInput(f, token, { jobOverrides: { [source.id]: { sources: [f.source] } } }));
  const pushed = await f.request(`/api/nodes/${node.id}/sync`, { method: 'POST' });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.data.failed, 1);
  assert.equal(pushed.data.jobs[0].code, 'NODE_REQUEST_TIMEOUT');
  assert.equal(f.store.getNode(node.id).lastStatus, 'failed');
  assert.equal(JSON.stringify(pushed.data).includes(token), false);
  assert.equal(JSON.stringify(f.store.getNode(node.id)).includes(token), false);
});
