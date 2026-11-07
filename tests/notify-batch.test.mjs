import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createNotificationBatcher } from '../server/notify-batch.mjs';
import { createBackupService, sendNotificationEmail } from '../server/backup.mjs';
import { settingsSchema } from '../shared/contracts.mjs';

function fixture(t, { windowSec = 120, sendEmail } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-notify-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: path.join(root, 'source') }, root);
  let store = createStore(config);
  store.saveSettings({ notification: { aggregateWindowSec: windowSec }, smtp: {
    enabled: true, host: '127.0.0.1', mode: 'none', from: 'backup@example.test', to: ['admin@example.test'],
  } });
  let clock = Date.parse('2026-11-02T12:00:00Z');
  const messages = [];
  const batchers = [];
  const create = (factory = createNotificationBatcher) => {
    const batcher = factory({ store, now: () => clock, sendEmail: sendEmail || (async (settings, message) => { messages.push(message); return { sent: true }; }) });
    batchers.push(batcher);
    return batcher;
  };
  const job = (name, patch = {}) => store.saveJob({ name, sourcePath: config.sourceRoots[0], archive: { format: 'tar.gz' }, destinations: [{ remote: 'local', path: 'backups' }], ...patch });
  const run = (job, patch = {}) => {
    const queued = store.createRun(job);
    return store.updateRun(queued.id, {
      status: 'succeeded', phase: 'completed', cleanupStatus: 'cleaned',
      startedAt: new Date(clock - 10000).toISOString(), finishedAt: new Date(clock).toISOString(),
      archiveBytes: 4096, ...patch,
    });
  };
  t.after(async () => {
    for (const batcher of batchers) await batcher.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    config, get store() { return store; }, create, job, run, messages,
    advance(ms) { clock += ms; },
    reopen() { store.close(); store = createStore(config); },
  };
}

test('three completions persist as batched, then send one summary with three task rows', async (t) => {
  const f = fixture(t);
  const batcher = f.create();
  const runs = ['Files', 'Vault', 'Database'].map((name) => f.run(f.job(name)));
  await Promise.all(runs.map((run) => batcher.complete(run.id)));
  assert.deepEqual(runs.map((run) => f.store.getRun(run.id).notificationStatus), ['batched', 'batched', 'batched']);
  assert.equal(f.messages.length, 0);
  f.advance(119999);
  await batcher.flush();
  assert.equal(f.messages.length, 0);
  f.advance(1);
  await Promise.all([batcher.flush(), batcher.flush()]);
  assert.equal(f.messages.length, 1);
  const message = f.messages[0];
  assert.match(message.text, /共 3 个,成功 3,警告 0,失败 0/);
  for (const name of ['Files', 'Vault', 'Database']) assert.equal(message.text.split('\n').filter((line) => line.includes(name)).length, 1, name);
  assert.match(message.text, /10(?:s|\s)/);
  assert.match(message.text, /4096/);
  assert.deepEqual(runs.map((run) => f.store.getRun(run.id).notificationStatus), ['sent', 'sent', 'sent']);
});

test('scheduled delivery resets its timer on another completion and flushes without a manual call', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-02T12:00:00Z') });
  const f = fixture(t, { windowSec: 1 });
  const batcher = f.create((options) => createNotificationBatcher({ ...options, now: Date.now }));
  const first = f.run(f.job('Timer first'));
  await batcher.complete(first.id);
  t.mock.timers.tick(500);
  f.advance(500);
  const second = f.run(f.job('Timer second'));
  await batcher.complete(second.id);
  t.mock.timers.tick(500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.messages.length, 0, 'the first deadline was replaced by the newer quiet window');
  t.mock.timers.tick(500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.messages.length, 1);
  assert.ok([first, second].every((run) => f.store.getRun(run.id).notificationStatus === 'sent'));
});

test('zero window preserves three immediate individual notifications', async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const batcher = f.create();
  const runs = ['One', 'Two', 'Three'].map((name) => f.run(f.job(name)));
  await Promise.all(runs.map((run) => batcher.complete(run.id)));
  assert.equal(f.messages.length, 3);
  for (const message of f.messages) {
    assert.equal(['One', 'Two', 'Three'].filter((name) => message.text.includes(name)).length, 1);
  }
  assert.ok(runs.every((run) => f.store.getRun(run.id).notificationStatus === 'sent'));
});

