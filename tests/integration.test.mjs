import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createRcloneService } from '../server/rclone.mjs';
import { createBackupService } from '../server/backup.mjs';
import { runProcess } from '../server/process.mjs';
import { newJob } from '../shared/contracts.mjs';

const toolRoot = path.resolve('.artifacts/tools');
const rcloneFolder = existsSync(toolRoot) && readdirSync(toolRoot).find((name) => name.startsWith('rclone-') && !name.endsWith('.zip'));
const rcloneBinary = process.env.RCLONE_BINARY || (rcloneFolder ? path.join(toolRoot, rcloneFolder, 'rclone.exe') : 'rclone');
const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (existsSync(path.join(toolRoot, '7zip/x64/7za.exe')) ? path.join(toolRoot, '7zip/x64/7za.exe') : '7zz');
const haveTools = process.env.RUN_BACKUP_INTEGRATION === '1' || (existsSync(rcloneBinary) && existsSync(sevenZipBinary));

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-integration-'));
  const config = loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: path.join(root, 'sources'), RCLONE_BINARY: rcloneBinary, SEVEN_ZIP_BINARY: sevenZipBinary }, root);
  const store = createStore(config);
  const remoteA = path.join(root, 'remote-a');
  const remoteB = path.join(root, 'remote-b');
  await mkdir(remoteA);
  await mkdir(remoteB);
  const sourceConfig = path.join(root, 'rclone.conf');
  await writeFile(sourceConfig, `[AB]\ntype = alias\nremote = ${remoteA}\n\n[BC]\ntype = alias\nremote = ${remoteB}\n`);
  const rclone = createRcloneService({ config, getSettings: () => store.getSettings({ includeSecrets: true }), saveSettings: (patch) => store.saveSettings(patch) });
  await rclone.importConfig(sourceConfig);
  const service = createBackupService({ config, store, rclone });
  try { await callback({ root, config, store, rclone, service, remoteA, remoteB }); }
  finally {
    await service.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function finish(store, run, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = store.getRun(run.id);
    if (!['queued', 'running'].includes(result.status) && result.finishedAt && result.notificationStatus !== 'pending') return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Integration backup did not finish within its timeout');
}

async function noStage(config, job, run) {
  await assert.rejects(access(path.join(config.tempDir, job.id, run.id)), { code: 'ENOENT' });
}

function smtpSink(reject = false) {
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
        else if (/^MAIL FROM/.test(line)) socket.write('250 sender accepted\r\n');
        else if (/^RCPT TO/.test(line)) socket.write(reject ? '550 recipient rejected\r\n' : '250 recipient accepted\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return {
    messages,
    async start() { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test('real AES-256 directory upload, checksum, SMTP, extraction and immediate cleanup', { skip: !haveTools, timeout: 90000 }, async () => {
  await fixture(async ({ root, config, store, service, rclone, remoteA }) => {
    const smtp = smtpSink();
    const port = await smtp.start();
    try {
      store.saveSettings({ smtp: { enabled: true, host: '127.0.0.1', port, mode: 'none', from: 'backup@example.test', to: ['admin@example.test'] } });
      const source = path.join(config.sourceRoots[0], 'directory-a');
      await mkdir(source);
      await writeFile(path.join(source, 'important.txt'), 'Real integration backup contents\n');
      await writeFile(path.join(source, 'ignored.log'), 'Excluded data\n');
      const input = newJob();
      Object.assign(input, { name: 'Directory integration', sourcePath: source, destinations: [{ remote: 'AB', path: 'backups/a' }], excludes: ['*.log'] });
      input.archive = { format: '7z', encrypted: true, password: 'archive-integration-pass', level: 1 };
      input.retry.attempts = 1;
      const job = store.saveJob(input);
      const run = await finish(store, service.enqueue(job.id));
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      assert.equal(run.cleanupStatus, 'cleaned');
      assert.equal(run.notificationStatus, 'sent');
      await noStage(config, job, run);
      assert.equal(smtp.messages.length, 1);
      assert.ok(!smtp.messages[0].includes('archive-integration-pass'));
      const target = run.targets[0];
      assert.ok(target.verification.includes('SHA256'));
      const remoteFile = path.join(remoteA, ...target.path.split('/'));
      const remoteStat = await rclone.stat('AB', target.path);
      assert.equal(remoteStat.size, run.archiveBytes);
      await assert.rejects(runProcess(sevenZipBinary, ['t', remoteFile, '-pincorrect-password', '-y']));
      const extracted = path.join(root, 'extracted');
      await mkdir(extracted);
      await runProcess(sevenZipBinary, ['x', remoteFile, `-o${extracted}`, '-parchive-integration-pass', '-y']);
      const tarFile = (await readdir(extracted)).find((name) => name.endsWith('.tar'));
      assert.ok(tarFile, 'Archive contains a metadata-preserving tar payload');
      const restored = path.join(root, 'restored');
      await mkdir(restored);
      await runProcess('tar', ['-xf', path.join(extracted, tarFile), '-C', restored]);
      assert.equal(await readFile(path.join(restored, 'important.txt'), 'utf8'), 'Real integration backup contents\n');
      await assert.rejects(access(path.join(restored, 'ignored.log')), { code: 'ENOENT' });
      assert.ok(!JSON.stringify(store.getRun(run.id)).includes('archive-integration-pass'));
    } finally { await smtp.close(); }
  });
});

test('real live WAL Vaultwarden snapshot, ZIP AES, optional artifacts and separate destination', { skip: !haveTools, timeout: 90000 }, async () => {
  await fixture(async ({ root, config, store, service, remoteB }) => {
    const source = path.join(config.sourceRoots[0], 'vaultwarden');
    await mkdir(source);
    const live = new DatabaseSync(path.join(source, 'db.sqlite3'));
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE secrets(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO secrets(value) VALUES(\'committed WAL row\');');
    await writeFile(path.join(source, 'rsa_key.pem'), 'Fixture key contents, not a production key\n');
    await mkdir(path.join(source, 'attachments'));
    await writeFile(path.join(source, 'attachments/document.txt'), 'Attachment bytes\n');
    try {
      const input = newJob('vaultwarden');
      Object.assign(input, { name: 'Vaultwarden WAL integration', sourcePath: source, destinations: [{ remote: 'BC', path: 'backups/vaultwarden' }] });
      input.vaultwarden.dataDir = source;
      input.archive = { format: 'zip', encrypted: true, password: 'zip-integration-pass', level: 1 };
      input.retry.attempts = 1;
      const job = store.saveJob(input);
      const run = await finish(store, service.enqueue(job.id));
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      await noStage(config, job, run);
      const remoteFile = path.join(remoteB, ...run.targets[0].path.split('/'));
      await assert.rejects(runProcess(sevenZipBinary, ['t', remoteFile, '-pwrong-password', '-y']));
      const extracted = path.join(root, 'vault-restored');
      await mkdir(extracted);
      await runProcess(sevenZipBinary, ['x', remoteFile, `-o${extracted}`, '-pzip-integration-pass', '-y']);
      const entries = await readdir(extracted);
      const database = entries.find((name) => /^db\..*\.sqlite3$/.test(name));
      assert.ok(database);
      assert.ok(entries.some((name) => /^rsakey\..*\.tar$/.test(name)));
      assert.ok(entries.some((name) => /^attachments\..*\.tar$/.test(name)));
      assert.ok(!entries.some((name) => /^config\./.test(name)));
      assert.ok(!entries.some((name) => /^sends\./.test(name)));
      const snapshot = new DatabaseSync(path.join(extracted, database), { readOnly: true });
      try {
        assert.equal(snapshot.prepare('SELECT value FROM secrets').get().value, 'committed WAL row');
        assert.equal(Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0], 'ok');
      } finally { snapshot.close(); }
    } finally { live.close(); }
  });
});

test('SMTP rejection preserves backup success and still removes successful staging', { skip: !haveTools, timeout: 90000 }, async () => {
  await fixture(async ({ config, store, service }) => {
    const smtp = smtpSink(true);
    const port = await smtp.start();
    try {
      store.saveSettings({ smtp: { enabled: true, host: '127.0.0.1', port, mode: 'none', from: 'backup@example.test', to: ['admin@example.test'] } });
      const input = newJob();
      input.name = 'Mail failure integration';
      input.sourcePath = config.sourceRoots[0];
      input.destinations = [{ remote: 'AB', path: 'backups/mail-failure' }];
      input.archive.format = 'tar.gz';
      input.retry.attempts = 1;
      await writeFile(path.join(input.sourcePath, 'file.txt'), 'Content survives notification failure');
      const job = store.saveJob(input);
      const run = await finish(store, service.enqueue(job.id));
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      assert.equal(run.notificationStatus, 'failed');
      await noStage(config, job, run);
    } finally { await smtp.close(); }
  });
});
