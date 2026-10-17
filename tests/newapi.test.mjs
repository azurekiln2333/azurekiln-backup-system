import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.mjs';
import { jobSchema, newJob } from '../shared/contracts.mjs';
import { archiveArguments } from '../server/backup.mjs';
import { runProcess } from '../server/process.mjs';
import {
  buildRestoreDocument, digestOrderColumns, mysqlDumpArguments, mysqlOptionFile, newApiScopeWarnings, newApiSecrets,
  pgDumpEnvironment, prepareNewApi, sqliteTableDigests, tableDigest, validateNewApiJob,
} from '../server/newapi.mjs';

const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (process.platform === 'win32' ? path.resolve('.artifacts/tools/7zip/x64/7za.exe') : '7z');
// Real archive round trips need the actual 7-Zip binary; skip them on hosts without it.
const liveSevenZip = existsSync(sevenZipBinary);
const ARCHIVE_PASSWORD = 'roundtrip-archive-pass';

/** Pack the payload exactly the way a run does, using backup.mjs' own argument builder. */
async function packArchive({ payload, archivePath, format = '7z', encrypted = true, password = ARCHIVE_PASSWORD }) {
  const archive = { format, level: 5, method: 'lzma2', threads: 0, dictionaryMiB: 0, encrypted, password };
  await runProcess(sevenZipBinary, archiveArguments(archive, archivePath), { cwd: payload, secrets: [password] });
  return archivePath;
}

/** Extract an archive into a fresh empty directory, as a restorer on another machine would. */
async function unpackArchive({ archivePath, target, password = ARCHIVE_PASSWORD }) {
  await mkdir(target, { recursive: true });
  await runProcess(sevenZipBinary, ['x', archivePath, `-o${target}`, `-p${password}`, '-y', '-bd'], { secrets: [password] });
  return target;
}

// A tiny new-api shaped schema: enough tables to prove table-by-table fidelity without a live server.
const NEWAPI_TABLES = {
  users: `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, quota INTEGER, used_quota INTEGER, aff_quota INTEGER, aff_history INTEGER, role INTEGER, status INTEGER, `+"`group`"+` TEXT)`,
  tokens: `CREATE TABLE tokens (id INTEGER PRIMARY KEY, user_id INTEGER, `+"`key`"+` TEXT, name TEXT, remain_quota INTEGER, used_quota INTEGER, unlimited_quota NUMERIC)`,
  channels: `CREATE TABLE channels (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, `+"`key`"+` TEXT, base_url TEXT, model_mapping TEXT, `+"`group`"+` TEXT, priority INTEGER)`,
  options: `CREATE TABLE options (`+"`key`"+` TEXT PRIMARY KEY, value TEXT)`,
  logs: `CREATE TABLE logs (id INTEGER PRIMARY KEY, user_id INTEGER, created_at INTEGER, model_name TEXT, quota INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, channel_id INTEGER, `+"`group`"+` TEXT, ip TEXT, other TEXT)`,
  topups: `CREATE TABLE topups (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER, trade_no TEXT, status TEXT)`,
  redemptions: `CREATE TABLE redemptions (id INTEGER PRIMARY KEY, `+"`key`"+` TEXT, status INTEGER, quota INTEGER)`,
  setups: `CREATE TABLE setups (id INTEGER PRIMARY KEY, version TEXT, initialized_at INTEGER)`,
};

function seedDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  try {
    for (const sql of Object.values(NEWAPI_TABLES)) db.exec(sql);
    db.exec(`INSERT INTO users VALUES (1,'root','$2a$10$hash',100000000,4242,100,20,100,1,'default'),(2,'测试用户','$2a$10$hash2',500,12,0,0,1,1,'vip')`);
    db.exec(`INSERT INTO tokens VALUES (1,1,'sk-aaaaaaaaaaaaaaaa','默认令牌',900,100,1),(2,2,'sk-bbbbbbbbbbbbbbbb','VIP 令牌',400,50,0)`);
    db.exec(`INSERT INTO channels VALUES (1,1,'OpenAI 主渠道','sk-upstream-secret-1','https://api.example.com','{"gpt-4":"gpt-4-turbo"}','default',0)`);
    db.exec(`INSERT INTO options VALUES ('SystemName','测试站点'),('QuotaPerUnit','500000'),('ModelPrice','{"gpt-4":0.03}')`);
    db.exec(`INSERT INTO logs VALUES (1,1,1730000000,'gpt-4',1200,800,400,1,'default','10.0.0.1','{"stream":true}'),(2,2,1730000100,'claude-3',300,100,200,1,'vip','10.0.0.2','{}'),(3,1,1730000200,'gpt-4',1500,900,600,1,'default','10.0.0.3','{}')`);
    db.exec(`INSERT INTO topups VALUES (1,1,1000,'trade-中文-001','success')`);
    db.exec(`INSERT INTO redemptions VALUES (1,'redeem-abc',1,500)`);
    db.exec(`INSERT INTO setups VALUES (1,'v0.test',1730000000)`);
  } finally { db.close(); }
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-newapi-'));
  const sources = path.join(root, 'sources');
  const dataDir = path.join(sources, 'new-api', 'data');
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(dataDir, 'new-api-body-cache'), { recursive: true });
  await writeFile(path.join(dataDir, 'new-api-body-cache', 'cache.bin'), 'regenerable');
  await writeFile(path.join(dataDir, 'readme-data.txt'), 'keep me');
  await writeFile(path.join(dataDir, 'one-api.db-wal'), 'stale wal');
  seedDatabase(path.join(dataDir, 'one-api.db'));
  const envFile = path.join(sources, 'new-api', '.env');
  await writeFile(envFile, 'SQL_DSN=\nCRYPTO_SECRET=super-secret-crypto\nSESSION_SECRET=super-secret-session\nREDIS_CONN_STRING=redis://:pw@redis:6379\n');
  const config = loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: JSON.stringify([sources]) }, root);
  return { root, sources, dataDir, envFile, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function baseJob(workspace, patch = {}) {
  return jobSchema.parse({
    name: 'new-api 全量',
    type: 'newapi',
    enabled: false,
    destinations: [{ remote: 'test', path: 'newapi' }],
    archive: { format: '7z', encrypted: true, password: 'archive-pass' },
    newapi: {
      dataDir: workspace.dataDir,
      envFilePath: workspace.envFile,
      database: { password: 'db-pass' },
      logDatabase: { password: 'log-pass' },
      ...patch,
    },
  });
}

async function collectPayload(directory) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(directory, full).split(path.sep).join('/'));
    }
  }
  await walk(directory);
  return out.sort();
}

test('newapi job type is part of the contract with a complete default block', () => {
  const job = newJob('newapi');
  assert.equal(job.type, 'newapi');
  assert.equal(job.newapi.dbType, 'sqlite');
  assert.equal(job.newapi.logDbType, 'same');
  assert.equal(job.newapi.includeLogTable, true);
  assert.equal(job.newapi.includeLogs, false);
  assert.deepEqual(job.newapi.database, { host: '', name: '', username: '', sslMode: 'default', sslCa: '', sslCert: '', sslKey: '' });
  assert.ok(jobSchema.safeParse({ name: 'x', type: 'newapi' }).success);
  assert.equal(jobSchema.shape.type.safeParse('newapi').success, true);
  // Old tasks without a newapi block keep parsing.
  assert.deepEqual(jobSchema.parse({ name: 'old' }).newapi, newJob('newapi').newapi);
});