test('mixed outcomes have disjoint success, warning and failed counts and error summaries', async (t) => {
  const f = fixture(t);
  const batcher = f.create();
  const runs = [
    f.run(f.job('Successful files')),
    f.run(f.job('Warning database'), { warnings: ['Remote checksum unavailable'] }),
    f.run(f.job('Failed vault'), { status: 'failed', error: 'Export unavailable', archiveBytes: null }),
  ];
  await Promise.all(runs.map((run) => batcher.complete(run.id)));
  f.advance(120000);
  await batcher.flush();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /共 3 个,成功 1,警告 1,失败 1/);
  assert.match(f.messages[0].text, /Warning database.*warning.*Remote checksum unavailable/);
  assert.match(f.messages[0].text, /Failed vault.*failed.*Export unavailable/);
  assert.equal(f.store.getRun(runs[0].id).status, 'succeeded');
  assert.equal(f.store.getRun(runs[1].id).status, 'succeeded');
  assert.equal(f.store.getRun(runs[2].id).status, 'failed');
});

test('queued and running runs gate delivery, and every completion resets the quiet window', async (t) => {
  const f = fixture(t);
  const batcher = f.create();
  const first = f.run(f.job('First'));
  await batcher.complete(first.id);
  const busy = f.store.createRun(f.job('Silent task', { notification: { success: false, failure: false } }));
  f.advance(120000);
  await batcher.flush();
  assert.equal(f.messages.length, 0, 'queued run blocks delivery');
  f.store.updateRun(busy.id, { status: 'running' });
  await batcher.flush();
  assert.equal(f.messages.length, 0, 'running run blocks delivery');
  f.store.updateRun(busy.id, { status: 'succeeded', finishedAt: '2026-11-02T12:02:00Z' });
  await batcher.complete(busy.id);
  assert.equal(f.store.getRun(busy.id).notificationStatus, 'disabled');
  f.advance(119999);
  await batcher.flush();
  assert.equal(f.messages.length, 0, 'even a disabled completion resets the quiet window');
  f.advance(1);
  await batcher.flush();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /First/);
  assert.doesNotMatch(f.messages[0].text, /Silent task/);
});

test('30-minute deadline flushes while another run is active', async (t) => {
  const f = fixture(t);
  const batcher = f.create();
  const run = f.run(f.job('Old completion'));
  await batcher.complete(run.id);
  f.store.createRun(f.job('Continuously active'));
  f.advance(30 * 60 * 1000 - 1);
  await batcher.flush();
  assert.equal(f.messages.length, 0);
  f.advance(1);
  await batcher.flush();
  assert.equal(f.messages.length, 1);
  assert.equal(f.store.getRun(run.id).notificationStatus, 'sent');
});

test('success before pruning finishes is not treated as a completed notification', async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const batcher = f.create();
  const run = f.run(f.job('Still pruning'), { finishedAt: null, phase: 'pruning' });
  await batcher.complete(run.id);
  assert.equal(f.messages.length, 0);
  assert.equal(f.store.getRun(run.id).notificationStatus, 'pending');
  f.store.updateRun(run.id, { finishedAt: '2026-11-02T12:00:00Z', phase: 'completed' });
  await batcher.complete(run.id);
  assert.equal(f.messages.length, 1);
});

test('SQLite reopen recovers terminal pending and batched runs without resending sent records', async (t) => {
  const f = fixture(t);
  const before = f.create();
  const batched = f.run(f.job('Batched before restart'));
  await before.complete(batched.id);
  const pending = f.run(f.job('Pending before restart'));
  f.run(f.job('Already sent'), { notificationStatus: 'sent' });
  f.run(f.job('Disabled'), { notificationStatus: 'disabled' });
  await before.shutdown();
  f.reopen();
  f.advance(120000);
  const after = f.create();
  await after.recover();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /Batched before restart/);
  assert.match(f.messages[0].text, /Pending before restart/);
  assert.doesNotMatch(f.messages[0].text, /Already sent|Disabled/);
  assert.equal(f.store.getRun(batched.id).notificationStatus, 'sent');
  assert.equal(f.store.getRun(pending.id).notificationStatus, 'sent');
  await after.recover();
  assert.equal(f.messages.length, 1);
});

test('deleting a terminal job does not discard its persisted batched notification', async (t) => {
  const f = fixture(t);
  const batcher = f.create();
  const job = f.job('Deleted task');
  const run = f.run(job);
  await batcher.complete(run.id);
  f.store.deleteJob(job.id);
  f.advance(120000);
  await batcher.flush();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /Deleted task/);
  assert.equal(f.store.getRun(run.id).notificationStatus, 'sent');
});

test('SMTP failure marks every notification failed while backup outcomes stay successful', async (t) => {
  const f = fixture(t, { sendEmail: async () => { throw new Error('Rejected with smtp-secret-value'); } });
  f.store.saveSettings({ smtp: { password: 'smtp-secret-value' } });
  const batcher = f.create();
  const runs = [f.run(f.job('A')), f.run(f.job('B'))];
  await Promise.all(runs.map((run) => batcher.complete(run.id)));
  f.advance(120000);
  await batcher.flush();
  for (const run of runs) {
    const saved = f.store.getRun(run.id);
    assert.equal(saved.status, 'succeeded');
    assert.equal(saved.notificationStatus, 'failed');
    assert.match(saved.warnings.at(-1), /Email notification failed/);
    assert.doesNotMatch(JSON.stringify(saved), /smtp-secret-value/);
    assert.match(saved.logs.at(-1).message, /\[REDACTED\]/);
  }
});

