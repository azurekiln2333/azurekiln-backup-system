import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { DEFAULT_TEMPLATE } from '../server/notify-template.mjs';

// Exercises POST /api/settings/notification-template/preview end to end: auth
// boundary, default context, custom context, escaping, and the guarantee that
// previewing does not persist anything.

async function fixture() {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-template-'));
  const config = loadConfig({ SOURCE_ROOTS: path.join(folder, 'sources'), DATA_DIR: path.join(folder, 'data') }, folder);
  mkdirSync(path.join(config.sourceRoots[0], 'directory-a'));
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
    async health() { return { sqlite: { available: true, version: 'native' } }; },
  };
  const rclone = { async status() { return { available: false, configured: false, version: null, error: 'Tool not installed.' }; } };
  const runtime = await createApp({ config, store, scheduler, backupService, rclone });
  const server = await new Promise((resolve) => { const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = url;
  let session = '';
  let csrfToken = '';
  const request = async (route, { method = 'GET', body, csrf = true, useSession = true } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (useSession && session) headers.cookie = session;
    if (csrf && csrfToken) headers['x-csrf-token'] = csrfToken;
    const response = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('backup_session=')) session = cookie.split(';')[0];
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data };
  };
  const setup = () => request('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'a-strong-admin-password' } });
  return { config, store, request, setup, async close() { await runtime.close(); await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(folder, { recursive: true, force: true }); } };
}

const preview = (context, body, options) => context.request('/api/settings/notification-template/preview', { method: 'POST', body, ...options });

test('template preview requires an authenticated session', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  assert.equal((await preview(context, {}, { useSession: false, csrf: false })).status, 401);
  await context.setup();
  assert.equal((await preview(context, {})).status, 200);
});

test('preview renders sample data when no ctx is supplied', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const response = await preview(context, {});
  assert.equal(response.status, 200);
  assert.match(response.data.text, /备份汇总:共 3 个/);
  assert.equal(response.data.text.split('\n').filter((line) => line.startsWith('- ')).length, 3);
  assert.equal(response.data.ctx.total, 3);
  // The effective template and the variable list are returned so the settings
  // page can render hints without a second request.
  assert.deepEqual(response.data.template, { subject: '', body: '' });
  assert.deepEqual(response.data.defaults.subject, DEFAULT_TEMPLATE.subject);
  assert.ok(response.data.variables.items.includes('jobName'));
});

test('preview falls back to the stored template and honours an explicit one', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const saved = await context.request('/api/settings', { method: 'PATCH', body: { notification: { template: { subject: 'stored-subject', body: 'stored {{total}}' } } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.notification.template.subject, 'stored-subject');
  const fromStore = await preview(context, {});
  assert.equal(fromStore.data.subject, 'stored-subject');
  assert.equal(fromStore.data.text, 'stored 3');
  const explicit = await preview(context, { template: { subject: 'explicit', body: 'b {{total}}' } });
  assert.equal(explicit.data.subject, 'explicit');
  assert.equal(explicit.data.text, 'b 3');
});

test('preview accepts a caller-supplied context and escapes html', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const response = await preview(context, {
    template: { subject: 's', body: '{{hostName}}|{{#items}}{{jobName}}{{/items}}' },
    ctx: {
      total: 1, successCount: 0, warningCount: 0, failedCount: 1,
      startedAt: 'a', finishedAt: 'b', hostName: '<b>host</b>',
      items: [{ jobName: '<script>alert(1)</script>', type: 'directory', status: 'failed', durationSec: 1, archiveBytes: 2, error: '' }],
    },
  });
  assert.equal(response.status, 200);
  assert.ok(!response.data.html.includes('<script>'), 'preview must escape item fields');
  assert.ok(!response.data.html.includes('<b>host</b>'));
  assert.ok(response.data.html.includes('&lt;script&gt;'));
  assert.equal(response.data.text, '<b>host</b>|<script>alert(1)</script>');
});

test('preview is side-effect free', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  const before = JSON.stringify(context.store.getSettings());
  await preview(context, { template: { subject: 'transient', body: 'transient' }, ctx: { total: 9 } });
  assert.equal(JSON.stringify(context.store.getSettings()), before, 'preview must not persist settings');
});

test('preview rejects invalid templates instead of failing during rendering', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  assert.equal((await preview(context, { template: { subject: 'a\nb' } })).status, 400);
  assert.equal((await preview(context, { template: { body: 'x'.repeat(9000) } })).status, 400);
  assert.equal((await preview(context, { template: 'not-an-object' })).status, 400);
  // Unknown variables and odd syntax are tolerated, not rejected.
  const tolerated = await preview(context, { template: { subject: 'ok', body: 'a{{missing}}b{{#items}}{{/items}}' } });
  assert.equal(tolerated.status, 200);
});

test('stored template survives a settings round trip alongside other sections', async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await context.setup();
  await context.request('/api/settings', { method: 'PATCH', body: { notification: { template: { subject: 'S', body: 'B' }, aggregateWindowSec: 30 } } });
  const settings = await context.request('/api/settings');
  assert.deepEqual(settings.data.notification.template, { subject: 'S', body: 'B' });
  assert.equal(settings.data.notification.aggregateWindowSec, 30);
  // Clearing the template returns to the built-in default rather than persisting junk.
  await context.request('/api/settings', { method: 'PATCH', body: { notification: { template: { subject: '', body: '' } } } });
  assert.deepEqual((await context.request('/api/settings')).data.notification.template, { subject: '', body: '' });
  assert.match((await preview(context, {})).data.text, /备份汇总:共 3 个/);
});