test('validateNewApiJob sandboxes every path and requires an encrypted 7z archive', async () => {
  const workspace = await makeWorkspace();
  try {
    const job = baseJob(workspace);
    validateNewApiJob(job, workspace.config);
    assert.equal(job.newapi.dataDir, workspace.dataDir);
    assert.equal(job.sourcePath, workspace.dataDir);
    assert.equal(job.newapi.sqlitePath, path.join(workspace.dataDir, 'one-api.db'));

    assert.throws(() => validateNewApiJob(baseJob(workspace, { envFilePath: '' }), workspace.config), { code: 'NEWAPI_ENV_REQUIRED' });
    assert.throws(() => validateNewApiJob(baseJob(workspace, { dataDir: 'relative/path' }), workspace.config), /absolute source path/);
    assert.throws(() => validateNewApiJob(baseJob(workspace, { dataDir: path.join(os.tmpdir(), 'outside') }), workspace.config), { code: 'SOURCE_PATH_FORBIDDEN' });

    // A SQLite path outside the data directory would make the archive stop being self-describing.
    const elsewhere = path.join(workspace.sources, 'other-db', 'one-api.db');
    await mkdir(path.dirname(elsewhere), { recursive: true });
    seedDatabase(elsewhere);
    assert.throws(() => validateNewApiJob(baseJob(workspace, { sqlitePath: elsewhere }), workspace.config), { code: 'NEWAPI_SQLITE_OUTSIDE_DATA_DIR' });
    // Inside the data directory is accepted and recorded relative to it.
    const nested = path.join(workspace.dataDir, 'nested', 'one-api.db');
    await mkdir(path.dirname(nested), { recursive: true });
    seedDatabase(nested);
    const nestedJob = baseJob(workspace, { sqlitePath: nested });
    validateNewApiJob(nestedJob, workspace.config);
    assert.equal(nestedJob.newapi.sqlitePath, nested);

    const plaintext = baseJob(workspace);
    plaintext.archive.encrypted = false;
    assert.throws(() => validateNewApiJob(plaintext, workspace.config), { code: 'NEWAPI_ARCHIVE_REQUIRED' });
    const targz = baseJob(workspace);
    targz.archive.format = 'tar.gz';
    targz.archive.encrypted = false;
    assert.throws(() => validateNewApiJob(targz, workspace.config), { code: 'NEWAPI_ARCHIVE_REQUIRED' });

    const remote = baseJob(workspace);
    remote.newapi.dbType = 'mysql';
    assert.throws(() => validateNewApiJob(remote, workspace.config), { code: 'NEWAPI_DATABASE_INVALID' });
    remote.newapi.database = { host: 'db', name: 'new-api', username: 'root', port: undefined };
    validateNewApiJob(remote, workspace.config);
    assert.equal(remote.newapi.database.port, 3306);

    const multiline = baseJob(workspace);
    multiline.newapi.dbType = 'postgresql';
    multiline.newapi.database = { host: 'db', name: 'new-api\nDROP', username: 'root' };
    assert.throws(() => validateNewApiJob(multiline, workspace.config), { code: 'NEWAPI_DATABASE_INVALID' });

    const clickhouse = baseJob(workspace);
    clickhouse.newapi.logDbType = 'clickhouse';
    clickhouse.newapi.logDatabase = { host: 'clickhouse', name: 'new_api_logs' };
    validateNewApiJob(clickhouse, workspace.config);
    assert.equal(clickhouse.newapi.logDatabase.port, 8123);
    assert.match(newApiScopeWarnings(clickhouse).join(' '), /not exported automatically/);

    // Watching is never allowed for newapi tasks.
    const watching = baseJob(workspace);
    watching.watch.enabled = true;
    validateNewApiJob(watching, workspace.config);
    assert.equal(watching.watch.enabled, false);

    // A SQLite snapshot cannot drop a single table, so the combination is refused instead of
    // silently archiving logs while the manifest claims they were excluded.
    const sqliteNoLogs = baseJob(workspace);
    sqliteNoLogs.newapi.includeLogTable = false;
    assert.throws(() => validateNewApiJob(sqliteNoLogs, workspace.config), { code: 'NEWAPI_LOG_TABLE_REQUIRED' });

    const sqliteLogDb = baseJob(workspace);
    sqliteLogDb.newapi.logDbType = 'sqlite';
    sqliteLogDb.newapi.logSqlitePath = path.join(workspace.dataDir, 'one-api-log.db');
    sqliteLogDb.newapi.includeLogTable = false;
    assert.throws(() => validateNewApiJob(sqliteLogDb, workspace.config), { code: 'NEWAPI_LOG_TABLE_REQUIRED' });

    // Excluding logs is allowed for a server database, and exactly one warning is emitted.
    const mysqlNoLogs = baseJob(workspace);
    mysqlNoLogs.newapi.dbType = 'mysql';
    mysqlNoLogs.newapi.database = { host: 'db', name: 'new-api', username: 'root' };
    mysqlNoLogs.newapi.includeLogTable = false;
    validateNewApiJob(mysqlNoLogs, workspace.config);
    const mysqlWarnings = newApiScopeWarnings(mysqlNoLogs);
    assert.equal(mysqlWarnings.filter((warning) => /logs/i.test(warning)).length, 1, mysqlWarnings.join(' | '));
    assert.match(mysqlWarnings.join(' '), /excluded/);
  } finally { await workspace.cleanup(); }
});