test('completion context is redacted before HTML escaping and HTML variables stay inert', async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const batcher = f.create();
  const secret = 'protected<&>value';
  const job = f.job(`<script>alert(1)</script> ${secret}`, { archive: { format: '7z', encrypted: true, password: secret } });
  await batcher.complete(f.run(job, { error: `Could not read ${secret}` }).id);
  assert.equal(f.messages.length, 1);
  const message = f.messages[0];
  assert.doesNotMatch(JSON.stringify(message), /protected|&lt;&amp;&gt;value/);
  assert.match(message.text, /\[REDACTED\]/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /&lt;script&gt;/);
});

test('custom template credentials are redacted before rendering HTML-sensitive secrets', { skip: !existsSync(new URL('../server/notify-template.mjs', import.meta.url)) }, async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const secret = 'smtp<secret>&';
  f.store.saveSettings({ smtp: { password: secret }, notification: { template: {
    subject: `Custom ${secret} {{total}}`, body: `Credential ${secret}\n{{#items}}{{jobName}} {{status}}{{/items}}`,
  } } });
  const batcher = f.create();
  await batcher.complete(f.run(f.job('Custom task')).id);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].subject, 'Custom [REDACTED] 1');
  for (const field of ['subject', 'text', 'html']) {
    assert.doesNotMatch(f.messages[0][field], /smtp|&lt;secret&gt;/);
    assert.match(f.messages[0][field], /\[REDACTED\]/);
  }
  assert.match(f.messages[0].text, /Custom task succeeded/);
});

