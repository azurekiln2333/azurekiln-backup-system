import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig, resolveSourcePath } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

function setupFiles() {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-api-'));
  const config = loadConfig({ SOURCE_ROOTS: path.join(folder, 'sources'), DATA_DIR: path.join(folder, 'data') }, folder);
  mkdirSync(path.join(config.sourceRoots[0], 'directory-a'));
  mkdirSync(path.join(config.sourceRoots[0], 'directory-b'));
  return { folder, config };
}

async function fixture(options = {}) {
  const { folder, config } = setupFiles();
  Object.assign(config, options);
  const store = createStore(config);
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
  const runtime = await createApp({ config, store, scheduler, backupService, rclone });
  const server = await new Promise((resolve) => { const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = url;
  let session = '';
  let csrfToken = '';
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
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) if (cookie.startsWith('backup_session=')) session = cookie.split(';')[0];
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data, response, cookies };
  };
  const setup = () => request('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password', setupToken: options.setupToken || undefined } });
  return { config, store, request, setup, url, runtime, getCookie: () => session, async close() { await runtime.close(); await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(folder, { recursive: true, force: true }); } };
}

function inputJob(config, extra = {}) {
  return { name: 'Directory A', type: 'directory', sourcePath: path.join(config.sourceRoots[0], 'directory-a'), destinations: [{ remote: 'AB', path: 'backups/A' }], archive: { format: '7z', encrypted: true, password: 'private-archive-password' }, ...extra };
}

test('watch settings are limited to directory tasks and expose runtime status to administrators', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await context.request('/api/overview')).status, 401);
  await context.setup();
  const created = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { watch: { enabled: true, debounceSeconds: 1 } }) });
  assert.equal(created.status, 201);
  assert.equal(created.data.watch.enabled, true);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { watch: { enabled: true, debounceSeconds: 0 } }) })).status, 400);
  const status = (await context.request('/api/overview')).data.watchStatus[created.data.id];
  assert.equal(status.state, 'watching');
  const invalid = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { type: 'vaultwarden', vaultwarden: { dataDir: path.join(context.config.sourceRoots[0], 'directory-a') }, watch: { enabled: true, debounceSeconds: 1 } }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'WATCH_DIRECTORY_ONLY');
  const paused = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { enabled: false } });
  assert.equal(paused.status, 200);
  assert.equal((await context.request('/api/overview')).data.watchStatus[created.data.id], undefined);
});

test('one-time setup, session persistence, CSRF, origin checks and local login', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await context.request('/api/auth/status')).data.initialized, false);
  assert.equal((await context.request('/api/jobs')).status, 401);
  assert.equal((await context.request('/api/auth/setup', { method: 'POST', origin: 'https://evil.example', body: { username: 'admin', password: 'a-strong-admin-password' } })).status, 403);
  const setup = await context.setup();
  assert.equal(setup.status, 201);
  assert.ok(setup.cookies[0].includes('HttpOnly'));
  assert.ok(setup.cookies[0].includes('SameSite=Lax'));
  assert.equal((await context.setup()).status, 409);
  assert.equal((await context.request('/api/auth/status')).data.user.username, 'admin');
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config), csrf: false })).status, 403);
  assert.equal((await context.request('/api/jobs', { method: 'POST', origin: 'https://evil.example', body: inputJob(context.config) })).status, 403);
  const response = await context.request('/api/jobs', { method: 'POST', origin: context.url, body: inputJob(context.config) });
  assert.equal(response.status, 201);
  assert.equal((await context.request('/api/auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await context.request('/api/jobs')).status, 401);
  assert.equal((await context.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await context.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password' } })).status, 200);
  assert.equal((await context.request('/api/jobs')).data.length, 2);
});

test('local archive policy and cleanup endpoints require authentication and CSRF', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await context.request('/api/storage')).status, 401);
  await context.setup();
  const settings = await context.request('/api/settings', { method: 'PATCH', body: { storage: { successCleanupMode: 'manual' } } });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.storage.successCleanupMode, 'manual');
  assert.equal((await context.request('/api/storage')).data.successCleanupMode, 'manual');
  assert.equal((await context.request('/api/storage/local-archives', { method: 'DELETE', csrf: false })).status, 403);
  assert.deepEqual((await context.request('/api/storage/local-archives', { method: 'DELETE' })).data, { cleaned: 0 });
  assert.deepEqual((await context.request('/api/storage/local-archives/some-run', { method: 'DELETE' })).data, { cleaned: true });
  assert.equal((await context.request('/api/settings', { method: 'PATCH', body: { storage: { successCleanupMode: 'never' } } })).status, 400);
});

