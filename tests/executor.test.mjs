import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createRcloneService } from '../server/rclone.mjs';
import { archiveArguments, createBackupService, diffSnapshot, fileHashes, parseArchivePercent, verifyRemote } from '../server/backup.mjs';
import { runProcess, redact } from '../server/process.mjs';
import { createScheduler } from '../server/scheduler.mjs';
import { jobSchema } from '../shared/contracts.mjs';

const rcloneBinary = process.env.RCLONE_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/rclone-v1.75.1-windows-amd64/rclone.exe') : 'rclone');
const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/7zip/x64/7za.exe') : '7z');
const liveTools = process.platform !== 'win32' || (existsSync(rcloneBinary) && existsSync(sevenZipBinary));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-executor-'));
  const source = path.join(root, 'sources');
  const remote = path.join(root, 'remote');
  await mkdir(source); await mkdir(remote);
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: JSON.stringify([source]), RCLONE_BINARY: rcloneBinary, SEVEN_ZIP_BINARY: sevenZipBinary }, root);
  const store = createStore(config);
  const original = path.join(root, 'rclone-original.conf');
  await writeFile(original, `[test]\ntype = alias\nremote = ${remote.replace(/\\/g, '/')}\n`);
  const rclone = createRcloneService({ config, getSettings: () => store.getSettings({ includeSecrets: true }), saveSettings: (patch) => store.saveSettings(patch) });
  await rclone.importConfig(original);
  const service = createBackupService({ config, store, rclone });
  const job = (patch = {}) => store.saveJob({ name: 'Fixture', sourcePath: source, archive: { format: 'tar.gz' }, destinations: [{ remote: 'test', path: 'backups' }], retry: { attempts: 1, delaySeconds: 1 }, ...patch });
  const cleanup = async () => { await service.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); };
  return { root, source, remote, config, store, rclone, service, job, cleanup };
}

