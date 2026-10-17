import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { AppError, resolveSourcePath } from './config.mjs';
import { isExcluded } from './exclusions.mjs';
import { aborted, runProcess } from './process.mjs';

// new-api boot-time cleanup removes this directory, so it never belongs in an archive.
export const NEWAPI_DATA_EXCLUDES = ['new-api-body-cache', 'new-api-body-cache/**', '*.db-journal', '*.db-wal', '*.db-shm'];
// ClickHouse log databases cannot be exported with the relational tools we drive; the restore guide must say so.
const MANUAL_LOG_TYPES = new Set(['clickhouse']);
const SINGLE_LINE = /[\r\n\0]/;

const now = () => new Date().toISOString();

function sha256File(filePath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { signal });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileEntry(filePath, relative) {
  const info = await stat(filePath);
  return { path: relative, bytes: info.size, sha256: await sha256File(filePath) };
}

// Every credential the adapter may touch is collected here so subprocess output and errors stay clean.
export function newApiSecrets(job) {
  return [
    job.archive?.password,
    job.newapi?.database?.password,
    job.newapi?.logDatabase?.password,
  ].filter(Boolean);
}

function databaseDefaults(dbType) {
  if (dbType === 'postgresql') return 5432;
  if (dbType === 'mysql') return 3306;
  return undefined;
}

function assertDatabase(database, label, dbType) {
  const values = [database.host, database.name, database.username];
  if (values.some((value) => !value) || values.some((value) => SINGLE_LINE.test(value))) {
    throw new AppError(`${label} host, database name and username are required and must be single-line values.`, 400, 'NEWAPI_DATABASE_INVALID');
  }
  if (!['postgresql', 'mysql'].includes(dbType)) throw new AppError(`${label} must use PostgreSQL or MySQL when it is not SQLite.`, 400, 'NEWAPI_DATABASE_INVALID');
}

/**
 * Validate a newapi task: path sandboxing, database parameters and the mandatory encrypted 7z archive.
 * Paths are resolved in place so the stored task always holds canonical absolute paths.
 */
export function validateNewApiJob(job, config, { allowMissing = false } = {}) {
  const api = job.newapi;
  const source = resolveSourcePath(config, api.dataDir || job.sourcePath, { directory: true, allowMissing });
  api.dataDir = source;
  // job.sourcePath must mirror dataDir: the jobs list derives its "source" column and the
  // "group by source parent" bucket from sourcePath for non-system tasks.
  job.sourcePath = source;
  const sqliteDefault = path.join(source, 'one-api.db');
  if (api.dbType === 'sqlite') {
    api.sqlitePath = api.sqlitePath ? resolveSourcePath(config, api.sqlitePath, { allowMissing: true }) : sqliteDefault;
  } else {
    assertDatabase(api.database, 'The new-api database', api.dbType);
    api.database.port ??= databaseDefaults(api.dbType);
    for (const key of ['sslCa', 'sslCert', 'sslKey']) if (api.database[key]) api.database[key] = resolveSourcePath(config, api.database[key], { allowMissing });
  }
  if (api.logDbType !== 'same') {
    if (api.logDbType === 'sqlite') {
      api.logSqlitePath = resolveSourcePath(config, api.logSqlitePath || path.join(source, 'one-api-log.db'), { allowMissing: true });
    } else if (MANUAL_LOG_TYPES.has(api.logDbType)) {
      if (!api.logDatabase.name || SINGLE_LINE.test(api.logDatabase.name)) throw new AppError('The ClickHouse log database name is required.', 400, 'NEWAPI_LOG_DATABASE_INVALID');
      for (const key of ['host', 'name', 'username']) if (api.logDatabase[key] && SINGLE_LINE.test(api.logDatabase[key])) throw new AppError('The log database values must be single-line.', 400, 'NEWAPI_LOG_DATABASE_INVALID');
      if (api.logDatabase.host) api.logDatabase.port ??= 8123;
    } else {
      assertDatabase(api.logDatabase, 'The log database', api.logDbType);
      api.logDatabase.port ??= databaseDefaults(api.logDbType);
      for (const key of ['sslCa', 'sslCert', 'sslKey']) if (api.logDatabase[key]) api.logDatabase[key] = resolveSourcePath(config, api.logDatabase[key], { allowMissing });
    }
  }
  if (!api.envFilePath) throw new AppError('Select the new-api .env file; the archive cannot be restored without it.', 400, 'NEWAPI_ENV_REQUIRED');
  api.envFilePath = resolveSourcePath(config, api.envFilePath, { allowMissing });
  api.composeFilePath = api.composeFilePath ? resolveSourcePath(config, api.composeFilePath, { allowMissing }) : '';
  api.serviceFilePath = api.serviceFilePath ? resolveSourcePath(config, api.serviceFilePath, { allowMissing }) : '';
  api.proxyConfigPath = api.proxyConfigPath ? resolveSourcePath(config, api.proxyConfigPath, { allowMissing }) : '';
  api.pluginsPath = api.pluginsPath ? resolveSourcePath(config, api.pluginsPath, { directory: true, allowMissing }) : '';
  if (api.includeLogs) {
    if (!api.logsPath) throw new AppError('Select the new-api log directory before including process logs.', 400, 'NEWAPI_LOGS_PATH_REQUIRED');
    api.logsPath = resolveSourcePath(config, api.logsPath, { directory: true, allowMissing });
  } else api.logsPath = '';
  job.watch.enabled = false;
  // The archive carries .env and channel keys, so plaintext formats are never acceptable.
  if (job.archive.format !== '7z' || !job.archive.encrypted) throw new AppError('new-api backups contain credentials and must use an encrypted 7z archive.', 400, 'NEWAPI_ARCHIVE_REQUIRED');
  return job;
}