test('symbolic-link data directories are rejected', { skip: process.platform === 'win32' }, async () => {
  const workspace = await makeWorkspace();
  try {
    const link = path.join(workspace.sources, 'linked');
    await symlink(workspace.dataDir, link);
    assert.throws(() => validateNewApiJob(baseJob(workspace, { dataDir: link }), workspace.config), { code: 'SOURCE_SYMLINK_FORBIDDEN' });
  } finally { await workspace.cleanup(); }
});

test('MySQL and PostgreSQL command construction never leaks credentials into argv', () => {
  const args = mysqlDumpArguments('new-api');
  assert.deepEqual(args.slice(-2), ['--', 'new-api']);
  assert.ok(args.includes('--single-transaction'));
  assert.ok(args.includes('--quick'));
  assert.ok(args.includes('--skip-lock-tables'));
  assert.ok(!args.some((arg) => arg.includes('secret')));
  assert.ok(mysqlDumpArguments('new-api', { includeLogTable: false }).includes('--ignore-table=new-api.logs'));

  const cnf = mysqlOptionFile({ host: 'db', port: 3307, username: 'root', password: 'pa"ss\\word\nnext', sslMode: 'require' });
  assert.match(cnf, /^\[client\]/);
  assert.match(cnf, /password="pa\\"ss\\\\word\\nnext"/);
  assert.match(cnf, /ssl-verify-server-cert=1/);
  assert.ok(!cnf.includes('\nnext'));

  const env = pgDumpEnvironment({ host: 'pg', name: 'new-api', username: 'root', password: 'pg-secret', port: 5433, sslMode: 'require' }, { sslCa: '/certs/ca.pem' });
  assert.equal(env.PGPASSWORD, 'pg-secret');
  assert.equal(env.PGPORT, '5433');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGSSLROOTCERT, '/certs/ca.pem');
  assert.equal(pgDumpEnvironment({ host: 'pg', name: 'n', username: 'u' }).PGSSLMODE, undefined);
});

test('secrets list covers archive, main and log database passwords', () => {
  const secrets = newApiSecrets({ archive: { password: 'a' }, newapi: { database: { password: 'b' }, logDatabase: { password: 'c' } } });
  assert.deepEqual(secrets, ['a', 'b', 'c']);
  assert.deepEqual(newApiSecrets({ archive: {}, newapi: {} }), []);
});