test('an unavailable template module uses the built-in escaped summary without losing a batch', async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const original = new URL('../server/notify-batch.mjs', import.meta.url);
  // Execute the production coordinator in an isolated directory whose optional sibling is absent.
  // Static imports still resolve to the actual production helpers; no sibling files are moved or changed.
  const source = readFileSync(original, 'utf8').replace(/(from\s+)(['"])(\.[^'"]+)\2/g,
    (match, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, original).href}${quote}`);
  const isolated = path.join(path.dirname(f.config.dataDir), 'notify-batch.mjs');
  writeFileSync(isolated, source);
  const { createNotificationBatcher: createIsolated } = await import(pathToFileURL(isolated).href);
  const batcher = f.create(createIsolated);
  const run = f.run(f.job('<script>Fallback task</script>'));
  await batcher.complete(run.id);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /共 1 个,成功 1,警告 0,失败 0/);
  assert.equal(f.messages[0].text.split('\n').filter((line) => line.includes('Fallback task')).length, 1);
  assert.match(f.messages[0].html, /&lt;script&gt;Fallback task&lt;\/script&gt;/);
  assert.doesNotMatch(f.messages[0].html, /<script>/);
  assert.equal(f.store.getRun(run.id).notificationStatus, 'sent');
});

test('SMTP and per-job completion preferences disable notifications without sending', async (t) => {
  const f = fixture(t, { windowSec: 0 });
  const batcher = f.create();
  const muted = f.run(f.job('Muted', { notification: { success: false, failure: false } }));
  await batcher.complete(muted.id);
  assert.equal(f.store.getRun(muted.id).notificationStatus, 'disabled');
  const pending = f.run(f.job('SMTP off'));
  f.store.saveSettings({ smtp: { enabled: false } });
  await batcher.complete(pending.id);
  assert.equal(f.store.getRun(pending.id).notificationStatus, 'disabled');
  assert.equal(f.messages.length, 0);
});

test('in-flight delivery snapshots prevent duplicate sends and include later completions in the next batch', async (t) => {
  const deliveries = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { sendEmail: async (settings, message) => { deliveries.push(message); if (deliveries.length === 1) await waiting; } });
  const batcher = f.create();
  const first = f.run(f.job('First delivery'));
  await batcher.complete(first.id);
  f.advance(120000);
  const sending = batcher.flush();
  while (!deliveries.length) await new Promise((resolve) => setImmediate(resolve));
  const second = f.run(f.job('Second delivery'));
  const queued = batcher.complete(second.id);
  f.advance(120000);
  const duplicate = batcher.flush();
  release();
  await Promise.all([sending, queued, duplicate]);
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[0].text, /First delivery/);
  assert.doesNotMatch(deliveries[0].text, /Second delivery/);
  assert.match(deliveries[1].text, /Second delivery/);
  assert.doesNotMatch(deliveries[1].text, /First delivery/);
});

test('shutdown waits for SMTP and preserves later unsent batches for recovery', async (t) => {
  let release, accepted;
  const inFlight = new Promise((resolve) => { accepted = resolve; });
  const sending = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { sendEmail: async () => { accepted(); await sending; } });
  const batcher = f.create();
  const first = f.run(f.job('Sending'));
  await batcher.complete(first.id);
  f.advance(120000);
  const delivery = batcher.flush();
  await inFlight;
  let shutdownComplete = false;
  const shutdown = batcher.shutdown().then(() => { shutdownComplete = true; });
  const later = f.run(f.job('Unsent'));
  await batcher.complete(later.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownComplete, false);
  assert.equal(f.store.getRun(later.id).notificationStatus, 'batched');
  release();
  await Promise.all([delivery, shutdown]);
  assert.equal(f.store.getRun(first.id).notificationStatus, 'sent');
  assert.equal(f.store.getRun(later.id).notificationStatus, 'batched');
});

test('settings validate aggregation defaults and old SQLite settings read with defaults without rewriting secrets', async (t) => {
  assert.equal(settingsSchema.parse({}).notification.aggregateWindowSec, 120);
  assert.equal(settingsSchema.parse({ notification: {} }).notification.aggregateWindowSec, 120);
  assert.equal(settingsSchema.parse({ notification: { aggregateWindowSec: 0 } }).notification.aggregateWindowSec, 0);
  for (const value of [-1, 0.5, '120']) assert.equal(settingsSchema.safeParse({ notification: { aggregateWindowSec: value } }).success, false);
  const f = fixture(t);
  f.store.saveSettings({ smtp: { password: 'legacy-smtp-secret' } });
  const db = new DatabaseSync(path.join(f.config.dataDir, 'state.sqlite'));
  try {
    const legacy = JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get().data);
    delete legacy.notification;
    const raw = JSON.stringify(legacy);
    db.prepare('UPDATE settings SET data=? WHERE id=1').run(raw);
    assert.equal(f.store.getSettings().notification.aggregateWindowSec, 120);
    assert.equal(f.store.getSettings({ includeSecrets: true }).smtp.password, 'legacy-smtp-secret');
    assert.equal(f.store.getSettings().smtp.password, undefined);
    assert.equal(db.prepare('SELECT data FROM settings WHERE id=1').get().data, raw, 'reading defaults does not rewrite encrypted settings');
  } finally { db.close(); }
});

function smtpSink(t) {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('220 fixture.local ESMTP\r\n');
    let buffer = '', data = false, message = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; messages.push(message); message = ''; socket.write('250 accepted\r\n'); }
          else message += `${line}\n`;
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-fixture.local\r\n250 8BITMIME\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return { messages, async listen() { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; } };
}

test('real SMTP receives one multipart email containing the three aggregated task rows', async (t) => {
  const smtp = smtpSink(t);
  const port = await smtp.listen();
  const f = fixture(t, { sendEmail: sendNotificationEmail });
  f.store.saveSettings({ smtp: { port } });
  const batcher = f.create();
  const runs = ['SMTP one', 'SMTP two', 'SMTP three'].map((name) => f.run(f.job(name)));
  await Promise.all(runs.map((run) => batcher.complete(run.id)));
  f.advance(120000);
  await batcher.flush();
  assert.equal(smtp.messages.length, 1);
  assert.match(smtp.messages[0], /multipart\/alternative/);
  for (const name of ['SMTP one', 'SMTP two', 'SMTP three']) assert.match(smtp.messages[0], new RegExp(name));
  assert.ok(runs.every((run) => f.store.getRun(run.id).notificationStatus === 'sent'));
});

test('backup worker startup recovers an overdue persisted batch and keeps interrupted runs out', async (t) => {
  const smtp = smtpSink(t);
  const port = await smtp.listen();
  const f = fixture(t);
  f.store.saveSettings({ smtp: { port } });
  const old = f.run(f.job('Recovered worker notification'), { startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:01:00Z', notificationStatus: 'batched' });
  const interrupted = f.store.createRun(f.job('Interrupted worker'));
  const service = createBackupService({ store: f.store, config: f.config, rclone: {} });
  t.after(() => service.shutdown());
  for (let attempt = 0; attempt < 200 && f.store.getRun(old.id).notificationStatus !== 'sent'; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.store.getRun(old.id).notificationStatus, 'sent');
  assert.equal(f.store.getRun(interrupted.id).status, 'interrupted');
  assert.equal(f.store.getRun(interrupted.id).notificationStatus, 'disabled');
  assert.equal(smtp.messages.length, 1);
  await service.shutdown();
});