/** Warnings a run should carry because of a deliberately degraded scope. */
export function newApiScopeWarnings(job) {
  const warnings = [];
  const api = job.newapi;
  if (MANUAL_LOG_TYPES.has(api.logDbType)) warnings.push(`The ${api.logDbType} log database is not exported automatically; RESTORE.md contains the manual export command.`);
  if (!api.includeLogTable) warnings.push('The logs table is excluded; consumption and token history will be missing after restore.');
  if (api.logDbType === 'same') warnings.push('LOG_SQL_DSN is unset, so log tables are archived together with the main database.');
  return warnings;
}

// List real tables from the live database instead of hard-coding a schema snapshot that drifts between releases.
function listTables(database, dialect) {
  const query = dialect === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() OR table_schema = current_schema() ORDER BY table_name";
  return database.prepare(query).all().map((row) => row.name);
}

/** Stable per-table digest: row count plus a hash over primary-key-ordered rows. */
export function tableDigest(database, table) {
  const count = database.prepare(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`).get().count;
  const rows = database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all();
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(Object.values(row)));
  return { name: table, rows: Number(count), sha256: hash.digest('hex') };
}

export function sqliteTableDigests(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 10000 });
  try {
    const tables = listTables(database, 'sqlite');
    return tables.map((table) => {
      try { return tableDigest(database, table); }
      catch { const count = database.prepare(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`).get().count; return { name: table, rows: Number(count), sha256: null }; }
    });
  } finally { database.close(); }
}

// SQLite must be snapshotted through the online backup API: copying a live WAL database loses committed pages.
async function snapshotSqlite(sourcePath, targetPath, { signal, onProgress } = {}) {
  const database = new DatabaseSync(sourcePath, { readOnly: true, timeout: 10000 });
  try {
    await sqliteBackup(database, targetPath, { rate: 128, progress({ totalPages, remainingPages }) {
      if (signal?.aborted) throw aborted();
      onProgress?.(totalPages > 0 ? Math.max(0, Math.min(99, Math.floor((totalPages - remainingPages) / totalPages * 100))) : undefined);
    } });
  } finally { database.close(); }
  const snapshot = new DatabaseSync(targetPath);
  try {
    snapshot.exec('PRAGMA journal_mode=DELETE');
    const check = snapshot.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('new-api SQLite snapshot failed its integrity check');
  } finally { snapshot.close(); }
}

/** MySQL dump arguments. The database name always follows `--` so it can never be read as a flag. */
export function mysqlDumpArguments(databaseName, { includeLogTable = true } = {}) {
  const args = ['--single-transaction', '--quick', '--skip-lock-tables', '--routines', '--events', '--triggers', '--databases'];
  if (!includeLogTable) args.push(`--ignore-table=${databaseName}.logs`);
  return [...args, '--', databaseName];
}