test('prepareNewApi builds a restorable payload with a verified manifest', async () => {
  const workspace = await makeWorkspace();
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-newapi-payload-'));
  try {
    const stage = path.join(root, 'stage');
    const payload = path.join(stage, 'payload');
    await mkdir(payload, { recursive: true });
    const job = baseJob(workspace);
    validateNewApiJob(job, workspace.config);
    const run = { progress: null };
    const lines = [];
    const result = await prepareNewApi({
      job, payload, stage, stamp: '20261018T000000Z', signal: new AbortController().signal,
      secrets: newApiSecrets(job), runId: 'run-1', config: workspace.config,
      log: (_id, message) => lines.push(message),
      update: (_id, patch) => Object.assign(run, patch),
    });

    const manifest = JSON.parse(await readFile(path.join(payload, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'azurekiln-newapi-backup');
    assert.equal(manifest.mainDatabase.type, 'sqlite');
    assert.equal(manifest.mainDatabase.integrity, 'ok');
    // The database path relative to dataDir, so a restorer can spot a relocated database.
    assert.equal(manifest.mainDatabase.dataDirRelativePath, 'one-api.db');
    assert.equal(manifest.mainDatabase.logsIncluded, true);
    assert.equal(manifest.logDatabase.type, 'same');
    assert.ok(manifest.files.some((file) => file.path === 'config/env'));
    assert.ok(manifest.warnings.length > 0);
    assert.deepEqual(result.warnings, manifest.warnings);

    // Manifest must describe the real tables and row counts, and never contain a password.
    const names = manifest.mainDatabase.tables.map((table) => table.name).sort();
    assert.deepEqual(names, Object.keys(NEWAPI_TABLES).sort());
    const users = manifest.mainDatabase.tables.find((table) => table.name === 'users');
    assert.equal(users.rows, 2);
    const logs = manifest.mainDatabase.tables.find((table) => table.name === 'logs');
    assert.equal(logs.rows, 3);
    assert.match(users.sha256, /^[\da-f]{64}$/);

    const manifestText = await readFile(path.join(payload, 'manifest.json'), 'utf8');
    for (const secret of ['archive-pass', 'db-pass', 'log-pass', 'super-secret-crypto', 'super-secret-session']) {
      assert.ok(!manifestText.includes(secret), `manifest must not contain ${secret}`);
    }
    for (const line of lines) assert.ok(!line.includes('super-secret-crypto'));

    // Extraction layout: consistent snapshot, deployment config, data dir without cache/WAL.
    const files = await collectPayload(payload);
    assert.ok(files.includes('db/main.sqlite3'));
    assert.ok(files.includes('config/env'));
    assert.ok(files.includes('data/readme-data.txt'));
    assert.ok(!files.some((file) => file.includes('new-api-body-cache')), 'body cache must be excluded');
    assert.ok(!files.some((file) => file.endsWith('.db-wal')), 'WAL files must be excluded');
    assert.ok(!files.some((file) => file === 'data/one-api.db'), 'live database must not be copied as data');

    const restore = await readFile(path.join(payload, 'RESTORE.md'), 'utf8');
    assert.match(restore, /new-api 还原步骤/);
    assert.match(restore, /one-api\.db/);
    assert.match(restore, /\| logs \| 3 \|/);
    assert.ok(!restore.includes('db-pass'));

    // Snapshot must be a standalone file with no journal sibling.
    assert.equal(existsSync(path.join(payload, 'db', 'main.sqlite3')), true);
    assert.equal(existsSync(path.join(payload, 'db', 'main.sqlite3-wal')), false);
    const snapshotBytes = (await stat(path.join(payload, 'db', 'main.sqlite3'))).size;
    assert.equal(manifest.mainDatabase.exportBytes, snapshotBytes);
  } finally { await rm(root, { recursive: true, force: true }); await workspace.cleanup(); }
});

test('round trip: the real encrypted archive extracts into an identical machine', { skip: !liveSevenZip && '7-Zip is not installed' }, async () => {
  const workspace = await makeWorkspace();
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-newapi-roundtrip-'));
  try {
    const stage = path.join(root, 'stage');
    const payload = path.join(stage, 'payload');
    await mkdir(payload, { recursive: true });
    const job = baseJob(workspace);
    validateNewApiJob(job, workspace.config);
    await prepareNewApi({
      job, payload, stage, stamp: '20261018T000000Z', signal: new AbortController().signal,
      secrets: newApiSecrets(job), runId: 'run-2', config: workspace.config,
      log: () => {}, update: () => {},
    });
    const manifest = JSON.parse(await readFile(path.join(payload, 'manifest.json'), 'utf8'));

    // 1. Pack the payload into the real encrypted 7z archive a run would upload.
    const archivePath = await packArchive({ payload, archivePath: path.join(stage, 'newapi-roundtrip.7z') });
    assert.ok((await stat(archivePath)).size > 0, 'archive must be non-empty');
    // The archive must actually be encrypted: listing without the password fails.
    await assert.rejects(runProcess(sevenZipBinary, ['l', archivePath, '-y', '-bd'], { secrets: [ARCHIVE_PASSWORD] }), /exited with code|TOOL_FAILED/i);

    // 2. Extract into a brand-new empty directory, as a restorer on another machine would.
    const extracted = await unpackArchive({ archivePath, target: path.join(root, 'extracted') });
    const files = await collectPayload(extracted);
    assert.ok(files.includes('manifest.json'));
    assert.ok(files.includes('RESTORE.md'));
    assert.ok(!files.some((file) => file.includes('new-api-body-cache')), 'body cache must not be in the archive');
    assert.ok(!files.some((file) => /\.db(-wal|-shm)$/.test(file)), 'WAL/SHM must not be in the archive');

    // 3. Follow RESTORE.md: fresh data dir + the archived .env + the archived data files.
    const restored = path.join(root, 'restored');
    const restoredData = path.join(restored, 'data');
    await mkdir(restoredData, { recursive: true });
    await writeFile(path.join(restoredData, 'one-api.db'), await readFile(path.join(extracted, manifest.mainDatabase.exportFile)));
    await writeFile(path.join(restored, '.env'), await readFile(path.join(extracted, 'config/env')));
    const { cp } = await import('node:fs/promises');
    await cp(path.join(extracted, 'data'), restoredData, { recursive: true, force: true });

    // 4. Compare table by table against the manifest taken from the extracted archive.
    const digests = sqliteTableDigests(path.join(restoredData, 'one-api.db'));
    assert.deepEqual(digests.map((table) => table.name).sort(), manifest.mainDatabase.tables.map((table) => table.name).sort());
    for (const expected of manifest.mainDatabase.tables) {
      // A null digest must fail loudly instead of comparing null to null.
      assert.ok(expected.sha256, `${expected.name} must carry a content digest`);
      assert.match(expected.sha256, /^[\da-f]{64}$/);
      const actual = digests.find((table) => table.name === expected.name);
      assert.ok(actual, `${expected.name} must exist after restore`);
      assert.ok(actual.sha256, `${expected.name} must carry a content digest after restore`);
      assert.equal(actual.rows, expected.rows, `${expected.name} row count must match`);
      assert.equal(actual.sha256, expected.sha256, `${expected.name} content hash must match`);
    }

    // 5. Content spot checks: configuration, keys, consumption and audit rows all survive.
    const db = new DatabaseSync(path.join(restoredData, 'one-api.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get()['integrity_check'], 'ok');
      assert.equal(db.prepare("SELECT value FROM options WHERE key='SystemName'").get().value, '测试站点');
      assert.match(db.prepare('SELECT `key` FROM channels WHERE id=1').get().key, /sk-upstream-secret-1/);
      assert.equal(db.prepare('SELECT sum(prompt_tokens) AS total FROM logs').get().total, 1800);
      assert.equal(db.prepare('SELECT sum(completion_tokens) AS total FROM logs').get().total, 1200);
      assert.equal(db.prepare('SELECT sum(quota) AS total FROM logs').get().total, 3000);
      assert.equal(db.prepare('SELECT trade_no FROM topups WHERE id=1').get().trade_no, 'trade-中文-001');
      assert.equal(db.prepare('SELECT version FROM setups').get().version, 'v0.test');
    } finally { db.close(); }

    // 6. Files restored alongside the database, and the archived .env carries CRYPTO_SECRET verbatim.
    assert.equal(existsSync(path.join(restoredData, 'readme-data.txt')), true);
    assert.equal(existsSync(path.join(restoredData, 'new-api-body-cache')), false);
    assert.match(await readFile(path.join(restored, '.env'), 'utf8'), /CRYPTO_SECRET=super-secret-crypto/);

    // 7. A wrong password must never yield a readable archive.
    await assert.rejects(unpackArchive({ archivePath, target: path.join(root, 'wrong'), password: 'not-the-password' }), /exited with code|TOOL_FAILED/i);
    assert.equal(existsSync(path.join(root, 'wrong', 'manifest.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); await workspace.cleanup(); }
});

test('digest: WITHOUT ROWID tables still get a stable content hash', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-newapi-digest-'));
  const file = path.join(root, 'wi.db');
  const db = new DatabaseSync(file);
  try {
    // A WITHOUT ROWID table has no rowid column; ordering by it used to throw.
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');
    db.exec("INSERT INTO kv VALUES ('b','2'),('a','1'),('c','3')");
    db.exec('CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO plain VALUES (2,'two'),(1,'one')");
    // A table with no usable key at all must still hash deterministically.
    db.exec('CREATE TABLE nokey (x TEXT, y TEXT)');
    db.exec("INSERT INTO nokey VALUES ('p','q'),('r','s')");

    assert.deepEqual(digestOrderColumns(db, 'kv'), ['k']);
    assert.deepEqual(digestOrderColumns(db, 'plain'), ['id']);
    assert.deepEqual(digestOrderColumns(db, 'nokey'), ['rowid']);

    const kv = tableDigest(db, 'kv');
    assert.equal(kv.rows, 3);
    assert.match(kv.sha256, /^[\da-f]{64}$/, 'WITHOUT ROWID must produce a digest, not null');
    assert.equal(kv.orderedBy, 'k');

    // The digest must not depend on insertion order.
    db.exec("DELETE FROM kv");
    db.exec("INSERT INTO kv VALUES ('c','3'),('a','1'),('b','2')");
    assert.equal(tableDigest(db, 'kv').sha256, kv.sha256);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('digest: every sqlite table yields a non-null sha256', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-newapi-digest2-'));
  const file = path.join(root, 'all.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');
    db.exec("INSERT INTO kv VALUES ('a','1')");
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, quota INTEGER)');
    db.exec('INSERT INTO logs VALUES (1, 100)');
  } finally { db.close(); }
  try {
    const digests = sqliteTableDigests(file);
    assert.deepEqual(digests.map((table) => table.name).sort(), ['kv', 'logs']);
    for (const entry of digests) {
      assert.ok(entry.sha256, `${entry.name} must not degrade to a null digest`);
      assert.match(entry.sha256, /^[\da-f]{64}$/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scope warnings never contradict the archived logs table', async () => {
  const workspace = await makeWorkspace();
  try {
    // Shared log database + logs included: exactly one warning, saying they travel with the main DB.
    const shared = baseJob(workspace);
    validateNewApiJob(shared, workspace.config);
    const sharedWarnings = newApiScopeWarnings(shared);
    assert.equal(sharedWarnings.filter((warning) => /logs/i.test(warning)).length, 1, sharedWarnings.join(' | '));
    assert.match(sharedWarnings.join(' '), /archived together with the main database/);
    assert.ok(!sharedWarnings.some((warning) => /excluded/i.test(warning)), 'must not claim logs were excluded');

    // Separate server log database + logs included: no logs warning at all.
    const separate = baseJob(workspace);
    separate.newapi.dbType = 'postgresql';
    separate.newapi.database = { host: 'db', name: 'new-api', username: 'root' };
    separate.newapi.logDbType = 'postgresql';
    separate.newapi.logDatabase = { host: 'db', name: 'new-api-log', username: 'root' };
    validateNewApiJob(separate, workspace.config);
    assert.ok(!newApiScopeWarnings(separate).some((warning) => /logs/i.test(warning)));
  } finally { await workspace.cleanup(); }
});

test('buildRestoreDocument reflects clickhouse and excluded logs', () => {
  const document = buildRestoreDocument({
    generatedAt: '2026-10-18T00:00:00.000Z',
    appVersion: { image: 'calciumion/new-api:v0.9.9' },
    array: undefined,
    mainDatabase: { type: 'postgresql', database: 'new-api', exportFile: 'db/main.dump', logsIncluded: false, tables: [{ name: 'users', rows: 3 }] },
    logDatabase: { type: 'clickhouse', database: 'new_api_logs', exported: false },
    files: [{ path: 'config/env' }],
    warnings: ['logs table excluded'],
    archiveName: 'newapi.7z',
  });
  assert.match(document, /newapi\.7z/);
  assert.match(document, /pg_restore/);
  assert.match(document, /ClickHouse/);
  assert.match(document, /SELECT \* FROM logs FORMAT Native/);
  assert.match(document, /\*\*未包含\*\*/);
  assert.match(document, /logs table excluded/);
});

test('RESTORE.md: no empty row-count table for server dumps, concrete log commands', () => {
  // D5: a PostgreSQL/MySQL dump has no per-table row counts; the guide must not print an empty table.
  const noTables = buildRestoreDocument({
    generatedAt: '2026-10-18T00:00:00.000Z',
    appVersion: { image: 'calciumion/new-api:v0.9.9' },
    mainDatabase: { type: 'postgresql', database: 'new-api', exportFile: 'db/main.dump', logsIncluded: true, tables: [] },
    logDatabase: { type: 'postgresql', database: 'new-api-log', exportFile: 'db/log.dump' },
    files: [{ path: 'config/env' }],
    warnings: [],
  });
  assert.ok(!/\| 表 \| 行数 \|/.test(noTables), 'must not print an empty row-count table');
  assert.match(noTables, /未包含 postgresql 的逐表行数与内容哈希/);
  assert.match(noTables, /SELECT count\(\*\) AS users FROM users/);

  // D6: the log-database commands must be concrete, not angle-bracket placeholders.
  assert.ok(!/<restore-tool>/.test(noTables), 'log restore command must not use <restore-tool>');
  assert.match(noTables, /pg_restore -U <user> -d new-api-log/);

  const mysqlLog = buildRestoreDocument({
    generatedAt: '2026-10-18T00:00:00.000Z',
    appVersion: { image: 'x' },
    mainDatabase: { type: 'mysql', database: 'new-api', exportFile: 'db/main.sql', logsIncluded: true, tables: [] },
    logDatabase: { type: 'mysql', database: 'new-api-log', exportFile: 'db/log.sql' },
    files: [{ path: 'config/env' }],
    warnings: [],
  });
  assert.ok(!/<db>/.test(mysqlLog), 'must not leave a <db> placeholder');
  assert.match(mysqlLog, /CREATE DATABASE IF NOT EXISTS `new-api-log`/);
  assert.match(mysqlLog, /mysql -u<user> -p new-api-log < restore\/db\/log\.sql/);
});

test('manifest recoveryPoint is the snapshot instant, not manifest write time', async () => {
  const workspace = await makeWorkspace();
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-newapi-recovery-'));
  try {
    const stage = path.join(root, 'stage');
    const payload = path.join(stage, 'payload');
    await mkdir(payload, { recursive: true });
    const job = baseJob(workspace);
    validateNewApiJob(job, workspace.config);
    const started = Date.now();
    await prepareNewApi({
      job, payload, stage, stamp: '20261018T000000Z', signal: new AbortController().signal,
      secrets: newApiSecrets(job), runId: 'run-rp', config: workspace.config,
      log: () => {}, update: () => {},
    });
    const manifest = JSON.parse(await readFile(path.join(payload, 'manifest.json'), 'utf8'));
    // The recovery point must come from the snapshot step, and must not be later than the manifest.
    assert.equal(manifest.recoveryPoint, manifest.mainDatabase.snapshotAt);
    assert.ok(Date.parse(manifest.recoveryPoint) >= started, 'recoveryPoint must be after the run started');
    assert.ok(Date.parse(manifest.recoveryPoint) <= Date.parse(manifest.generatedAt), 'recoveryPoint must not be after generatedAt');
  } finally { await rm(root, { recursive: true, force: true }); await workspace.cleanup(); }
});