test('built-in system task keeps its identity and supports descriptions', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const system = (await context.request('/api/jobs')).data.find((job) => job.type === 'system');
  assert.equal(system.id, 'system-config');
  assert.equal(system.enabled, false);
  assert.deepEqual(system.destinations, []);
  assert.equal((await context.request(`/api/jobs/${system.id}/run`, { method: 'POST' })).status, 400);
  assert.equal((await context.request(`/api/jobs/${system.id}`, { method: 'DELETE' })).status, 403);
  const updated = await context.request(`/api/jobs/${system.id}`, { method: 'PATCH', body: { description: 'Daily system configuration' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.description, 'Daily system configuration');
  assert.equal((await context.request(`/api/jobs/${system.id}`, { method: 'PATCH', body: { type: 'directory' } })).status, 400);
  const directory = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { description: 'Directory notes' }) });
  assert.equal(directory.data.description, 'Directory notes');
  assert.equal((await context.request(`/api/jobs/${directory.data.id}`, { method: 'PATCH', body: { description: '  Updated notes  ' } })).data.description, 'Updated notes');
  assert.equal((await context.request(`/api/jobs/${directory.data.id}`, { method: 'PATCH', body: { description: 'x'.repeat(501) } })).status, 400);
});

test('configured setup token is mandatory even on loopback', async (t) => {
  const context = await fixture({ setupToken: 'protected-setup-token' });
  t.after(() => context.close());
  assert.equal((await context.request('/api/auth/status')).data.setupTokenRequired, true);
  assert.equal((await context.request('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password' } })).status, 403);
  assert.equal((await context.setup()).status, 201);
});

test('a missing mounted source can be paused without bypassing source boundaries', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const created = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config) });
  assert.equal(created.status, 201);
  rmSync(created.data.sourcePath, { recursive: true });
  const paused = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { enabled: false } });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.enabled, false);
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { enabled: true } })).status, 404);
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { enabled: false, sourcePath: path.dirname(context.config.sourceRoots[0]) } })).status, 403);
});

test('watch quick toggle keeps the watch mode and can switch off a missing source', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const created = await context.request('/api/jobs', { method: 'POST', body: { ...inputJob(context.config), watch: { enabled: false, mode: 'incremental', debounceSeconds: 7 } } });
  assert.equal(created.status, 201);
  const on = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { watch: { enabled: true } } });
  assert.equal(on.status, 200);
  assert.deepEqual(on.data.watch, { enabled: true, mode: 'incremental', debounceSeconds: 7 });
  rmSync(created.data.sourcePath, { recursive: true });
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { watch: { enabled: true, debounceSeconds: 8 } } })).status, 404);
  const off = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { watch: { enabled: false } } });
  assert.equal(off.status, 200);
  assert.equal(off.data.watch.enabled, false);
  assert.equal(off.data.watch.mode, 'incremental');
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { watch: { enabled: true } } })).status, 404);
});

test('an exposed listener cannot initialize from a loopback proxy without setup authorization', async (t) => {
  const context = await fixture({ host: '0.0.0.0' });
  t.after(() => context.close());
  assert.equal((await context.request('/api/auth/status')).data.setupTokenRequired, true);
  const setup = await context.setup();
  assert.equal(setup.status, 403);
  assert.equal(setup.data.error.code, 'SETUP_REQUIRES_LOCAL');
  assert.equal(context.store.getAdmin(), null);
});