/** PostgreSQL environment for pg_dump; the password travels in the environment, never in argv. */
export function pgDumpEnvironment(database, tlsPaths = {}) {
  const env = {
    PGHOST: database.host,
    PGPORT: String(database.port ?? 5432),
    PGUSER: database.username,
    PGPASSWORD: database.password ?? '',
    PGDATABASE: database.name,
    PGSSLMODE: database.sslMode === 'default' ? undefined : database.sslMode,
    PGSSLROOTCERT: tlsPaths.sslCa,
    PGSSLCERT: tlsPaths.sslCert,
    PGSSLKEY: tlsPaths.sslKey,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
}

// Double-quote a my.cnf value so passwords with quotes/backslashes cannot break the file or inject options.
export function mysqlOptionFile({ host, port, username, password, sslMode, tlsPaths = {} }) {
  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  const lines = ['[client]', `host=${quote(host)}`, `port=${port ?? 3306}`, `user=${quote(username)}`, `password=${quote(password ?? '')}`];
  if (sslMode && sslMode !== 'default') lines.push(`ssl=${sslMode === 'disable' ? '0' : '1'}`);
  if (['require', 'verify-ca', 'verify-full'].includes(sslMode)) lines.push('ssl-verify-server-cert=1');
  for (const [key, option] of [['sslCa', 'ssl-ca'], ['sslCert', 'ssl-cert'], ['sslKey', 'ssl-key']]) if (tlsPaths[key]) lines.push(`${option}=${quote(tlsPaths[key])}`);
  return `${lines.join('\n')}\n`;
}

async function dumpRemoteDatabase({ database, dbType, artifact, stamp, paths, signal, secrets, runId, log, runTool, config, includeLogTable, label }) {
  const extension = dbType === 'postgresql' ? 'dump' : 'sql';
  const file = path.join(paths.payload, `db.${label}.${stamp}.${extension}`);
  log(runId, `Exporting ${label} ${dbType} database`, 'info', secrets);
  if (dbType === 'postgresql') {
    await runTool(config.pgDumpBinary, ['--format=custom', '--no-password', '--file', file], {
      env: pgDumpEnvironment(database, paths.tls), signal, secrets, onLine: (line) => log(runId, line, 'info', secrets),
    });
  } else {
    const credentialFile = path.join(paths.stage, `mysql-${label}.cnf`);
    await writeFile(credentialFile, mysqlOptionFile({ ...database, tlsPaths: paths.tls }), { mode: 0o600 });
    const output = await open(file, 'w', 0o600);
    try {
      await runTool(config.mysqlDumpBinary, [`--defaults-extra-file=${credentialFile}`, ...mysqlDumpArguments(database.name, { includeLogTable })], {
        signal, secrets, stdoutFile: output.fd, onLine: (line) => log(runId, line, 'info', secrets),
      });
    } finally { await output.close(); await rm(credentialFile, { force: true }); }
  }
  if (!(await stat(file)).size) throw new Error(`The ${label} database export produced an empty file`);
  await chmod(file, 0o600);
  return { file, extension };
}

/** RESTORE.md is generated from the manifest so the instructions always match the archived scope. */
export function buildRestoreDocument(manifest) {
  const main = manifest.mainDatabase;
  const log = manifest.logDatabase;
  const lines = [
    '# new-api 还原步骤',
    '',
    `- 生成时间:${manifest.generatedAt}`,
    `- 归档版本:${manifest.appVersion?.image ?? 'unknown'}`,
    `- 主库:${main.type} / ${main.database || '(sqlite file)'}`,
    `- 日志库:${log.type === 'same' ? '与主库相同' : `${log.type} / ${log.database || '(sqlite file)'}`}`,
    `- logs 表:${main.logsIncluded ? '已包含' : '**未包含**(消耗与 tokens 历史缺失)'}`,
    '',
    '> 必须使用与「归档版本」相同的 new-api 镜像启动,否则首次启动的 AutoMigrate 会改写表结构。',
    '> `.env` 必须使用归档内的原值,不要修改 `CRYPTO_SECRET` / `SESSION_SECRET`,否则已加密数据无法解密。',
    '',
    '## 1. 解压',
    '',
    '```',
    `7z x ${manifest.archiveName ?? '<archive>.7z'} -o ./restore`,
    '```',
    '',
    '## 2. 放回部署配置',
    '',
    '```',
    'cp restore/config/env            ./new-api/.env',
    ...(manifest.files.some((file) => file.path === 'config/compose.yaml') ? ['cp restore/config/compose.yaml ./new-api/docker-compose.yml'] : []),
    ...(manifest.files.some((file) => file.path === 'config/service.unit') ? ['cp restore/config/service.unit  /etc/systemd/system/new-api.service'] : []),
    '```',
    '',
    '## 3. 恢复数据库',
    '',
  ];
  if (main.type === 'sqlite') {
    lines.push(
      '```',
      'mkdir -p ./new-api/data',
      `cp restore/${main.exportFile} ./new-api/data/one-api.db`,
      '```',
      '',
      '不要复制任何 `-wal` / `-shm` 文件:快照已经是单文件自洽的。',
    );
  } else if (main.type === 'postgresql') {
    lines.push(
      '```',
      `docker compose exec -T postgres psql -U <user> -d postgres -c 'CREATE DATABASE "${main.database}";'`,
      `docker compose exec -T postgres pg_restore -U <user> -d ${main.database} --clean --if-exists --no-owner - < restore/${main.exportFile}`,
      '```',
    );
  } else {
    lines.push(
      '```',
      `docker compose exec -T mysql mysql -u<user> -p -e 'CREATE DATABASE IF NOT EXISTS \`${main.database}\`;'`,
      `docker compose exec -T mysql mysql -u<user> -p < restore/${main.exportFile}`,
      '```',
    );
  }
  if (log.type !== 'same') {
    lines.push('', '### 日志库', '');
    if (log.type === 'clickhouse') {
      lines.push('ClickHouse 日志库**未自动导出**,请手工执行:', '', '```sql', 'SELECT * FROM logs FORMAT Native > logs.native', '```');
    } else if (log.type === 'sqlite') {
      lines.push('```', `cp restore/${log.exportFile} ./new-api/data/one-api-log.db`, '```', '', '`LOG_SQL_DSN` 必须指向该文件。');
    } else {
      lines.push('```', `docker compose exec -T <db> <restore-tool> restore/${log.exportFile} ${log.database}`, '```');
    }
  }
  lines.push(
    '',
    '## 4. 恢复可选目录',
    '',
    '```',
    ...(manifest.files.some((file) => file.path.startsWith('logs')) ? ['cp -r restore/logs/* ./new-api/logs/'] : []),
    ...(manifest.files.some((file) => file.path.startsWith('plugins')) ? ['cp -r restore/plugins/* ./plugins/'] : []),
    '```',
    '',
    '## 5. 启动并校验',
    '',
    '```',
    'docker compose up -d',
    'docker compose logs -f new-api',
    '```',
    '',
    '逐表行数必须与下列清单一致(在库内执行 `SELECT count(*) FROM "<表名>"`):',
    '',
    '| 表 | 行数 |',
    '| --- | --- |',
    ...main.tables.map((table) => `| ${table.name} | ${table.rows} |`),
    '',
    ...(manifest.warnings.length ? ['## 告警', '', ...manifest.warnings.map((warning) => `- ${warning}`), ''] : []),
  );
  return lines.join('\n');
}

/**
 * Build the new-api payload: consistent snapshots, deployment config, data directory and a manifest
 * describing exactly what was archived so a restore can be verified table by table.
 */
export async function prepareNewApi({ job, payload, stage, stamp, signal, secrets, runId, config, log, update, runTool = runProcess }) {
  const api = job.newapi;
  const dataDir = await resolveSourcePath(config, api.dataDir, { directory: true });
  const dbDir = path.join(payload, 'db');
  const configDir = path.join(payload, 'config');
  await mkdir(dbDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const paths = { payload, stage, tls: {} };
  const warnings = [...newApiScopeWarnings(job)];
  const files = [];
  const mainDatabase = {};

  // 1. Main database.
  update(runId, { progress: { step: '导出 new-api 主库', updatedAt: now() } });
  if (api.dbType === 'sqlite') {
    const source = await resolveSourcePath(config, api.sqlitePath);
    const target = path.join(dbDir, 'main.sqlite3');
    await snapshotSqlite(source, target, { signal, onProgress: (percent) => update(runId, { progress: { step: '导出 new-api 主库', percent, updatedAt: now() } }) });
    log(runId, 'Created an online SQLite snapshot of the new-api main database', 'info', secrets);
    mainDatabase.type = 'sqlite';
    mainDatabase.database = path.basename(source);
    mainDatabase.exportFile = 'db/main.sqlite3';
    mainDatabase.tables = sqliteTableDigests(target);
    mainDatabase.integrity = 'ok';
  } else {
    for (const key of ['sslCa', 'sslCert', 'sslKey']) if (api.database[key]) paths.tls[key] = api.database[key];
    const dumped = await dumpRemoteDatabase({ database: api.database, dbType: api.dbType, stamp, paths, signal, secrets, runId, log, runTool, config, includeLogTable: api.includeLogTable, label: 'main' });
    await chmod(dumped.file, 0o600);
    mainDatabase.type = api.dbType;
    mainDatabase.database = api.database.name;
    mainDatabase.exportFile = `db/main.${dumped.extension}`;
    mainDatabase.tables = [];
  }
  mainDatabase.logsIncluded = api.includeLogTable;
  const mainFile = path.join(payload, mainDatabase.exportFile);
  files.push(await fileEntry(mainFile, mainDatabase.exportFile));
  mainDatabase.exportBytes = files.at(-1).bytes;
  mainDatabase.exportSha256 = files.at(-1).sha256;

  // 2. Log database (only when it is not the main one).
  let logDatabase = { type: 'same' };
  if (api.logDbType !== 'same' && api.logDbType !== 'clickhouse') {
    update(runId, { progress: { step: '导出 new-api 日志库', updatedAt: now() } });
    const logTls = {};
    for (const key of ['sslCa', 'sslCert', 'sslKey']) if (api.logDatabase[key]) logTls[key] = api.logDatabase[key];
    if (api.logDbType === 'sqlite') {
      const source = await resolveSourcePath(config, api.logSqlitePath);
      const target = path.join(dbDir, 'log.sqlite3');
      await snapshotSqlite(source, target, { signal });
      logDatabase = { type: 'sqlite', database: path.basename(source), exportFile: 'db/log.sqlite3', tables: sqliteTableDigests(target) };
    } else {
      const dumped = await dumpRemoteDatabase({ database: api.logDatabase, dbType: api.logDbType, stamp, paths: { ...paths, tls: logTls }, signal, secrets, runId, log, runTool, config, includeLogTable: true, label: 'log' });
      logDatabase = { type: api.logDbType, database: api.logDatabase.name, exportFile: `db/log.${dumped.extension}`, tables: [] };
    }
    const logFile = path.join(payload, logDatabase.exportFile);
    files.push(await fileEntry(logFile, logDatabase.exportFile));
    logDatabase.exportBytes = files.at(-1).bytes;
    logDatabase.exportSha256 = files.at(-1).sha256;
  } else if (api.logDbType === 'clickhouse') {
    logDatabase = { type: 'clickhouse', database: api.logDatabase.name, exported: false, reason: 'manual export required' };
    log(runId, 'ClickHouse log database is not exported automatically; RESTORE.md contains the manual command', 'warn', secrets);
  }

  // 3. Deployment configuration. .env is mandatory; the rest is optional.
  update(runId, { progress: { step: '收集部署配置', updatedAt: now() } });
  const envTarget = path.join(configDir, 'env');
  await copyFile(api.envFilePath, envTarget);
  await chmod(envTarget, 0o600);
  files.push(await fileEntry(envTarget, 'config/env'));
  for (const [field, name] of [['composeFilePath', 'compose.yaml'], ['serviceFilePath', 'service.unit']]) {
    if (!api[field]) continue;
    const target = path.join(configDir, name);
    await copyFile(api[field], target);
    await chmod(target, 0o600);
    files.push(await fileEntry(target, `config/${name}`));
  }
  if (api.proxyConfigPath) {
    const info = await lstat(api.proxyConfigPath);
    const proxyDir = path.join(payload, 'proxy');
    await mkdir(proxyDir, { recursive: true, mode: 0o700 });
    if (info.isDirectory()) {
      for (const entry of await readdir(proxyDir).catch(() => [])) void entry;
      const entries = await readdir(api.proxyConfigPath);
      for (const entry of entries) {
        const source = path.join(api.proxyConfigPath, entry);
        const info2 = await lstat(source);
        if (!info2.isFile()) continue;
        await copyFile(source, path.join(proxyDir, entry));
        files.push(await fileEntry(path.join(proxyDir, entry), `proxy/${entry}`));
      }
    } else {
      const name = path.basename(api.proxyConfigPath);
      await copyFile(api.proxyConfigPath, path.join(proxyDir, name));
      files.push(await fileEntry(path.join(proxyDir, name), `proxy/${name}`));
    }
  }

  // 4. Data directory (cache, journals and the live database files are excluded).
  update(runId, { progress: { step: '打包 new-api 数据目录', updatedAt: now() } });
  const dataTarget = path.join(payload, 'data');
  await mkdir(dataTarget, { recursive: true, mode: 0o700 });
  const dataEntries = (await readdir(dataDir)).filter((name) => !isExcluded(name, NEWAPI_DATA_EXCLUDES));
  if (dataEntries.length) {
    await runTool(config.tarBinary ?? 'tar', ['-cf', path.join(payload, `data.${stamp}.tar`), '-C', dataDir, '--', ...dataEntries], { signal, secrets, onLine: (line) => log(runId, line, 'info', secrets) });
    await runTool(config.tarBinary ?? 'tar', ['-xf', path.join(payload, `data.${stamp}.tar`), '-C', dataTarget], { signal, secrets });
    await rm(path.join(payload, `data.${stamp}.tar`), { force: true });
    // Never ship a stale database copy next to the consistent snapshot.
    for (const name of await readdir(dataTarget)) if (/\.db(-wal|-shm|-journal)?$/.test(name) || name === 'one-api.db') await rm(path.join(dataTarget, name), { force: true });
  }

  // 5. Optional process logs and plugin scripts.
  if (api.includeLogs && api.logsPath) {
    const logTarget = path.join(payload, 'logs');
    await mkdir(logTarget, { recursive: true, mode: 0o700 });
    await runTool(config.tarBinary ?? 'tar', ['-cf', path.join(payload, `logs.${stamp}.tar`), '-C', api.logsPath, '.'], { signal, secrets });
    await runTool(config.tarBinary ?? 'tar', ['-xf', path.join(payload, `logs.${stamp}.tar`), '-C', logTarget], { signal, secrets });
    await rm(path.join(payload, `logs.${stamp}.tar`), { force: true });
  }
  if (api.pluginsPath) {
    const pluginTarget = path.join(payload, 'plugins');
    await mkdir(pluginTarget, { recursive: true, mode: 0o700 });
    await runTool(config.tarBinary ?? 'tar', ['-cf', path.join(payload, `plugins.${stamp}.tar`), '-C', api.pluginsPath, '.'], { signal, secrets });
    await runTool(config.tarBinary ?? 'tar', ['-xf', path.join(payload, `plugins.${stamp}.tar`), '-C', pluginTarget], { signal, secrets });
    await rm(path.join(payload, `plugins.${stamp}.tar`), { force: true });
  }

  // 6. Manifest + restore guide.
  const manifest = {
    kind: 'azurekiln-newapi-backup',
    manifestVersion: 1,
    generatedAt: now(),
    recoveryPoint: now(),
    restoreInstructions: 'RESTORE.md',
    mainDatabase,
    logDatabase,
    files,
    appVersion: { image: api.appVersion || 'unknown' },
    excluded: ['source', 'docker-image', 'tiktoken_cache', 'new-api-body-cache', ...(api.includeLogs ? [] : ['logs'])],
    warnings,
  };
  await writeFile(path.join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(path.join(payload, 'RESTORE.md'), buildRestoreDocument({ ...manifest, archiveName: undefined }), { mode: 0o600 });
  return { manifest, warnings };
}

export const __testing = { listTables, sha256File };