async function waitRun(store, id) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const run = store.getRun(id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) && run.cleanupStatus !== 'pending' && run.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${id}: ${JSON.stringify(store.getRun(id))}`);
}

test('encryption uses AES-256 and encrypts 7z headers', () => {
  assert.deepEqual(archiveArguments({ format: '7z', level: 5, encrypted: true, password: 'strong secret' }, '/tmp/out.7z'), ['a', '-t7z', '-mx=5', '-y', '-bsp2', '-m0=LZMA2', '-pstrong secret', '-mhe=on', '/tmp/out.7z', '.']);
  assert.deepEqual(archiveArguments({ format: '7z', level: 9, encrypted: true, password: 'strong secret' }, '/tmp/out.7z'), ['a', '-t7z', '-mx=9', '-y', '-bsp2', '-m0=LZMA2', '-mmt=1', '-md=32m', '-pstrong secret', '-mhe=on', '/tmp/out.7z', '.']);
  assert.deepEqual(archiveArguments({ format: '7z', level: 9, method: 'lzma', threads: 2, dictionaryMiB: 16, encrypted: false }, '/tmp/out.7z'), ['a', '-t7z', '-mx=9', '-y', '-bsp2', '-m0=LZMA', '-mmt=2', '-md=16m', '/tmp/out.7z', '.']);
  assert.throws(() => archiveArguments({ format: '7z', level: 9, method: 'unknown', encrypted: false }, '/tmp/out.7z'), /Invalid 7z/);
  assert.equal(jobSchema.safeParse({ name: 'Bad method', archive: { method: 'unknown' } }).success, false);
  assert.ok(archiveArguments({ format: 'zip', level: 5, encrypted: true, password: 'secret' }, '/tmp/out.zip').includes('-mem=AES256'));
  assert.equal(parseArchivePercent(' 42% + db.sqlite3'), 42);
  assert.equal(parseArchivePercent('\u001b[2KCompressing: 63% + db.sqlite3'), 63);
  assert.equal(parseArchivePercent('Everything is Ok'), null);
  assert.throws(() => archiveArguments({ format: 'tar.gz', encrypted: true, password: 'secret' }, '/tmp/a'), /cannot provide/);
  assert.equal(redact('tool failed: strong secret password=value', ['strong secret']), 'tool failed: [REDACTED] password=[REDACTED]');
});

test('subprocess progress lines separated by carriage returns are reported', async () => {
  const lines = [];
  await runProcess(process.execPath, ['-e', "process.stderr.write(' 10%\\r 45%\\r 100%\\n')"], { onLine: (line) => lines.push(line) });
  assert.deepEqual(lines.map(parseArchivePercent), [10, 45, 100]);
  const stdoutLines = [];
  await runProcess(process.execPath, ['-e', "process.stdout.write(' 15%\\r 75%\\r 100%\\n')"], { onStdoutLine: (line) => stdoutLines.push(line) });
  assert.deepEqual(stdoutLines.map(parseArchivePercent), [15, 75, 100]);
});

test('remote verification requires size and validates comparable checksums', () => {
  assert.throws(() => verifyRemote(5, { SHA256: 'abc' }, { size: 4 }), /size mismatch/);
  assert.throws(() => verifyRemote(5, { SHA256: 'abc' }, { size: 5, hashes: { 'SHA-256': 'def' } }), /checksum mismatch/);
  assert.equal(verifyRemote(5, { SHA256: 'abc' }, { size: 5, hashes: { 'SHA-256': 'ABC' } }), 'size+SHA256');
  assert.match(verifyRemote(5, {}, { size: 5, hashes: {} }), /checksum unavailable/);
});

test('imported system archive appears only after its remote completion record is verified', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    const system = f.store.ensureSystemJob();
    const run = f.store.createRun(system);
    const archiveName = 'system-config.7z';
    const folderName = '2026-09-28_11-24-18';
    const sha256 = 'a'.repeat(64);
    let valid = false;
    const recovered = createBackupService({ config: f.config, store: f.store, rclone: {
      async readManifest() { return { jobId: system.id, runId: run.id, archiveName, folderName, archiveBytes: valid ? 5 : 4, sha256 }; },
      async stat() { return { size: 5 }; },
    } });
    try {
      recovered.registerImportedArchive({
        jobId: system.id, runId: run.id, archiveName, folderName, archiveBytes: 5, archiveSha256: sha256,
        targets: [{ destinationId: 'destination-1', remote: 'test', destinationPath: 'backups', folderName, path: `backups/${folderName}/${archiveName}` }],
      });
      await recovered.recoverImportedArchives(system.id);
      assert.equal(recovered.getArchives(system.id).length, 0);
      valid = true;
      await recovered.recoverImportedArchives(system.id);
      assert.equal(recovered.getArchives(system.id).length, 1);
    } finally { await recovered.shutdown(); }
  } finally { await f.cleanup(); }
});

test('cancellation terminates the owned subprocess', async () => {
  const controller = new AbortController();
  const child = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(child, { code: 'CANCELLED' });
});

test('directory upload, completion marker, download and immediate local cleanup use real tools', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'document.txt'), 'important data');
    const job = f.job();
    const queued = f.service.enqueue(job.id);
    assert.equal(f.service.enqueue(job.id).id, queued.id, 'duplicate enqueue reuses active run');
    const run = await waitRun(f.store, queued.id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(run.cleanupStatus, 'cleaned');
    assert.equal(run.targets[0].status, 'verified');
    assert.ok(run.targets[0].verification.startsWith('size+'));
    assert.equal(existsSync(path.join(f.config.tempDir, job.id, run.id)), false);
    const marker = JSON.parse(await readFile(path.join(f.remote, path.dirname(run.targets[0].path), 'complete.json'), 'utf8'));
    assert.equal(marker.jobId, job.id);
    assert.equal(marker.runId, run.id);
    assert.equal(marker.folderName, path.posix.basename(path.posix.dirname(run.targets[0].path)));
    assert.equal(marker.sha256, run.archiveSha256);
    assert.ok(!run.targets[0].path.includes(job.id));
    assert.ok(!run.targets[0].path.includes(run.id));
    assert.equal(f.service.getArchives(job.id).length, 1);
    const download = await f.service.prepareDownload(job.id, run.id, job.destinations[0].id);
    const extract = path.join(f.root, 'extract'); await mkdir(extract);
    await runProcess('tar', ['-xzf', download.path, '-C', extract]);
    const inner = (await readdir(extract)).find((name) => name.startsWith('directory.'));
    await runProcess('tar', ['-xf', path.join(extract, inner), '-C', extract]);
    assert.equal(await readFile(path.join(extract, 'document.txt'), 'utf8'), 'important data');
    await download.cleanup();
    assert.equal(existsSync(download.path), false);
  } finally { await f.cleanup(); }
});

test('manual cleanup retains successful archives across runs and restart until explicitly removed', { skip: !liveTools }, async () => {
  const f = await fixture();
  let restarted;
  try {
    f.store.saveSettings({ storage: { successCleanupMode: 'manual', failedRetentionHours: 0 } });
    await writeFile(path.join(f.source, 'document.txt'), 'retained backup');
    const job = f.job();
    const first = await waitRun(f.store, f.service.enqueue(job.id).id);
    const second = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    for (const run of [first, second]) {
      assert.equal(run.cleanupStatus, 'retained');
      assert.equal(existsSync(path.join(f.config.tempDir, job.id, run.id, run.archiveName)), true);
      assert.equal(existsSync(path.join(f.config.tempDir, job.id, run.id, 'complete.json')), false);
    }
    f.store.saveSettings({ storage: { successCleanupMode: 'immediate' } });
    const third = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(third.status, 'succeeded');
    assert.equal(third.cleanupStatus, 'cleaned');
    await f.service.shutdown();
    restarted = createBackupService({ config: f.config, store: f.store, rclone: f.rclone });
    const before = await restarted.storage();
    assert.equal(before.localArchives.length, 2);
    assert.ok(before.retainedBytes > 0);
    assert.ok(before.tempBytes >= before.retainedBytes);
    assert.equal(f.store.getRun(first.id).cleanupStatus, 'retained');
    await restarted.clearLocalArchive(first.id);
    assert.equal(f.store.getRun(first.id).cleanupStatus, 'cleaned');
    assert.equal(existsSync(path.join(f.config.tempDir, job.id, first.id)), false);
    assert.equal((await restarted.storage()).localArchives.length, 1);
    assert.deepEqual(await restarted.clearLocalArchives(), { cleaned: 1 });
    assert.equal(f.store.getRun(second.id).cleanupStatus, 'cleaned');
    assert.equal((await restarted.storage()).tempBytes, 0);
    await assert.rejects(restarted.clearLocalArchive(second.id), { code: 'LOCAL_ARCHIVE_NOT_FOUND' });
  } finally { await restarted?.shutdown(); await f.cleanup(); }
});

test('retained successful archive is never evicted to make space for a new run', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    f.store.saveSettings({ storage: { successCleanupMode: 'manual', failedRetentionHours: 0 } });
    await writeFile(path.join(f.source, 'large.bin'), randomBytes(850000));
    const job = f.job();
    const first = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    f.store.saveSettings({ storage: { maxTempBytes: 1048576 } });
    const second = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(second.status, 'failed');
    assert.match(second.error, /temporary storage limit/i);
    assert.equal(f.store.getRun(first.id).cleanupStatus, 'retained');
    assert.equal(existsSync(path.join(f.config.tempDir, job.id, first.id, first.archiveName)), true);
  } finally { await f.cleanup(); }
});

test('custom folder and archive names remain readable while IDs stay in the completion record', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'document.txt'), 'custom names');
    const job = f.job({ name: 'Vaultwarden Daily', archive: { format: 'tar.gz', folderTemplate: 'vault-{datetime}', fileTemplate: '{task}-{datetime}' } });
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.match(run.targets[0].path, /^backups\/vault-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z\/Vaultwarden Daily-.*\.tar\.gz$/);
    const marker = JSON.parse(await readFile(path.join(f.remote, path.dirname(run.targets[0].path), 'complete.json'), 'utf8'));
    assert.equal(marker.jobId, job.id);
    assert.equal(marker.runId, run.id);
    assert.equal(marker.archiveName, run.archiveName);
    assert.equal((await f.rclone.listArchives(job))[0].path, run.targets[0].path);
  } finally { await f.cleanup(); }
});

test('legacy UUID layout remains downloadable and eligible for owned retention', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'document.txt'), 'legacy version');
    const job = f.job({ retention: { days: 0, keepLast: 1 } });
    const first = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(first.status, 'succeeded');
    const oldPath = `backups/${job.id}/${first.id}/${first.archiveName}`;
    const oldFile = path.join(f.remote, ...oldPath.split('/'));
    const oldMarker = path.join(path.dirname(oldFile), 'complete.json');
    await mkdir(path.dirname(oldFile), { recursive: true });
    await rename(path.join(f.remote, ...first.targets[0].path.split('/')), oldFile);
    await rename(path.join(f.remote, path.dirname(first.targets[0].path), 'complete.json'), oldMarker);
    const target = { ...first.targets[0], path: oldPath };
    delete target.folderName;
    delete target.destinationPath;
    f.store.updateRun(first.id, { targets: [target] });
    const download = await f.service.prepareDownload(job.id, first.id);
    await download.cleanup();
    const second = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(second.status, 'succeeded', JSON.stringify(second));
    assert.equal(existsSync(oldFile), false);
    assert.equal(f.store.getRun(first.id).targets[0].status, 'pruned');
  } finally { await f.cleanup(); }
});

test('Vaultwarden SQLite snapshot includes committed live WAL rows and upstream artifacts', { skip: !liveTools }, async () => {
  const f = await fixture();
  const dbPath = path.join(f.source, 'db.sqlite3');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES (\'wal-row\');');
    assert.ok((await stat(`${dbPath}-wal`)).size > 0);
    await writeFile(path.join(f.source, 'rsa_key.pem'), 'fixture private key');
    await writeFile(path.join(f.source, 'config.json'), '{"fixture":true}');
    await mkdir(path.join(f.source, 'attachments'));
    await writeFile(path.join(f.source, 'attachments', 'a'), 'attachment');
    const job = f.job({ type: 'vaultwarden', vaultwarden: { dataDir: f.source, dbType: 'sqlite', rsaKeyPath: path.join(f.source, 'rsa_key') } });
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.ok(run.skipped.includes('sends'));
    const download = await f.service.prepareDownload(job.id, run.id);
    const extract = path.join(f.root, 'extract'); await mkdir(extract);
    await runProcess('tar', ['-xzf', download.path, '-C', extract]);
    const files = await readdir(extract);
    assert.ok(files.some((name) => /^config\..*\.json$/.test(name)));
    assert.ok(files.some((name) => /^rsakey\..*\.tar$/.test(name)));
    assert.ok(files.some((name) => /^attachments\..*\.tar$/.test(name)));
    assert.ok(!files.some((name) => name.includes('-wal') || name.includes('-shm')));
    const snapshot = new DatabaseSync(path.join(extract, files.find((name) => /^db\..*\.sqlite3$/.test(name))), { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT name FROM users').get().name, 'wal-row'); assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { snapshot.close(); }
    await download.cleanup();
  } finally { db.close(); await f.cleanup(); }
});

test('real encrypted 7z and ZIP reject incorrect passwords and accept configured passwords', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'document.txt'), 'secret content');
    for (const format of ['7z', 'zip']) {
      const job = f.job({ name: format, archive: { format, encrypted: true, password: 'correct-password-123', level: 1 } });
      const run = await waitRun(f.store, f.service.enqueue(job.id).id);
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      assert.ok(!JSON.stringify(run).includes('correct-password-123'));
      const download = await f.service.prepareDownload(job.id, run.id);
      await assert.rejects(runProcess(sevenZipBinary, ['t', '-pincorrect', download.path]), /exited/);
      await runProcess(sevenZipBinary, ['t', '-pcorrect-password-123', download.path]);
      await download.cleanup();
    }
  } finally { await f.cleanup(); }
});

test('upload failure preserves previous successful archive and bounded failure staging', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job = f.job({ retention: { days: 0, keepLast: 1 } });
    const successful = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(successful.status, 'succeeded');
    const goodUpload = f.rclone.upload;
    f.rclone.upload = async () => { throw new Error('simulated upload failure'); };
    const first = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(first.status, 'failed');
    const second = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(second.status, 'failed');
    assert.equal(existsSync(path.join(f.config.tempDir, job.id, first.id)), false, 'only latest failed staging retained');
    assert.equal(existsSync(path.join(f.config.tempDir, job.id, second.id, 'payload')), false, 'plaintext preparation artifacts removed');
    assert.equal(existsSync(path.join(f.remote, successful.targets[0].path)), true, 'failed run does not prune prior success');
    f.rclone.upload = goodUpload;
    const next = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(next.status, 'succeeded', JSON.stringify(next));
    assert.equal(existsSync(path.join(f.remote, successful.targets[0].path)), false, 'retention removes recorded older success');
    assert.equal(existsSync(path.join(f.remote, next.targets[0].path)), true);
  } finally { await f.cleanup(); }
});

test('snapshot diff reports added, modified and deleted paths without counting excluded ones', () => {
  const previous = { 'a.txt': [1, 10], 'b.txt': [2, 20], 'c.txt': [3, 30], 'skip/old.log': [4, 40] };
  const current = { 'a.txt': [1, 10], 'b.txt': [2, 25], 'd.txt': [5, 50] };
  assert.deepEqual(diffSnapshot(previous, current, ['skip/**']), { added: ['d.txt'], modified: ['b.txt'], deleted: ['c.txt'] });
});

async function extractIncremental(f, job, run) {
  const download = await f.service.prepareDownload(job.id, run.id, job.destinations[0].id);
  const extract = await mkdtemp(path.join(f.root, 'extract-'));
  await runProcess('tar', ['-xzf', download.path, '-C', extract]);
  await download.cleanup();
  const names = await readdir(extract);
  const inner = names.find((name) => name.startsWith('incremental.'));
  const files = path.join(extract, 'files'); await mkdir(files);
  await runProcess('tar', ['-xf', path.join(extract, inner), '-C', files]);
  const changes = JSON.parse(await readFile(path.join(extract, names.find((name) => name.startsWith('changes.'))), 'utf8'));
  const list = async (directory, prefix = '') => (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => entry.isDirectory() ? list(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))).flat().sort();
  return { names, files, changes, contents: await list(files) };
}

test('incremental watch runs archive only new and modified files while manual runs stay full', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    for (const name of ['1.txt', '2.txt', '3.txt', '4.txt']) await writeFile(path.join(f.source, name), name);
    await mkdir(path.join(f.source, 'cache'));
    const job = f.job({ excludes: ['cache/**'], watch: { enabled: true, mode: 'incremental', debounceSeconds: 1 } });
    assert.deepEqual(await f.service.ensureWatchBaseline(job.id), { created: true });
    assert.deepEqual(await f.service.ensureWatchBaseline(job.id), { created: false }, 'existing baseline is kept');

    await writeFile(path.join(f.source, '5.txt'), 'five');
    await writeFile(path.join(f.source, 'cache', 'ignored.bin'), 'ignored');
    const first = await waitRun(f.store, f.service.enqueue(job.id, 'watch').id);
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    assert.equal(first.backupKind, 'incremental');
    assert.deepEqual(first.changes, { added: 1, modified: 0, deleted: 0, sample: ['5.txt'] });
    assert.match(first.archiveName, /\.incremental\.tar\.gz$/);
    const firstArchive = await extractIncremental(f, job, first);
    assert.deepEqual(firstArchive.contents, ['5.txt']);
    assert.equal(await readFile(path.join(firstArchive.files, '5.txt'), 'utf8'), 'five');
    assert.equal(JSON.parse(await readFile(path.join(f.remote, path.dirname(first.targets[0].path), 'complete.json'), 'utf8')).backupKind, 'incremental');

    const idle = await waitRun(f.store, f.service.enqueue(job.id, 'watch').id);
    assert.equal(idle.status, 'succeeded');
    assert.equal(idle.archiveName, null);
    assert.deepEqual(idle.targets, []);
    assert.equal(idle.notificationStatus, 'disabled');

    await writeFile(path.join(f.source, '2.txt'), 'two, edited and longer');
    await rm(path.join(f.source, '3.txt'));
    await mkdir(path.join(f.source, 'nested'));
    await writeFile(path.join(f.source, 'nested', '6.txt'), 'six');
    const second = await waitRun(f.store, f.service.enqueue(job.id, 'watch').id);
    assert.equal(second.status, 'succeeded', JSON.stringify(second));
    const secondArchive = await extractIncremental(f, job, second);
    assert.deepEqual(secondArchive.contents, ['2.txt', 'nested/6.txt']);
    assert.deepEqual([secondArchive.changes.added, secondArchive.changes.modified, secondArchive.changes.deleted], [['nested/6.txt'], ['2.txt'], ['3.txt']]);

    const full = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(full.status, 'succeeded', JSON.stringify(full));
    assert.equal(full.backupKind, 'full');
    assert.doesNotMatch(full.archiveName, /incremental/);
    await writeFile(path.join(f.source, '7.txt'), 'seven');
    const afterFull = await waitRun(f.store, f.service.enqueue(job.id, 'watch').id);
    assert.deepEqual(afterFull.changes.sample, ['7.txt'], 'a full run resets the baseline');
  } finally { await f.cleanup(); }
});

test('incremental versions survive retention until a newer retained full version covers them', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'base.txt'), 'base');
    const job = f.job({ retention: { days: 0, keepLast: 1 }, watch: { enabled: true, mode: 'incremental', debounceSeconds: 1 } });
    const full1 = await waitRun(f.store, f.service.enqueue(job.id).id);
    const incrementals = [];
    for (const name of ['a.txt', 'b.txt']) {
      await writeFile(path.join(f.source, name), name);
      incrementals.push(await waitRun(f.store, f.service.enqueue(job.id, 'watch').id));
    }
    for (const run of [full1, ...incrementals]) assert.equal(run.status, 'succeeded', JSON.stringify(run));
    for (const run of [full1, ...incrementals]) assert.equal(existsSync(path.join(f.remote, run.targets[0].path)), true, 'keepLast counts only full versions');
    const full2 = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(full2.status, 'succeeded', JSON.stringify(full2));
    for (const run of [full1, ...incrementals]) assert.equal(existsSync(path.join(f.remote, run.targets[0].path)), false, `${run.backupKind} ${run.id} is covered by the newer full version`);
    assert.equal(existsSync(path.join(f.remote, full2.targets[0].path)), true);
  } finally { await f.cleanup(); }
});

test('retention keeps historical copies when an existing destination is edited to another path', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job = f.job({ retention: { days: 0, keepLast: 1 } });
    const original = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(original.status, 'succeeded');
    f.store.saveJob({ destinations: [{ ...job.destinations[0], path: 'new-backups' }] }, job.id);
    const moved = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(moved.status, 'succeeded', JSON.stringify(moved));
    const latest = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(latest.status, 'succeeded', JSON.stringify(latest));
    assert.equal(existsSync(path.join(f.remote, original.targets[0].path)), true, 'prior destination copy is outside current retention namespace');
    assert.equal(existsSync(path.join(f.remote, moved.targets[0].path)), false, 'current destination history is pruned normally');
    assert.equal(existsSync(path.join(f.remote, latest.targets[0].path)), true);
  } finally { await f.cleanup(); }
});

test('retention retries archive deletion after its completion marker was already removed', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job = f.job({ retention: { days: 0, keepLast: 1 } });
    const first = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(first.status, 'succeeded');
    const original = f.rclone.remove;
    let failed = false;
    f.rclone.remove = async (remote, remotePath, options) => {
      if (!failed && remotePath === first.targets[0].path) { failed = true; throw new Error('transient archive delete failure'); }
      return original(remote, remotePath, options);
    };
    const second = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(second.status, 'succeeded', JSON.stringify(second));
    const marker = path.join(f.remote, path.dirname(first.targets[0].path), 'complete.json');
    assert.equal(existsSync(marker), true, 'completion record stays until the archive is removed');
    assert.equal(existsSync(path.join(f.remote, first.targets[0].path)), true);
    const third = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(third.status, 'succeeded', JSON.stringify(third));
    assert.equal(existsSync(path.join(f.remote, first.targets[0].path)), false);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(path.dirname(marker)), false);
    assert.equal(f.store.getRun(first.id).targets[0].status, 'pruned');
    const password = f.store.getSettings({ includeSecrets: true }).rclone.configPassword;
    f.store.saveSettings({ rclone: { configPassword: 'incorrect-config-password' } });
    await assert.rejects(original('test', 'missing-file'), /decrypt|password/);
    f.store.saveSettings({ rclone: { configPassword: password } });
  } finally { await f.cleanup(); }
});

test('temporary quota monitor interrupts a growing exporter and removes sensitive staging', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await f.service.shutdown();
    f.store.saveSettings({ storage: { maxTempBytes: 1048576 } });
    const service = createBackupService({ config: f.config, store: f.store, rclone: f.rclone, runTool: async (binary, args, options) => {
      if (binary !== f.config.pgDumpBinary) return runProcess(binary, args, options);
      await writeFile(args[args.indexOf('--file') + 1], randomBytes(1200000));
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('owned exporter stopped')), { once: true }));
    } });
    try {
      const job = f.job({ type: 'vaultwarden', vaultwarden: { dataDir: f.source, dbType: 'postgresql', database: { host: 'db', username: 'backup' } } });
      const run = await waitRun(f.store, service.enqueue(job.id).id);
      assert.equal(run.status, 'failed', JSON.stringify(run));
      assert.match(run.error, /storage limit/);
      assert.equal(run.cleanupStatus, 'cleaned');
      assert.equal(existsSync(path.join(f.config.tempDir, job.id, run.id)), false);
    } finally { await service.shutdown(); }
  } finally { await f.cleanup(); }
});

test('excluded large files and escaping links do not enter traversal, size estimation or the archive', { skip: !liveTools }, async (t) => {
  for (const pattern of ['+(escape)', '{escape,other}', '[a-z]', '!escape', 'bad\\path', 'bad\npath']) {
    assert.equal(jobSchema.shape.excludes.safeParse([pattern]).success, false, `unsupported exclusion syntax rejected: ${pattern}`);
  }
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'important.txt'), 'included');
    await writeFile(path.join(f.source, 'large.log'), randomBytes(1200000));
    await mkdir(path.join(f.source, '.cache'));
    await writeFile(path.join(f.source, '.cache', 'large.bin'), randomBytes(1200000));
    await writeFile(path.join(f.root, 'outside.txt'), 'excluded escape');
    try { await symlink(path.join(f.root, 'outside.txt'), path.join(f.source, '.cache', 'escape')); } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.diagnostic('Host cannot create symlinks; excluded large file traversal remains covered');
    }
    f.store.saveSettings({ storage: { maxTempBytes: 1048576 } });
    const job = f.job({ excludes: ['*.log', '.cache'] });
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    const download = await f.service.prepareDownload(job.id, run.id);
    const extract = path.join(f.root, 'extract'); await mkdir(extract);
    await runProcess('tar', ['-xzf', download.path, '-C', extract]);
    const inner = (await readdir(extract)).find((name) => name.endsWith('.tar'));
    const listing = (await runProcess('tar', ['-tf', path.join(extract, inner)])).stdout;
    assert.ok(listing.includes('important.txt'));
    assert.ok(!listing.includes('large.log'));
    assert.ok(!listing.includes('.cache'));
    await download.cleanup();
  } finally { await f.cleanup(); }
});

test('queue is serial, active and queued cancellation work, restart marks interrupted runs', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job1 = f.job({ name: 'First' }); const job2 = f.job({ name: 'Second' });
    let reachedUpload;
    const uploadReached = new Promise((resolve) => { reachedUpload = resolve; });
    f.rclone.upload = (_local, _remote, _path, { signal }) => new Promise((_resolve, reject) => {
      reachedUpload(); signal.addEventListener('abort', () => reject(new Error('cancelled upload')), { once: true });
    });
    const run1 = f.service.enqueue(job1.id); const run2 = f.service.enqueue(job2.id);
    await Promise.race([uploadReached, waitRun(f.store, run1.id).then((run) => { throw new Error(`Run ended before reaching upload: ${JSON.stringify(run)}`); })]);
    assert.equal(f.store.getRun(run2.id).status, 'queued');
    f.service.cancel(run2.id);
    f.service.cancel(run1.id);
    assert.equal((await waitRun(f.store, run1.id)).status, 'cancelled');
    assert.equal(f.store.getRun(run2.id).status, 'cancelled');
    assert.equal(f.store.getRun(run2.id).notificationStatus, 'disabled');
    assert.equal(f.store.getRun(run2.id).cleanupStatus, 'cleaned');
    await f.service.shutdown();
    const stale = f.store.createRun(job1); f.store.updateRun(stale.id, { status: 'running' });
    const replacement = createBackupService({ config: f.config, store: f.store, rclone: f.rclone });
    assert.equal(f.store.getRun(stale.id).status, 'interrupted');
    assert.equal(f.store.getRun(stale.id).notificationStatus, 'disabled');
    assert.equal(f.store.getRun(stale.id).cleanupStatus, 'cleaned');
    const shutdownQueued = replacement.enqueue(job1.id);
    await replacement.shutdown();
    assert.equal(f.store.getRun(shutdownQueued.id).status, 'interrupted');
    assert.equal(f.store.getRun(shutdownQueued.id).notificationStatus, 'disabled');
    assert.equal(f.store.getRun(shutdownQueued.id).cleanupStatus, 'cleaned');
  } finally { await f.cleanup(); }
});

test('concurrent downloads reserve known archive sizes and release quota after cleanup', { skip: !liveTools }, async () => {
  const f = await fixture();
  let release;
  try {
    await writeFile(path.join(f.source, 'incompressible.bin'), randomBytes(600000));
    const job = f.job();
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.ok(run.archiveBytes > 500000 && run.archiveBytes < 1048576);
    f.store.saveSettings({ storage: { maxTempBytes: 1048576 } });
    const held = new Promise((resolve) => { release = resolve; });
    let arrived;
    const started = new Promise((resolve) => { arrived = resolve; });
    const original = f.rclone.download;
    f.rclone.download = async (...args) => { arrived(); await held; return original(...args); };
    const first = f.service.prepareDownload(job.id, run.id);
    await started;
    await assert.rejects(f.service.prepareDownload(job.id, run.id), /storage budget/);
    release();
    const download = await first;
    await download.cleanup();
    const next = await f.service.prepareDownload(job.id, run.id);
    await next.cleanup();
  } finally { release?.(); await f.cleanup(); }
});

test('download disconnect and shutdown abort active transfers and release staging reservations', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job = f.job();
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded');
    const original = f.rclone.download;
    const holdDownload = () => {
      let arrived;
      const ready = new Promise((resolve) => { arrived = resolve; });
      f.rclone.download = async (_remote, _remotePath, localPath, { signal }) => {
        await writeFile(localPath, 'partial');
        arrived();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled transfer')), { once: true }));
      };
      return ready;
    };
    const external = new AbortController();
    let ready = holdDownload();
    const pending = f.service.prepareDownload(job.id, run.id, undefined, { signal: external.signal });
    await ready;
    const rejected = assert.rejects(pending, /cancelled/);
    external.abort(); await rejected;
    assert.deepEqual(await readdir(path.join(f.config.tempDir, 'downloads')), []);
    f.rclone.download = original;
    const next = await f.service.prepareDownload(job.id, run.id);
    await next.cleanup();
    ready = holdDownload();
    const stopped = f.service.prepareDownload(job.id, run.id);
    await ready;
    const stopRejected = assert.rejects(stopped, /cancelled/);
    await f.service.shutdown(); await stopRejected;
    assert.deepEqual(await readdir(path.join(f.config.tempDir, 'downloads')), []);
  } finally { await f.cleanup(); }
});

test('download rejects changed remote size and stops growth beyond its archive reservation', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'a'), 'data');
    const job = f.job();
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded');
    const remoteFile = path.join(f.remote, run.targets[0].path);
    const originalBytes = await readFile(remoteFile);
    await writeFile(remoteFile, randomBytes(1200000));
    let downloaded = false;
    f.rclone.download = async () => { downloaded = true; };
    await assert.rejects(f.service.prepareDownload(job.id, run.id), /size changed/);
    assert.equal(downloaded, false, 'changed remote object is rejected before transfer');
    await writeFile(remoteFile, originalBytes);
    f.rclone.download = async (_remote, _remotePath, localPath, { signal }) => {
      await writeFile(localPath, randomBytes(1200000));
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('owned transfer stopped')), { once: true }));
    };
    await assert.rejects(f.service.prepareDownload(job.id, run.id), /exceeds the recorded archive size/);
    assert.deepEqual(await readdir(path.join(f.config.tempDir, 'downloads')), []);
  } finally { await f.cleanup(); }
});

test('restart removes plaintext preparation and database credentials before retaining a verified archive', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await f.service.shutdown();
    const job = f.job();
    const run = f.store.createRun(job);
    const stage = path.join(f.config.tempDir, job.id, run.id);
    await mkdir(path.join(stage, 'payload'), { recursive: true });
    await writeFile(path.join(stage, 'payload', 'db.sqlite3'), 'plaintext snapshot');
    await writeFile(path.join(stage, 'mysql-client.cnf'), '[client]\npassword=sensitive\n');
    const name = `directory.fixture.${run.id}.7z`;
    const artifact = path.join(stage, name);
    await writeFile(artifact, 'fixture of previously verified complete archive bytes');
    const hashes = await fileHashes(artifact);
    f.store.updateRun(run.id, { status: 'running', archiveName: name, archiveBytes: (await stat(artifact)).size, archiveSha256: hashes.SHA256 });
    const replacement = createBackupService({ config: f.config, store: f.store, rclone: f.rclone });
    await replacement.shutdown();
    assert.equal(f.store.getRun(run.id).status, 'interrupted');
    assert.equal(f.store.getRun(run.id).notificationStatus, 'disabled');
    assert.equal(f.store.getRun(run.id).cleanupStatus, 'retained');
    assert.deepEqual(await readdir(stage), [name]);
    assert.equal(existsSync(path.join(stage, 'payload')), false);
    assert.equal(existsSync(path.join(stage, 'mysql-client.cnf')), false);
  } finally { await f.cleanup(); }
});

test('rclone invalid import retains active working configuration and DTO exposes no credentials', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.config.rcloneConfigPath, 'utf8');
    const invalid = path.join(f.root, 'invalid.conf'); await writeFile(invalid, '[broken');
    await assert.rejects(f.rclone.importConfig(invalid));
    assert.equal(await readFile(f.config.rcloneConfigPath, 'utf8'), before);
    assert.deepEqual(await f.rclone.listRemotes(), [{ name: 'test', type: 'alias' }]);
    await assert.rejects(f.rclone.mkdir('test', '../escape'), /traversal/);
  } finally { await f.cleanup(); }
});

test('imported rclone tokens are encrypted at rest and a fresh adapter decrypts using sealed state', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    const encoded = await readFile(f.config.rcloneConfigPath, 'utf8');
    assert.match(encoded, /RCLONE_ENCRYPT_V0:/);
    assert.ok(!encoded.includes('type = alias'));
    const internal = f.store.getSettings({ includeSecrets: true }).rclone.configPassword;
    assert.ok(internal.length > 30);
    assert.equal(f.store.getSettings().rclone.configPassword, undefined);
    assert.equal(f.store.getSettings().rclone.configPasswordSet, true);
    assert.equal(f.store.getSettings().rclone.sourceConfigPath, path.join(f.root, 'rclone-original.conf'));
    const reloaded = createRcloneService({ config: f.config, getSettings: () => f.store.getSettings({ includeSecrets: true }), saveSettings: (patch) => f.store.saveSettings(patch) });
    assert.deepEqual(await reloaded.listRemotes(), [{ name: 'test', type: 'alias' }]);
    const encryptedCopy = path.join(f.root, 'encrypted-source.conf');
    await writeFile(encryptedCopy, encoded);
    await reloaded.importConfig(encryptedCopy);
    assert.equal(f.store.getSettings({ includeSecrets: true }).rclone.configPassword, internal, 'already encrypted import retains its configured password');
    assert.deepEqual(await reloaded.listRemotes(), [{ name: 'test', type: 'alias' }]);
  } finally { await f.cleanup(); }
});

test('encrypted candidate passwords and persistence errors cannot invalidate the current rclone configuration', { skip: !liveTools }, async () => {
  const f = await fixture();
  const another = await fixture();
  try {
    const oldPassword = f.store.getSettings({ includeSecrets: true }).rclone.configPassword;
    const original = await readFile(f.config.rcloneConfigPath, 'utf8');
    const invalid = path.join(f.root, 'invalid-encrypted.conf');
    await writeFile(invalid, '# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\ninvalid');
    await assert.rejects(f.rclone.importConfig(invalid, 'rejected-candidate-password'));
    assert.equal(f.store.getSettings({ includeSecrets: true }).rclone.configPassword, oldPassword);
    assert.equal(await readFile(f.config.rcloneConfigPath, 'utf8'), original);
    const failedPersistence = createRcloneService({ config: f.config, getSettings: () => f.store.getSettings({ includeSecrets: true }), saveSettings() { throw new Error('simulated state write failure'); } });
    await assert.rejects(failedPersistence.importConfig(path.join(f.root, 'rclone-original.conf')), /state write failure/);
    assert.equal(await readFile(f.config.rcloneConfigPath, 'utf8'), original);
    assert.equal(f.store.getSettings({ includeSecrets: true }).rclone.configPassword, oldPassword);
    assert.deepEqual(await f.rclone.listRemotes(), [{ name: 'test', type: 'alias' }]);
    const newPassword = another.store.getSettings({ includeSecrets: true }).rclone.configPassword;
    assert.notEqual(newPassword, oldPassword);
    await f.rclone.importConfig(another.config.rcloneConfigPath, newPassword);
    assert.equal(f.store.getSettings({ includeSecrets: true }).rclone.configPassword, newPassword);
    assert.deepEqual(await f.rclone.listRemotes(), [{ name: 'test', type: 'alias' }]);
    assert.ok(!JSON.stringify(await f.rclone.status()).includes(newPassword));
  } finally { await f.cleanup(); await another.cleanup(); }
});

test('scheduler persists timezone-aware next execution and clears paused schedules', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    const job = f.job({ schedule: { enabled: true, cron: '0 3 * * *', timezone: 'Asia/Shanghai' } });
    const scheduler = createScheduler({ store: f.store, backupService: f.service });
    scheduler.start();
    assert.ok(Date.parse(f.store.getJob(job.id).nextRunAt) > Date.now());
    f.store.updateJob(job.id, { enabled: false }); scheduler.refresh();
    assert.equal(f.store.getJob(job.id).nextRunAt, null);
    scheduler.stop();
  } finally { await f.cleanup(); }
});

test('PostgreSQL and MariaDB export use protected credentials, transactional options and configured TLS', { skip: !liveTools }, async () => {
  const f = await fixture();
  try {
    await f.service.shutdown();
    const ca = path.join(f.source, 'ca.pem'); await writeFile(ca, 'fixture CA');
    const calls = [];
    const runner = async (binary, args, options) => {
      if (binary === f.config.pgDumpBinary) {
        calls.push({ binary, args, env: options.env });
        await writeFile(args[args.indexOf('--file') + 1], 'PGDMP fixture contract payload');
        return { stdout: '', stderr: '' };
      }
      if (binary === f.config.mysqlDumpBinary) {
        const defaults = args.find((arg) => arg.startsWith('--defaults-extra-file=')).split('=').slice(1).join('=');
        calls.push({ binary, args, credentials: await readFile(defaults, 'utf8'), credentialFile: defaults });
        writeSync(options.stdoutFile, '-- fixture SQL dump\n');
        return { stdout: '', stderr: '' };
      }
      return runProcess(binary, args, options);
    };
    const service = createBackupService({ config: f.config, store: f.store, rclone: f.rclone, runTool: runner });
    try {
      for (const dbType of ['postgresql', 'mysql']) {
        const job = f.job({ type: 'vaultwarden', vaultwarden: { dataDir: f.source, dbType, database: { host: 'db.internal', name: dbType === 'mysql' ? '--all-databases' : 'vaultwarden', username: 'backup', password: 'db-contract-secret', sslMode: dbType === 'mysql' ? 'require' : 'verify-full', sslCa: ca } } });
        const run = await waitRun(f.store, service.enqueue(job.id).id);
        assert.equal(run.status, 'succeeded', JSON.stringify(run));
        assert.ok(!JSON.stringify(run).includes('db-contract-secret'));
      }
      const pg = calls.find((call) => call.binary === f.config.pgDumpBinary);
      assert.ok(pg.args.includes('--format=custom'));
      assert.ok(pg.args.includes('--no-password'));
      assert.ok(!pg.args.join(' ').includes('db-contract-secret'));
      assert.equal(pg.env.PGSSLMODE, 'verify-full'); assert.equal(pg.env.PGSSLROOTCERT, ca);
      assert.equal(pg.env.PGPASSWORD, 'db-contract-secret');
      const mysql = calls.find((call) => call.binary === f.config.mysqlDumpBinary);
      assert.ok(mysql.args.includes('--single-transaction'));
      assert.ok(mysql.args.includes('--skip-lock-tables'));
      assert.equal(mysql.args.at(-2), '--', 'database name cannot inject mysqldump options');
      assert.equal(mysql.args.at(-1), '--all-databases');
      assert.ok(!mysql.args.join(' ').includes('db-contract-secret'));
      assert.match(mysql.credentials, /ssl-verify-server-cert=1/);
      assert.ok(mysql.credentials.includes('db-contract-secret'));
      assert.equal(existsSync(mysql.credentialFile), false);
    } finally { await service.shutdown(); }
    const failing = createBackupService({ config: f.config, store: f.store, rclone: f.rclone, runTool: async (binary, args, options) => {
      if (binary === f.config.pgDumpBinary) throw new Error('database failed with db-contract-secret');
      return runProcess(binary, args, options);
    } });
    try {
      const job = f.job({ type: 'vaultwarden', vaultwarden: { dataDir: f.source, dbType: 'postgresql', database: { host: 'db', username: 'backup', password: 'db-contract-secret' } } });
      const run = await waitRun(f.store, failing.enqueue(job.id).id);
      assert.equal(run.status, 'failed'); assert.equal(run.cleanupStatus, 'cleaned');
      assert.ok(!JSON.stringify(run).includes('db-contract-secret'));
      assert.equal(run.archiveName, null, 'failed mandatory DB export cannot produce a successful archive');
    } finally { await failing.shutdown(); }
  } finally { await f.cleanup(); }
});

test('tar preserves internal symlinks while source escapes are rejected', { skip: !liveTools }, async (t) => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'target.txt'), 'linked data');
    try { await symlink('target.txt', path.join(f.source, 'link.txt')); } catch (error) {
      if (error.code === 'EPERM') { t.skip('Windows host cannot create symlinks without elevation'); return; } throw error;
    }
    const job = f.job();
    const run = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    await writeFile(path.join(f.root, 'outside.txt'), 'outside');
    await symlink(path.join(f.root, 'outside.txt'), path.join(f.source, 'escape.txt'));
    const rejected = await waitRun(f.store, f.service.enqueue(job.id).id);
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error, /outside|escape/);
  } finally { await f.cleanup(); }
});