test('independent destinations and encrypted secrets survive reopening; blank updates retain them', async () => {
  const { folder, config } = setupFiles();
  let store = createStore(config);
  try {
    const first = store.saveJob(inputJob(config));
    const second = store.saveJob(inputJob(config, { name: 'Directory B', sourcePath: path.join(config.sourceRoots[0], 'directory-b'), destinations: [{ remote: 'BC', path: 'backups/B' }] }));
    store.saveSettings({ smtp: { password: 'smtp-private-secret' }, oidc: { clientSecret: 'oauth-private-secret' }, rclone: { configPassword: 'rclone-private-secret' } });
    store.saveJob({ archive: { password: '' }, vaultwarden: { database: { password: 'database-private-secret' } } }, first.id);
    store.saveSettings({ smtp: { password: '' }, oidc: { clientSecret: '' }, rclone: { configPassword: '' } });
    const run = store.createRun(store.getJob(first.id, { includeSecrets: true }));
    store.appendLog(run.id, { message: 'Error private-archive-password smtp-private-secret password=should-not-persist' });
    const sessionHash = createHash('sha256').update('session-example').digest('hex');
    store.saveSession(sessionHash, 'csrf-example', Date.now() + 60000);
    store.close();
    store = createStore(config);
    assert.equal(store.getSession(sessionHash).csrf, 'csrf-example');
    assert.equal(store.getJob(first.id).destinations[0].remote, 'AB');
    assert.equal(store.getJob(second.id).destinations[0].remote, 'BC');
    assert.equal(store.getJob(first.id, { includeSecrets: true }).archive.password, 'private-archive-password');
    assert.equal(store.getJob(first.id).archive.passwordSet, true);
    assert.equal(store.getJob(first.id).archive.password, undefined);
    assert.equal(store.getSettings().oidc.clientSecretSet, true);
    assert.equal(store.getSettings({ includeSecrets: true }).smtp.password, 'smtp-private-secret');
    assert.match(store.getRun(run.id).logs[0].message, /\[redacted\]/);
    const database = readFileSync(path.join(config.dataDir, 'state.sqlite')).toString('latin1');
    for (const secret of ['private-archive-password', 'smtp-private-secret', 'oauth-private-secret', 'database-private-secret', 'rclone-private-secret']) assert.equal(database.includes(secret), false);
    assert.equal(database.includes('should-not-persist'), false);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('missing or mismatched master keys cannot silently replace persisted credentials', () => {
  const { folder, config } = setupFiles();
  try {
    const store = createStore(config);
    store.saveSettings({ smtp: { password: 'protected-before-recovery' } });
    store.close();
    assert.throws(() => createStore({ ...config, masterKey: Buffer.alloc(32, 7).toString('base64') }), /does not match/);
    rmSync(config.masterKeyPath);
    assert.throws(() => createStore(config), /requires its original/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('SMTP settings and test-email endpoint send through a real local SMTP connection', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  assert.equal((await context.request('/api/settings/test-email', { method: 'POST', body: {} })).status, 400);
  const { createServer: smtpServer } = await import('node:net');
  let received = '';
  const server = smtpServer((socket) => {
    socket.write('220 test SMTP\r\n');
    let buffered = '';
    let dataMode = false;
    socket.on('data', (chunk) => {
      buffered += chunk.toString();
      let position;
      while ((position = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, position);
        buffered = buffered.slice(position + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; socket.write('250 queued\r\n'); }
          else received += `${line}\n`;
        } else if (/^EHLO/i.test(line)) socket.write('250-test\r\n250 SIZE 1000000\r\n');
        else if (/^MAIL FROM:|^RCPT TO:/i.test(line)) socket.write('250 ok\r\n');
        else if (/^DATA$/i.test(line)) { dataMode = true; socket.write('354 send data\r\n'); }
        else if (/^QUIT$/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const saved = await context.request('/api/settings', { method: 'PATCH', body: { smtp: { enabled: true, host: '127.0.0.1', port: server.address().port, mode: 'none', from: 'backup@example.com', to: ['admin@example.com'] } } });
  assert.equal(saved.status, 200);
  const email = await context.request('/api/settings/test-email', { method: 'POST', body: { to: 'test@example.com' } });
  assert.equal(email.status, 200);
  assert.equal(email.data.sent, true);
  assert.match(received, /To: test@example.com/);
  assert.match(received, /Subject: AzureKiln Backup SMTP test/);
});

test('job validation, source boundary enforcement, task execution and honest tool failures', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { sourcePath: context.config.dataDir }) })).status, 403);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { schedule: { cron: 'invalid-cron', timezone: 'Asia/Shanghai' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { schedule: { cron: '0 3 * * *', timezone: 'Nowhere/Unknown' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { archive: { format: 'tar.gz', encrypted: true, password: 'secret' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { destinations: [{ remote: 'AB', path: '../unowned' }] }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { archive: { folderTemplate: 'same-folder' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { archive: { folderTemplate: '{datetime}', fileTemplate: '../escape' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { archive: { method: 'unknown' } }) })).status, 400);
  assert.equal((await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config, { enabled: 'true' }) })).status, 400);
  const created = await context.request('/api/jobs', { method: 'POST', body: inputJob(context.config) });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.data).includes('private-archive-password'), false);
  const updated = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { name: 'Renamed A', archive: { password: '' } } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.archive.passwordSet, true);
  const compression = await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { archive: { method: 'lzma', threads: 2, dictionaryMiB: 16 } } });
  assert.equal(compression.status, 200);
  assert.equal(compression.data.archive.method, 'lzma');
  assert.equal(compression.data.archive.threads, 2);
  assert.equal(compression.data.archive.dictionaryMiB, 16);
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'PATCH', body: { archive: null } })).status, 400);
  assert.equal((await context.request('/api/settings', { method: 'PATCH', body: { smtp: null } })).status, 400);
  assert.equal(context.store.getJob(created.data.id, { includeSecrets: true }).archive.password, 'private-archive-password');
  const queued = await context.request(`/api/jobs/${created.data.id}/run`, { method: 'POST' });
  assert.equal(queued.status, 202);
  assert.equal(queued.data.status, 'queued');
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await context.request(`/api/runs/${queued.data.id}/cancel`, { method: 'POST' })).data.status, 'cancelled');
  assert.equal(context.store.getJob(created.data.id).lastRun.status, 'cancelled');
  const next = context.store.createRun(context.store.getJob(created.data.id));
  context.store.updateRun(next.id, { status: 'failed' });
  const filtered = await context.request('/api/runs?status=failed&limit=1');
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.items[0].id, next.id);
  assert.equal((await context.request('/api/runs?status=failed&limit=1&offset=1')).data.items.length, 0);
  assert.equal((await context.request('/api/runs?status=unknown')).status, 400);
  assert.equal((await context.request('/api/runs?limit=0')).status, 400);
  assert.equal((await context.request('/api/rclone/remotes')).status, 503);
  assert.equal((await context.request('/api/rclone/status')).data.available, false);
  assert.equal((await context.request('/api/overview')).data.tools.rclone.available, false);
  const roots = await context.request('/api/sources');
  assert.equal(roots.data.roots.length, 1);
  const browsing = await context.request(`/api/sources?path=${encodeURIComponent(context.config.sourceRoots[0])}`);
  assert.equal(browsing.data.entries.length, 2);
  const escaping = await context.request(`/api/sources?path=${encodeURIComponent(path.join(context.config.sourceRoots[0], '..'))}`);
  assert.equal(escaping.status, 403);
  assert.equal((await context.request(`/api/jobs/${created.data.id}`, { method: 'DELETE' })).status, 204);
});

test('source symlink directories are rejected and hidden from browsing', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const link = path.join(context.config.sourceRoots[0], 'escape');
  try { symlinkSync(context.config.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlink creation requires OS permission.'); return; } throw error; }
  assert.throws(() => resolveSourcePath(context.config, link, { directory: true }), (error) => error.code === 'SOURCE_SYMLINK_FORBIDDEN');
  await context.setup();
  const listing = await context.request(`/api/sources?path=${encodeURIComponent(context.config.sourceRoots[0])}`);
  assert.equal(listing.data.entries.some((entry) => entry.name === 'escape'), false);
});

test('mounted source browser lists files with metadata, search and pagination inside allowed roots', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const root = context.config.sourceRoots[0];
  writeFileSync(path.join(root, 'notes.txt'), 'mounted file');
  writeFileSync(path.join(root, 'archive.log'), 'log');
  assert.equal((await context.request('/api/sources')).status, 401);
  await context.setup();
  const roots = await context.request('/api/sources');
  assert.equal(roots.data.path, null);
  assert.equal(roots.data.parent, null);
  assert.equal(roots.data.total, 1);
  assert.equal(roots.data.entries[0].path, root);
  const first = await context.request(`/api/sources?path=${encodeURIComponent(root)}&limit=2`);
  assert.equal(first.status, 200);
  assert.equal(first.data.total, 4);
  assert.equal(first.data.parent, null);
  assert.deepEqual(first.data.entries.map((entry) => entry.name), ['directory-a', 'directory-b']);
  assert.equal(first.data.entries[0].size, null);
  assert.equal(first.data.entries[0].isDirectory, true);
  assert.ok(!Number.isNaN(Date.parse(first.data.entries[0].modifiedAt)));
  const next = await context.request(`/api/sources?path=${encodeURIComponent(root)}&limit=2&offset=2`);
  assert.equal(next.status, 200);
  assert.deepEqual(next.data.entries.map((entry) => entry.name), ['archive.log', 'notes.txt']);
  assert.equal(next.data.entries[1].size, 12);
  assert.equal(next.data.entries[1].path, path.join(root, 'notes.txt'));
  assert.equal(next.data.entries[1].isDirectory, false);
  assert.ok(!Number.isNaN(Date.parse(next.data.entries[1].modifiedAt)));
  const searched = await context.request(`/api/sources?path=${encodeURIComponent(root)}&limit=2&search=NOTES`);
  assert.deepEqual(searched.data.entries.map((entry) => entry.name), ['notes.txt']);
  assert.equal(searched.data.total, 1);
  const empty = await context.request(`/api/sources?path=${encodeURIComponent(path.join(root, 'directory-a'))}`);
  assert.equal(empty.data.parent, root);
  assert.equal(empty.data.total, 0);
  assert.deepEqual(empty.data.entries, []);
  const noMatch = await context.request(`/api/sources?path=${encodeURIComponent(root)}&search=missing`);
  assert.equal(noMatch.data.total, 0);
  assert.deepEqual(noMatch.data.entries, []);
  assert.equal((await context.request(`/api/sources?path=${encodeURIComponent(context.config.dataDir)}&limit=2`)).status, 403);
  assert.equal((await context.request(`/api/sources?path=${encodeURIComponent(root)}&limit=201`)).status, 400);
});

test('source listing validates queries, missing paths and file paths', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const root = context.config.sourceRoots[0];
  const file = path.join(root, 'file.txt');
  writeFileSync(file, 'data');
  for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'limit=abc', 'limit=', 'limit[]=2', 'limit=1&limit=2', 'offset=-1', 'offset=1.5', 'offset=1000001', 'offset=abc', 'offset=', 'offset[]=0', 'search[]=name', `search=${'x'.repeat(201)}`]) {
    for (const prefix of ['', `path=${encodeURIComponent(root)}&`]) {
      const result = await context.request(`/api/sources?${prefix}${query}`);
      assert.equal(result.status, 400, `${prefix}${query}`);
    }
  }
  for (const [value, status, code] of [
    ['relative-path', 400, 'SOURCE_PATH_INVALID'],
    [path.join(root, 'missing'), 404, 'SOURCE_PATH_MISSING'],
    [file, 400, 'SOURCE_NOT_DIRECTORY'],
    [context.config.dataDir, 403, 'SOURCE_PATH_FORBIDDEN'],
  ]) {
    const result = await context.request(`/api/sources?path=${encodeURIComponent(value)}`);
    assert.equal(result.status, status);
    assert.equal(result.data.error.code, code);
  }
  assert.equal((await context.request('/api/sources?path[]=invalid')).status, 400);
});

test('source listing keeps unpaginated picker results and searches before paging', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const root = path.join(context.config.sourceRoots[0], 'directory-a');
  for (let index = 0; index < 205; index++) mkdirSync(path.join(root, `folder-${String(index).padStart(3, '0')}`));
  const route = `/api/sources?path=${encodeURIComponent(root)}`;
  const all = await context.request(route);
  assert.equal(all.data.entries.length, 205);
  assert.equal(all.data.total, 205);
  assert.equal((await context.request(`${route}&offset=200`)).data.entries.length, 205);
  const page = await context.request(`${route}&limit=100&offset=200`);
  assert.equal(page.data.entries.length, 5);
  assert.equal(page.data.total, 205);
  const filtered = await context.request(`${route}&search=FOLDER-20&limit=2&offset=2`);
  assert.equal(filtered.data.total, 5);
  assert.deepEqual(filtered.data.entries.map((entry) => entry.name), ['folder-202', 'folder-203']);
  const beyond = await context.request(`${route}&limit=100&offset=300`);
  assert.equal(beyond.data.total, 205);
  assert.deepEqual(beyond.data.entries, []);
});

test('source listing parent stops at the nearest overlapping root and respects separators', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const root = context.config.sourceRoots[0];
  const nested = path.join(root, 'directory-a');
  const child = path.join(nested, 'child');
  const sibling = path.join(root, 'directory-a-other');
  mkdirSync(child);
  mkdirSync(sibling);
  // Options may include a trailing separator; parent selection must canonicalize it.
  context.config.sourceRoots = [root, `${nested}${path.sep}`];
  for (const [selected, parent] of [[root, null], [nested, null], [child, nested], [sibling, root]]) {
    const result = await context.request(`/api/sources?path=${encodeURIComponent(selected)}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.parent, parent, selected);
  }
});

test('OIDC uses nonce, state and PKCE, verifies signatures, binds exact subject and rejects replay', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: wrongKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const pending = new Map();
  let issuer;
  const provider = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }));
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
    if (req.url === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const flow = pending.get(params.get('code'));
      const challenge = createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      if (!flow || challenge !== flow.challenge || params.get('client_secret') !== 'oidc-test-private-secret') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: flow.subject, aud: 'backup-client', nonce: flow.badNonce ? 'incorrect-nonce' : flow.nonce, iat: now, exp: now + 120 })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), flow.badSignature ? wrongKey : privateKey).toString('base64url');
      return res.end(JSON.stringify({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 120, id_token: `${header}.${payload}.${signature}` }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${provider.address().port}`;
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const saved = await context.request('/api/settings', { method: 'PATCH', body: { oidc: { enabled: true, issuer, clientId: 'backup-client', clientSecret: 'oidc-test-private-secret', subject: 'only-admin' } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.oidc.clientSecret, undefined);
  assert.equal(saved.data.oidc.clientSecretSet, true);
  await context.request('/api/auth/logout', { method: 'POST' });
  async function flow(code, subject, { badSignature = false, badState = false, badNonce = false } = {}) {
    const start = await context.request('/api/auth/oidc/start', { useSession: false });
    assert.equal(start.status, 302);
    const authorization = new URL(start.response.headers.get('location'));
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${context.url}/api/auth/oidc/callback`);
    pending.set(code, { challenge: authorization.searchParams.get('code_challenge'), nonce: authorization.searchParams.get('nonce'), subject, badSignature, badNonce });
    const transaction = start.cookies.find((cookie) => cookie.startsWith('backup_oidc=')).split(';')[0];
    const callback = `/api/auth/oidc/callback?code=${code}&state=${badState ? 'wrong-state' : authorization.searchParams.get('state')}`;
    return { result: await context.request(callback, { useSession: false, extraCookie: transaction }), callback, transaction };
  }
  assert.equal((await flow('unbound', 'other-user')).result.status, 403);
  assert.equal((await flow('bad-signature', 'only-admin', { badSignature: true })).result.status, 401);
  assert.equal((await flow('bad-state', 'only-admin', { badState: true })).result.status, 401);
  assert.equal((await flow('bad-nonce', 'only-admin', { badNonce: true })).result.status, 401);
  const accepted = await flow('accepted', 'only-admin');
  assert.equal(accepted.result.status, 302);
  assert.equal((await context.request('/api/auth/status')).data.authenticated, true);
  assert.equal((await context.request(accepted.callback, { useSession: false, extraCookie: accepted.transaction })).status, 401);
});
