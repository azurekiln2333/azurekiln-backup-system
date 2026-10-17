import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { AppError, isWithin, resolveSourcePath } from './config.mjs';
import { isExcluded } from './exclusions.mjs';
import { aborted, probe, redact, runProcess } from './process.mjs';
import { newApiSecrets, prepareNewApi } from './newapi.mjs';
import { normalizeRemotePath } from './rclone.mjs';

const finished = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const ownedId = /^[a-zA-Z0-9_-]+$/;
const now = () => new Date().toISOString();

export async function sendNotificationEmail(settings, { subject, text, to }) {
  const smtp = settings.smtp;
  if (!smtp.enabled) return { disabled: true };
  if (!smtp.host || !smtp.from || !(to || smtp.to.length)) throw new Error('SMTP host, sender and recipient are required');
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.mode === 'tls',
    requireTLS: smtp.mode === 'starttls', ignoreTLS: smtp.mode === 'none',
    auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  try {
    await transport.sendMail({ from: smtp.from, to: to || smtp.to.join(', '), subject, text });
    return { sent: true };
  } finally { transport.close(); }
}

export function archiveArguments(archive, outputPath) {
  if (archive.encrypted && !archive.password) throw new Error('An archive password is required when encryption is enabled');
  if (archive.encrypted && archive.format === 'tar.gz') throw new Error('tar.gz cannot provide password encryption; use 7z or ZIP');
  const args = ['a', archive.format === 'zip' ? '-tzip' : '-t7z', `-mx=${archive.level}`, '-y', '-bsp2'];
  if (archive.format === '7z') {
    const method = archive.method ?? 'lzma2';
    const threads = archive.threads ?? 0;
    const dictionaryMiB = archive.dictionaryMiB ?? 0;
    if (!['lzma2', 'lzma'].includes(method) || !Number.isInteger(threads) || threads < 0 || threads > 8
      || ![0, 8, 16, 32, 64, 128, 256].includes(dictionaryMiB)) throw new Error('Invalid 7z compression settings');
    if (archive.level > 0) {
      args.push(`-m0=${method === 'lzma2' ? 'LZMA2' : 'LZMA'}`);
      if (threads || archive.level >= 7) args.push(`-mmt=${threads || 1}`);
      if (dictionaryMiB || archive.level >= 7) args.push(`-md=${dictionaryMiB || 32}m`);
    }
  }
  if (archive.encrypted) {
    args.push(`-p${archive.password}`);
    args.push(archive.format === 'zip' ? '-mem=AES256' : '-mhe=on');
  }
  return [...args, outputPath, '.'];
}

export async function fileHashes(filePath, { signal } = {}) {
  const hashes = { SHA256: createHash('sha256'), SHA1: createHash('sha1'), MD5: createHash('md5') };
  for await (const chunk of createReadStream(filePath, { signal })) for (const hash of Object.values(hashes)) hash.update(chunk);
  return Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [key, hash.digest('hex')]));
}

export function verifyRemote(localSize, hashes, remote) {
  if (remote.size !== localSize) throw new Error(`Remote size mismatch: expected ${localSize}, received ${remote.size}`);
  for (const algorithm of ['SHA256', 'SHA1', 'MD5']) {
    const remoteHash = Object.entries(remote.hashes ?? {}).find(([name, value]) => value && name.replace(/-/g, '').toUpperCase() === algorithm)?.[1];
    if (remoteHash) {
      if (remoteHash.toLowerCase() !== hashes[algorithm].toLowerCase()) throw new Error(`Remote ${algorithm} checksum mismatch`);
      return `size+${algorithm}`;
    }
  }
  return 'size (remote checksum unavailable)';
}

export function parseArchivePercent(line) {
  const normalized = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
  const match = /(?:^|[\s:])(\d{1,3})%(?=\s|$)/.exec(normalized);
  const value = match ? Number(match[1]) : null;
  return value !== null && value <= 100 ? value : null;
}

// Compare two snapshots ({relativePath: [size, mtimeMs] | ['link', target]}); excluded paths never count as deleted.
export function diffSnapshot(previous, current, excludes = []) {
  const added = [], modified = [], deleted = [];
  for (const [name, value] of Object.entries(current)) {
    const old = previous[name];
    if (!old) added.push(name);
    else if (old[0] !== value[0] || old[1] !== value[1]) modified.push(name);
  }
  for (const name of Object.keys(previous)) if (!(name in current) && !isExcluded(name, excludes)) deleted.push(name);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function renderArchiveComponent(template, jobName, datetime) {
  const task = jobName.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[ ._-]+|[ ._-]+$/g, '').slice(0, 100) || 'backup';
  const rendered = template.replace(/\{datetime\}/g, datetime).replace(/\{task\}/g, task).replace(/^[. ]+|[. ]+$/g, '');
  if (!rendered || rendered === '.' || rendered === '..') throw new Error('Archive name template produced an invalid name');
  return rendered;
}

export function createBackupService({ store, config, rclone, runTool = runProcess }) {
  const queue = [];
  const queuedJobs = new Map();
  const controllers = new Map();
  const downloadPaths = new Map();
  const downloadOperations = new Map();
  let downloadAdmission = Promise.resolve();
  let draining = false, stopped = false, activePromise = Promise.resolve();
  let housekeeping;

  const listAllRuns = () => {
    const result = [];
    for (let offset = 0; ; offset += 500) {
      const page = store.listRuns({ limit: 500, offset });
      result.push(...page.items);
      if (result.length >= page.total || !page.items.length) return result;
    }
  };
  const update = (id, patch) => store.updateRun(id, patch);
  const phase = (id, value) => update(id, { phase: value, progress: null });
  const secretsFor = (job) => [job.archive.password, job.vaultwarden.database.password, ...newApiSecrets(job), store.getSettings({ includeSecrets: true }).smtp.password, store.getSettings({ includeSecrets: true }).rclone.configPassword].filter(Boolean);
  const log = (id, message, level = 'info', secrets = []) => store.appendLog(id, { level, message: redact(message, secrets) });
  const stagePath = (jobId, runId) => {
    if (!ownedId.test(jobId) || !ownedId.test(runId)) throw new Error('Invalid internal backup identifier');
    return path.join(config.tempDir, jobId, runId);
  };
  async function treeSize(directory, ignoredPaths = new Set()) {
    let bytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
      const entryPath = path.join(directory, entry.name);
      if (ignoredPaths.has(entryPath)) continue;
      const info = await lstat(entryPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) bytes += await treeSize(entryPath, ignoredPaths);
      else bytes += info.size;
    }
    return bytes;
  }
  async function allocatedDownloads() {
    let total = 0;
    for (const [directory, reserved] of downloadPaths) total += Math.max(reserved, await treeSize(directory));
    return total;
  }
  async function allocatedTempBytes() {
    return await treeSize(config.tempDir, new Set(downloadPaths.keys())) + await allocatedDownloads();
  }
  async function sweep(excludePath) {
    await mkdir(config.tempDir, { recursive: true, mode: 0o700 });
    const storage = store.getSettings().storage;
    const folders = [];
    let retainedBytes = 0;
    for (const jobEntry of await readdir(config.tempDir, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!jobEntry.isDirectory() || !ownedId.test(jobEntry.name)) continue;
      const jobDir = path.join(config.tempDir, jobEntry.name);
      const runs = [];
      for (const runEntry of await readdir(jobDir, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!runEntry.isDirectory() || !ownedId.test(runEntry.name)) continue;
        const runDir = path.join(jobDir, runEntry.name);
        if (runDir === excludePath || downloadPaths.has(runDir)) continue;
        const run = store.getRun(runEntry.name);
        if (run && !finished.has(run.status)) continue;
        const info = await stat(runDir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) continue;
        if (run?.status === 'succeeded' && run.cleanupStatus === 'retained') {
          retainedBytes += await treeSize(runDir);
          continue;
        }
        runs.push({ path: runDir, runId: runEntry.name, time: info.mtimeMs, bytes: await treeSize(runDir) });
      }
      runs.sort((a, b) => b.time - a.time);
      for (let index = 0; index < runs.length; index++) {
        const run = runs[index];
        if (index > 0 || Date.now() - run.time >= storage.failedRetentionHours * 3600000) {
          await rm(run.path, { recursive: true, force: true });
          if (store.getRun(run.runId)) update(run.runId, { cleanupStatus: 'cleaned' });
        } else folders.push(run);
      }
    }
    folders.sort((a, b) => a.time - b.time);
    let total = retainedBytes + folders.reduce((sum, item) => sum + item.bytes, 0) + (excludePath ? await treeSize(excludePath) : 0) + await allocatedDownloads();
    for (const folder of folders) {
      if (total <= storage.maxTempBytes) break;
      await rm(folder.path, { recursive: true, force: true });
      total -= folder.bytes;
      if (store.getRun(folder.runId)) update(folder.runId, { cleanupStatus: 'cleaned' });
    }
    if (total > storage.maxTempBytes) throw new Error('Backup temporary storage limit exceeded');
  }
  // Optional `entries` collects the incremental snapshot keyed by '/'-separated relative path.
  async function validateTree(source, signal, root = source, excludes = [], entries = null) {
    let bytes = 0;
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (signal?.aborted) throw aborted();
      const item = path.join(source, entry.name);
      const relative = path.relative(root, item);
      if (isExcluded(relative, excludes)) continue;
      const info = await lstat(item);
      if (info.isSymbolicLink()) {
        const resolved = await realpath(item);
        await resolveSourcePath(config, resolved);
        if (!isWithin(root, resolved)) throw new Error('Source contains a symlink that escapes its directory');
        if (entries) entries[relative.split(path.sep).join('/')] = ['link', path.relative(root, resolved).split(path.sep).join('/')];
      } else if (info.isDirectory()) bytes += await validateTree(item, signal, root, excludes, entries);
      else if (info.isFile()) {
        bytes += info.size;
        if (entries) entries[relative.split(path.sep).join('/')] = [info.size, info.mtimeMs];
      } else throw new Error('Backup source contains an unsupported special file');
    }
    return bytes;
  }
  async function tarIncremental(source, stage, output, names, signal, secrets, runId) {
    const present = [];
    for (const name of names) {
      // A file removed after preflight is recorded by the next diff; tar would fail on it now.
      if (await lstat(path.join(source, ...name.split('/'))).catch(() => null)) present.push(name);
      else log(runId, `Changed file disappeared before packaging: ${name}`, 'warn', secrets);
    }
    if (!present.length) throw new Error('Every changed file disappeared before packaging');
    const listPath = path.join(stage, 'incremental-files.list');
    await writeFile(listPath, present.map((name) => `./${name}\0`).join(''), { mode: 0o600 });
    try {
      await runTool(config.tarBinary ?? 'tar', ['-cf', output, '-C', source, '--null', '-T', listPath], { signal, secrets, onLine: (line) => log(runId, line, 'info', secrets) });
    } finally { await rm(listPath, { force: true }); }
    return present;
  }
  async function ensureWatchBaseline(jobId, { isDirty = () => false } = {}) {
    const job = store.getJob(jobId);
    if (!job || job.type !== 'directory' || job.watch?.mode !== 'incremental') return { created: false };
    if (store.getWatchBaseline(jobId, job.sourcePath)) return { created: false };
    const source = await resolveSourcePath(config, job.sourcePath, { directory: true });
    const entries = {};
    await validateTree(source, null, source, job.excludes ?? [], entries);
    // Paths touched while the capture ran are left out, so the first watch run still backs them up.
    for (const name of Object.keys(entries)) if (isDirty(name)) delete entries[name];
    return { created: store.saveWatchBaseline(jobId, job.sourcePath, entries, { onlyIfMissing: true }) };
  }
  async function tarDirectory(source, output, excludes, signal, secrets, runId) {
    const resolved = await resolveSourcePath(config, source, { directory: true });
    await validateTree(resolved, signal, resolved, excludes);
    await runTool(config.tarBinary ?? 'tar', ['-cf', output, ...excludes.map((value) => `--exclude=${value}`), '-C', resolved, '.'], { signal, secrets, onLine: (line) => log(runId, line, 'info', secrets) });
  }
  async function prepareSystemConfig(payload, signal, runId, backup) {
    const statePath = path.join(payload, 'state.sqlite');
    const database = new DatabaseSync(path.join(config.dataDir, 'state.sqlite'), { readOnly: true, timeout: 10000 });
    try {
      let lastProgressAt = 0;
      update(runId, { progress: { step: '复制系统配置数据库', updatedAt: now() } });
      await sqliteBackup(database, statePath, { rate: 64, progress({ totalPages, remainingPages }) {
        if (signal.aborted) throw aborted();
        const current = Date.now();
        if (remainingPages > 0 && current - lastProgressAt < 750) return;
        lastProgressAt = current;
        update(runId, { progress: {
          step: '复制系统配置数据库', updatedAt: now(),
          ...(totalPages > 0 ? { percent: Math.max(0, Math.min(99, Math.floor((totalPages - remainingPages) / totalPages * 100))) } : {}),
        } });
      } });
    } finally { database.close(); }
    update(runId, { progress: { step: '校验系统配置快照', updatedAt: now() } });
    const snapshot = new DatabaseSync(statePath);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
      const checks = snapshot.prepare('PRAGMA integrity_check').all();
      if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('System configuration snapshot failed its integrity check');
    } finally { snapshot.close(); }
    if (config.masterKey) {
      const key = /^[\da-f]{64}$/i.test(config.masterKey) ? Buffer.from(config.masterKey, 'hex') : Buffer.from(config.masterKey, 'base64');
      if (key.length !== 32) throw new Error('Backup master key must contain exactly 32 bytes');
      await writeFile(path.join(payload, 'secret.key'), key, { mode: 0o600 });
    } else await copyFile(config.masterKeyPath, path.join(payload, 'secret.key'));
    await copyFile(config.rcloneConfigPath, path.join(payload, 'rclone.conf'));
    const files = ['state.sqlite', 'secret.key', 'rclone.conf'];
    if (config.systemEnvPath) {
      await copyFile(config.systemEnvPath, path.join(payload, 'deployment.env'));
      files.push('deployment.env');
    }
    if (config.systemComposePath) {
      await copyFile(config.systemComposePath, path.join(payload, 'deployment-compose.yaml'));
      files.push('deployment-compose.yaml');
    }
    const entries = {};
    for (const name of files) {
      const filePath = path.join(payload, name);
      entries[name] = { size: (await stat(filePath)).size, sha256: (await fileHashes(filePath, { signal })).SHA256 };
    }
    await writeFile(path.join(payload, 'system.json'), JSON.stringify({ kind: 'azurekiln-system-config', version: 1, createdAt: now(), files: entries, backup }, null, 2), { mode: 0o600 });
    log(runId, 'Created an online system configuration snapshot');
  }
  async function prepareVaultwarden(job, payload, stamp, signal, secrets, runId) {
    const vw = job.vaultwarden;
    const dataDir = await resolveSourcePath(config, vw.dataDir || job.sourcePath, { directory: true });
    const database = vw.database;
    const artifact = path.join(payload, `db.${stamp}.${vw.dbType === 'sqlite' ? 'sqlite3' : vw.dbType === 'postgresql' ? 'dump' : 'sql'}`);
    if (vw.dbType === 'sqlite') {
      const source = await resolveSourcePath(config, vw.sqlitePath || path.join(dataDir, 'db.sqlite3'));
      const db = new DatabaseSync(source, { readOnly: true, timeout: 10000 });
      try {
        let lastProgressAt = 0;
        update(runId, { progress: { step: '复制 SQLite 数据库快照', updatedAt: now() } });
        await sqliteBackup(db, artifact, { rate: 64, progress({ totalPages, remainingPages }) {
          if (signal.aborted) throw aborted();
          const current = Date.now();
          if (remainingPages > 0 && current - lastProgressAt < 750) return;
          lastProgressAt = current;
          update(runId, { progress: {
            step: '复制 SQLite 数据库快照', updatedAt: now(),
            ...(totalPages > 0 ? { percent: Math.max(0, Math.min(99, Math.floor((totalPages - remainingPages) / totalPages * 100))) } : {}),
          } });
        } });
      } finally { db.close(); }
      update(runId, { progress: { step: '校验 SQLite 数据库快照', updatedAt: now() } });
      const snapshot = new DatabaseSync(artifact);
      try {
        snapshot.exec('PRAGMA journal_mode=DELETE');
        const checks = snapshot.prepare('PRAGMA integrity_check').all();
        if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('SQLite backup failed its integrity check');
      } finally { snapshot.close(); }
      log(runId, 'Created an online SQLite snapshot and verified database integrity');
      update(runId, { progress: { step: '整理附加文件', updatedAt: now() } });
    } else {
      if (!database.host || !database.username || !database.name) throw new Error('Database host, username and name are required');
      update(runId, { progress: { step: vw.dbType === 'postgresql' ? '导出 PostgreSQL 数据库' : '导出 MariaDB 数据库', updatedAt: now() } });
      const tlsPaths = {};
      for (const key of ['sslCa', 'sslCert', 'sslKey']) if (database[key]) tlsPaths[key] = await resolveSourcePath(config, database[key]);
      if (vw.dbType === 'postgresql') {
        const env = {
          PGHOST: database.host, PGPORT: String(database.port ?? 5432), PGUSER: database.username,
          PGPASSWORD: database.password ?? '', PGDATABASE: database.name,
        };
        if (database.sslMode !== 'default') env.PGSSLMODE = database.sslMode;
        if (tlsPaths.sslCa) env.PGSSLROOTCERT = tlsPaths.sslCa;
        if (tlsPaths.sslCert) env.PGSSLCERT = tlsPaths.sslCert;
        if (tlsPaths.sslKey) env.PGSSLKEY = tlsPaths.sslKey;
        await runTool(config.pgDumpBinary, ['--format=custom', '--no-password', '--file', artifact], { env, signal, secrets, onLine: (line) => log(runId, line, 'info', secrets) });
      } else {
        const credentialFile = path.join(path.dirname(payload), 'mysql-client.cnf');
        const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
        const lines = ['[client]', `host=${quote(database.host)}`, `port=${database.port ?? 3306}`, `user=${quote(database.username)}`, `password=${quote(database.password ?? '')}`];
        if (database.sslMode !== 'default') lines.push(`ssl=${database.sslMode === 'disable' ? '0' : '1'}`);
        if (['require', 'verify-ca', 'verify-full'].includes(database.sslMode)) lines.push('ssl-verify-server-cert=1');
        for (const [key, option] of [['sslCa', 'ssl-ca'], ['sslCert', 'ssl-cert'], ['sslKey', 'ssl-key']]) if (tlsPaths[key]) lines.push(`${option}=${quote(tlsPaths[key])}`);
        await writeFile(credentialFile, `${lines.join('\n')}\n`, { mode: 0o600 });
        const output = await open(artifact, 'w', 0o600);
        try {
          await runTool(config.mysqlDumpBinary, [`--defaults-extra-file=${credentialFile}`, '--single-transaction', '--quick', '--skip-lock-tables', '--routines', '--events', '--triggers', '--databases', '--', database.name], { signal, secrets, stdoutFile: output.fd, onLine: (line) => log(runId, line, 'info', secrets) });
        } finally { await output.close(); await rm(credentialFile, { force: true }); }
      }
      if (!(await stat(artifact)).size) throw new Error('Database export produced an empty file');
      log(runId, `Created ${vw.dbType} database export`);
      update(runId, { progress: { step: '整理附加文件', updatedAt: now() } });
    }
    const skipped = [];
    const optional = async (label, source, action) => {
      try {
        await lstat(source);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        skipped.push(label);
        log(runId, `Optional Vaultwarden artifact absent: ${label}`);
        return;
      }
      await resolveSourcePath(config, source);
      await action(source);
    };
    await optional('config.json', path.join(dataDir, 'config.json'), async (source) => copyFile(source, path.join(payload, `config.${stamp}.json`)));
    for (const [name, override] of [['attachments', vw.attachmentsPath], ['sends', vw.sendsPath]]) {
      await optional(name, override || path.join(dataDir, name), async (source) => tarDirectory(source, path.join(payload, `${name}.${stamp}.tar`), [], signal, secrets, runId));
    }
    if (vw.rsaKeyPath) {
      const parent = path.dirname(vw.rsaKeyPath);
      const files = await readdir(parent).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      const names = files.filter((name) => name.startsWith(path.basename(vw.rsaKeyPath)));
      if (!names.length) { skipped.push('rsa_key*'); log(runId, 'Optional Vaultwarden artifact absent: rsa_key*'); }
      else {
        await resolveSourcePath(config, parent, { directory: true });
        for (const name of names) await resolveSourcePath(config, path.join(parent, name));
        await runProcess(config.tarBinary ?? 'tar', ['-cf', path.join(payload, `rsakey.${stamp}.tar`), '-C', parent, '--', ...names], { signal, secrets });
      }
    } else {
      const names = (await readdir(dataDir)).filter((name) => name.startsWith('rsa_key'));
      if (!names.length) { skipped.push('rsa_key*'); log(runId, 'Optional Vaultwarden artifact absent: rsa_key*'); }
      else {
        for (const name of names) await resolveSourcePath(config, path.join(dataDir, name));
        await runProcess(config.tarBinary ?? 'tar', ['-cf', path.join(payload, `rsakey.${stamp}.tar`), '-C', dataDir, '--', ...names], { signal, secrets });
      }
    }
    update(runId, { skipped });
  }

  async function notify(job, runId, kind, secrets) {
    const settings = store.getSettings({ includeSecrets: true });
    if (!job.notification[kind] || !settings.smtp.enabled) {
      if (kind !== 'start') update(runId, { notificationStatus: 'disabled' });
      return;
    }
    const run = store.getRun(runId);
    try {
      await sendNotificationEmail(settings, {
        subject: redact(`[Backup ${kind}] ${job.name}`, secrets),
        text: redact([`Task: ${job.name}`, `Run: ${runId}`, `Source: ${job.type === 'vaultwarden' ? job.vaultwarden.dataDir || job.sourcePath : job.sourcePath}`, `Status: ${run.status}`, `Started: ${run.startedAt}`, `Finished: ${run.finishedAt ?? '-'}`, `Archive: ${run.archiveName ?? '-'}`, `Bytes: ${run.archiveBytes ?? '-'}`, ...run.targets.map((target) => `Destination: ${target.remote}:${target.path} (${target.status})`), `Error: ${run.error ?? '-'}`, ...(run.warnings ?? []).map((warning) => `Warning: ${warning}`)].join('\n'), secrets),
      });
      if (kind !== 'start') update(runId, { notificationStatus: 'sent' });
    } catch (error) {
      const warning = redact(`Email notification failed: ${error.message}`, secrets);
      log(runId, warning, 'warn', secrets);
      update(runId, { warnings: [...(store.getRun(runId).warnings ?? []), warning], ...(kind !== 'start' ? { notificationStatus: 'failed' } : {}) });
    }
  }

  function assertOwnedTarget(run, target) {
    const normalized = normalizeRemotePath(target.path);
    const parts = normalized.split('/');
    if (normalized !== target.path || parts.at(-1) !== run.archiveName) throw new Error('Refusing to operate on an unowned remote archive');
    if (target.folderName) {
      const folder = normalizeRemotePath(target.folderName);
      const base = normalizeRemotePath(`${target.destinationPath || ''}/${folder}`);
      if (folder.includes('/') || normalized !== `${base}/${run.archiveName}`) throw new Error('Refusing to operate on an unowned remote archive');
      return base;
    }
    if (parts.at(-2) !== run.id || parts.at(-3) !== run.jobId) throw new Error('Refusing to operate on an unowned remote archive');
    return parts.slice(0, -1).join('/');
  }
  async function prune(job, currentRunId, signal, secrets) {
    const completed = listAllRuns().filter((run) => run.jobId === job.id && finished.has(run.status) && run.targets?.some((target) => target.status === 'verified')).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const destination of job.destinations) {
      const destinationPath = normalizeRemotePath(destination.path);
      const matches = (run, target) => target.destinationId === destination.id && target.status === 'verified' && target.remote === destination.remote && (target.folderName
        ? target.destinationPath === destinationPath && target.path === normalizeRemotePath(`${destinationPath}/${target.folderName}/${run.archiveName}`)
        : target.path === normalizeRemotePath(`${destinationPath}/${job.id}/${run.id}/${run.archiveName}`));
      const candidates = completed.filter((run) => run.targets.some((target) => matches(run, target)));
      // keepLast counts full versions only; an incremental is pruned once it predates the oldest retained full version.
      const fulls = candidates.filter((run) => run.backupKind !== 'incremental');
      const retainedFulls = fulls.filter((run, index) => index < job.retention.keepLast
        || (job.retention.days > 0 && Date.now() - Date.parse(run.createdAt) < job.retention.days * 86400000));
      const oldestRetainedFull = retainedFulls.length ? Date.parse(retainedFulls.at(-1).createdAt) : -Infinity;
      const expired = candidates.filter((run) => run.backupKind === 'incremental'
        ? Date.parse(run.createdAt) < oldestRetainedFull && !(job.retention.days > 0 && Date.now() - Date.parse(run.createdAt) < job.retention.days * 86400000)
        : !retainedFulls.includes(run));
      for (const run of expired) {
        for (const target of run.targets.filter((item) => matches(run, item))) {
          const base = assertOwnedTarget(run, target);
          try {
            if (target.folderName) {
              const manifest = await rclone.readManifest(target.remote, `${base}/complete.json`, { signal });
              if (manifest.jobId !== run.jobId || manifest.runId !== run.id || manifest.archiveName !== run.archiveName || manifest.folderName !== target.folderName) throw new Error('Remote completion record does not match this backup version');
              await rclone.remove(target.remote, target.path, { signal });
              await rclone.remove(target.remote, `${base}/complete.json`, { signal });
            } else {
              await rclone.remove(target.remote, `${base}/complete.json`, { signal });
              await rclone.remove(target.remote, target.path, { signal });
            }
            target.status = 'pruned'; target.prunedAt = now();
            update(run.id, { targets: run.targets });
            if (target.folderName) {
              try { await rclone.rmdir(target.remote, base, { signal }); }
              catch (error) { log(currentRunId, `Could not remove empty version folder ${base}: ${error.message}`, 'warn', secrets); }
            }
            log(currentRunId, `Pruned completed version ${run.id}`);
          } catch (error) {
            if (signal.aborted) throw error;
            const warning = redact(`Retention cleanup failed for ${run.id}: ${error.message}`, secrets);
            update(currentRunId, { warnings: [...(store.getRun(currentRunId).warnings ?? []), warning] });
            log(currentRunId, warning, 'warn', secrets);
          }
        }
      }
    }
  }

  async function execute(runId, jobId) {
    const job = store.getJob(jobId, { includeSecrets: true });
    if (!job) { update(runId, { status: 'failed', error: 'Task no longer exists', finishedAt: now(), cleanupStatus: 'cleaned', notificationStatus: 'disabled' }); return; }
    const controller = new AbortController();
    controllers.set(runId, controller);
    const signal = controller.signal;
    const secrets = secretsFor(job);
    const stage = stagePath(jobId, runId);
    const payload = path.join(stage, 'payload');
    let archivePath;
    let monitor, monitorPromise = Promise.resolve(), monitoring = false;
    let archiveProgressTimer, archiveProgressTask = Promise.resolve();
    const checkSpace = async () => {
      const total = await allocatedTempBytes();
      if (total > store.getSettings().storage.maxTempBytes) await sweep(stage);
      const disk = await statfs(stage);
      if (Number(disk.bavail) * Number(disk.bsize) < 1048576) throw new Error('Temporary filesystem has less than 1 MiB free space');
    };
    update(runId, { status: 'running', startedAt: now(), cleanupStatus: 'pending', notificationStatus: 'pending', targets: job.destinations.map((destination) => ({ destinationId: destination.id, remote: destination.remote, path: '', status: 'pending' })) });
    try {
      phase(runId, 'preflight');
      await sweep();
      await mkdir(payload, { recursive: true, mode: 0o700 });
      await chmod(stage, 0o700);
      await checkSpace();
      // Check live export/archive growth; abort only this run's owned processes.
      monitor = setInterval(() => {
        if (monitoring || signal.aborted || !existsSync(stage)) return;
        monitoring = true;
        monitorPromise = checkSpace().catch((error) => {
          controller.abort(Object.assign(new Error(error.message), { code: 'TEMP_LIMIT' }));
        }).finally(() => { monitoring = false; });
      }, 250);
      monitor.unref();
      const source = job.type === 'system' ? null : await resolveSourcePath(config, job.type === 'vaultwarden' ? job.vaultwarden.dataDir || job.sourcePath : job.sourcePath, { directory: true });
      if (source && !path.relative(source, config.tempDir).startsWith('..') && !path.isAbsolute(path.relative(source, config.tempDir))) throw new Error('Temporary storage must be outside the backup source');
      const tracksBaseline = job.type === 'directory' && job.watch?.mode === 'incremental';
      const snapshot = tracksBaseline ? {} : null;
      let bytes = job.type === 'system' ? (await stat(path.join(config.dataDir, 'state.sqlite'))).size : await validateTree(source, signal, source, job.type === 'directory' ? job.excludes : [], snapshot);
      let changes = null, baseline = null;
      if (tracksBaseline && store.getRun(runId).trigger === 'watch') {
        baseline = store.getWatchBaseline(jobId, job.sourcePath);
        if (baseline) {
          changes = diffSnapshot(baseline.entries, snapshot, job.excludes);
          const packed = new Set([...changes.added, ...changes.modified].filter((name) => snapshot[name][0] !== 'link'));
          bytes = [...packed].reduce((sum, name) => sum + snapshot[name][0], 0);
        } else log(runId, 'No incremental baseline exists yet; this watch run archives the whole directory', 'warn');
      }
      update(runId, { backupKind: changes ? 'incremental' : 'full', ...(changes ? { changes: { added: changes.added.length, modified: changes.modified.length, deleted: changes.deleted.length, sample: [...changes.added, ...changes.modified].slice(0, 20) } } : {}) });
      if (changes && !changes.added.length && !changes.modified.length) {
        // Deletions alone produce no archive; the baseline keeps them so the next incremental archive records them.
        log(runId, changes.deleted.length ? `No new or modified files; ${changes.deleted.length} deletion(s) will be recorded with the next change` : 'No new or modified files since the last backup');
        clearInterval(monitor);
        await monitorPromise;
        await rm(stage, { recursive: true, force: true });
        update(runId, { status: 'succeeded', phase: 'completed', targets: [], cleanupStatus: 'cleaned', notificationStatus: 'disabled', finishedAt: now(), progress: null });
        return;
      }
      const disk = await statfs(stage);
      if (bytes * 2 > Number(disk.bavail) * Number(disk.bsize)) throw new Error('Insufficient temporary disk space for this backup');
      if (bytes > store.getSettings().storage.maxTempBytes) throw new Error('Source exceeds the configured temporary storage budget');
      const availableRemotes = await rclone.listRemotes();
      for (const destination of job.destinations) {
        normalizeRemotePath(destination.path);
        if (!availableRemotes.some((remote) => remote.name === destination.remote)) throw new Error(`rclone remote is not configured: ${destination.remote}`);
      }
      archiveArguments(job.archive, 'preflight');
      await notify(job, runId, 'start', secrets);
      phase(runId, 'preparing');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const datetime = new Date(store.getRun(runId).createdAt).toISOString().replace('T', '_').replace(/[:.]/g, '-');
      const folderName = renderArchiveComponent(job.archive.folderTemplate ?? '{datetime}', job.name, datetime);
      const archiveName = `${renderArchiveComponent(job.archive.fileTemplate ?? '{task}', job.name, datetime)}${changes ? '.incremental' : ''}.${job.archive.format}`;
      if (job.type === 'system') await prepareSystemConfig(payload, signal, runId, {
        jobId, runId, archiveName, folderName,
        targets: job.destinations.map((destination) => ({
          destinationId: destination.id, remote: destination.remote,
          destinationPath: normalizeRemotePath(destination.path), folderName,
          path: normalizeRemotePath(`${destination.path}/${folderName}/${archiveName}`),
        })),
      });
      else if (job.type === 'vaultwarden') await prepareVaultwarden(job, payload, stamp, signal, secrets, runId);
      else if (job.type === 'newapi') {
        const prepared = await prepareNewApi({
          job, payload, stage, stamp, signal, secrets, runId, config, log, update, runTool,
        });
        if (prepared?.warnings?.length) {
          const existing = store.getRun(runId).warnings ?? [];
          update(runId, { warnings: [...existing, ...prepared.warnings.map((warning) => redact(warning, secrets))] });
        }
      }
      else if (changes) {
        const packed = new Set(await tarIncremental(source, stage, path.join(payload, `incremental.${stamp}.tar`), [...changes.added, ...changes.modified], signal, secrets, runId));
        const missing = [...changes.added, ...changes.modified].filter((name) => !packed.has(name));
        // Vanished files leave the new baseline, so a later reappearance is backed up again.
        for (const name of missing) delete snapshot[name];
        await writeFile(path.join(payload, `changes.${stamp}.json`), JSON.stringify({
          kind: 'azurekiln-incremental', version: 1, jobId, runId, createdAt: store.getRun(runId).createdAt, baseCapturedAt: baseline.capturedAt,
          added: changes.added.filter((name) => packed.has(name)), modified: changes.modified.filter((name) => packed.has(name)),
          deleted: [...changes.deleted, ...missing.filter((name) => baseline.entries[name])].sort(),
        }, null, 2), { mode: 0o600 });
        log(runId, `Incremental archive: ${packed.size} new or modified file(s), ${changes.deleted.length} deletion(s) recorded`);
      } else await tarDirectory(source, path.join(payload, `directory.${stamp}.tar`), job.excludes, signal, secrets, runId);
      await sweep(stage);
      phase(runId, 'archiving');
      archivePath = path.join(stage, archiveName);
      let archivePercent = null, reportedBytes = -1, reportedPercent = null;
      const reportArchiveProgress = async () => {
        const info = await stat(archivePath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        const written = info?.size ?? 0;
        if (written === reportedBytes && archivePercent === reportedPercent) return;
        reportedBytes = written;
        reportedPercent = archivePercent;
        update(runId, { progress: { bytes: written, updatedAt: now(), ...(archivePercent === null ? {} : { percent: archivePercent }) } });
      };
      archiveProgressTimer = setInterval(() => {
        archiveProgressTask = archiveProgressTask.then(reportArchiveProgress).catch(() => {});
      }, 750);
      archiveProgressTimer.unref();
      try {
        if (job.archive.format === 'tar.gz') await runTool(config.tarBinary ?? 'tar', ['-czf', archivePath, '-C', payload, '.'], { signal, secrets });
        else {
          const archiveArgs = archiveArguments(job.archive, archivePath);
          if (job.archive.format === '7z') log(runId, `7z level ${job.archive.level}: ${archiveArgs.filter((arg) => /^-m(?:0=|mt=|d=)/.test(arg)).join(', ') || 'store only'}`);
          const handleArchiveLine = (line) => {
            const value = parseArchivePercent(line);
            if (value === null) log(runId, line, 'info', secrets);
            else archivePercent = value;
          };
          await runTool(config.sevenZipBinary, archiveArgs, {
            cwd: payload, signal, secrets, onLine: handleArchiveLine,
            onStdoutLine: (line) => {
              const value = parseArchivePercent(line);
              if (value !== null) archivePercent = value;
            },
          });
        }
      } finally {
        clearInterval(archiveProgressTimer);
        await archiveProgressTask;
        await reportArchiveProgress().catch(() => {});
      }
      phase(runId, 'verifying_archive');
      if (job.archive.format === 'tar.gz') await runTool(config.tarBinary ?? 'tar', ['-tzf', archivePath], { signal, secrets });
      else await runTool(config.sevenZipBinary, ['t', '-y', '-bd', ...(job.archive.encrypted ? [`-p${job.archive.password}`] : []), archivePath], { signal, secrets });
      const size = (await stat(archivePath)).size;
      const hashes = await fileHashes(archivePath);
      update(runId, { archiveName, archiveBytes: size, archiveSha256: hashes.SHA256, archiveFormat: job.archive.format, archiveEncrypted: job.archive.encrypted });
      await rm(payload, { recursive: true, force: true });
      await sweep(stage);
      const manifest = { version: 2, jobId, runId, taskName: job.name, folderName, createdAt: store.getRun(runId).createdAt, archiveName, archiveBytes: size, sha256: hashes.SHA256, format: job.archive.format, encrypted: job.archive.encrypted, ...(job.type === 'directory' ? { backupKind: changes ? 'incremental' : 'full' } : {}) };
      const manifestPath = path.join(stage, 'complete.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      const manifestHashes = await fileHashes(manifestPath);
      const manifestSize = (await stat(manifestPath)).size;
      const targets = store.getRun(runId).targets;
      for (let index = 0; index < job.destinations.length; index++) {
        const destination = job.destinations[index];
        const target = targets[index];
        target.destinationPath = normalizeRemotePath(destination.path);
        target.folderName = folderName;
        target.path = normalizeRemotePath(`${target.destinationPath}/${folderName}/${archiveName}`);
        for (let attempt = 1; ; attempt++) {
          if (signal.aborted) throw aborted();
          target.status = 'uploading'; target.error = undefined;
          update(runId, { targets });
          try {
            phase(runId, 'uploading');
            log(runId, `Uploading to ${target.remote}:${target.path}, attempt ${attempt}/${job.retry.attempts}`);
            await rclone.upload(archivePath, target.remote, target.path, { signal, onProgress: (progress) => update(runId, { progress }) });
            phase(runId, 'verifying_remote');
            const remoteStat = await rclone.stat(target.remote, target.path, { signal });
            target.verification = verifyRemote(size, hashes, remoteStat);
            if (target.verification.startsWith('size (')) update(runId, { warnings: [...(store.getRun(runId).warnings ?? []), `${target.remote} does not expose a comparable checksum; size was verified and SHA-256 recorded`] });
            const base = assertOwnedTarget(store.getRun(runId), target);
            await rclone.upload(manifestPath, target.remote, `${base}/complete.json`, { signal });
            verifyRemote(manifestSize, manifestHashes, await rclone.stat(target.remote, `${base}/complete.json`, { signal }));
            target.status = 'verified'; target.verifiedAt = now();
            update(runId, { targets });
            log(runId, `Verified upload using ${target.verification}`);
            break;
          } catch (error) {
            target.error = redact(error.message, secrets);
            target.status = 'failed'; update(runId, { targets });
            if (signal.aborted || attempt >= job.retry.attempts) throw error;
            log(runId, `Upload failed, retrying: ${target.error}`, 'warn', secrets);
            await new Promise((resolve, reject) => {
              const cancel = () => { clearTimeout(timer); reject(aborted()); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, job.retry.delaySeconds * 1000);
              signal.addEventListener('abort', cancel, { once: true });
            });
          }
        }
      }
      clearInterval(monitor);
      await monitorPromise;
      if (signal.aborted) throw aborted();
      // Every destination verified: this snapshot is now the incremental baseline (full runs reset it).
      if (snapshot) store.saveWatchBaseline(jobId, job.sourcePath, snapshot);
      phase(runId, 'cleanup');
      try {
        if (store.getSettings().storage.successCleanupMode === 'manual') {
          await rm(manifestPath, { force: true });
          update(runId, { cleanupStatus: 'retained' });
        } else {
          await rm(stage, { recursive: true, force: true });
          update(runId, { cleanupStatus: 'cleaned' });
        }
      } catch (cleanupError) {
        const warning = redact(`Local archive cleanup failed: ${cleanupError.message}`, secrets);
        update(runId, { cleanupStatus: 'failed', warnings: [...(store.getRun(runId).warnings ?? []), warning] });
        log(runId, warning, 'warn', secrets);
      }
      update(runId, { status: 'succeeded' });
      phase(runId, 'pruning');
      await prune(job, runId, signal, secrets);
      update(runId, { phase: 'completed', finishedAt: now(), progress: null });
      await notify(job, runId, 'success', secrets);
    } catch (error) {
      clearInterval(monitor);
      await monitorPromise;
      const resourceFailure = signal.reason?.code === 'TEMP_LIMIT' ? signal.reason : null;
      if (resourceFailure) error = resourceFailure;
      const existing = store.getRun(runId);
      if (existing.status === 'succeeded') {
        const warning = redact(`Post-upload operation failed: ${error.message}`, secrets);
        update(runId, { warnings: [...existing.warnings, warning], phase: 'completed', finishedAt: now() });
        log(runId, warning, 'warn', secrets);
        await notify(job, runId, 'success', secrets);
      } else {
        const errorMessage = redact(error.message, secrets);
        update(runId, { status: signal.aborted && !resourceFailure ? 'cancelled' : 'failed', error: errorMessage, finishedAt: now(), progress: null });
        log(runId, errorMessage, 'error', secrets);
        try {
          await rm(payload, { recursive: true, force: true });
          await rm(path.join(stage, 'mysql-client.cnf'), { force: true });
          if (signal.aborted || !archivePath || !(await stat(archivePath).catch(() => null))?.size || store.getSettings().storage.failedRetentionHours === 0) {
            await rm(stage, { recursive: true, force: true });
            update(runId, { cleanupStatus: 'cleaned' });
          } else update(runId, { cleanupStatus: 'retained' });
          await sweep();
        } catch (cleanupError) {
          update(runId, { cleanupStatus: 'failed', warnings: [...(store.getRun(runId).warnings ?? []), redact(`Temporary cleanup failed: ${cleanupError.message}`, secrets)] });
        }
        await notify(job, runId, 'failure', secrets);
      }
    } finally { clearInterval(monitor); await monitorPromise; controllers.delete(runId); }
  }

  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const item = queue.shift();
        if (store.getRun(item.runId)?.status === 'cancelled') {
          if (queuedJobs.get(item.jobId) === item.runId) queuedJobs.delete(item.jobId);
          continue;
        }
        await execute(item.runId, item.jobId);
        if (queuedJobs.get(item.jobId) === item.runId) queuedJobs.delete(item.jobId);
      }
    } finally { draining = false; }
  }

  const interruptedRuns = listAllRuns().filter((entry) => !finished.has(entry.status));
  for (const run of interruptedRuns) {
    update(run.id, { status: 'interrupted', finishedAt: now(), error: 'Service restarted before this run completed', cleanupStatus: existsSync(stagePath(run.jobId, run.id)) ? 'pending' : 'cleaned', notificationStatus: 'disabled' });
    log(run.id, 'Recovered interrupted run; no previously recorded process ID was terminated', 'warn');
  }
  const recoveryReady = (async () => {
    for (const run of interruptedRuns) {
      const stage = stagePath(run.jobId, run.id);
      try {
        await rm(path.join(stage, 'payload'), { recursive: true, force: true });
        await rm(path.join(stage, 'mysql-client.cnf'), { force: true });
        const archivePath = run.archiveName ? path.join(stage, path.basename(run.archiveName)) : null;
        const archiveInfo = archivePath ? await stat(archivePath).catch(() => null) : null;
        const retain = archiveInfo?.isFile() && archiveInfo.size === run.archiveBytes && run.archiveSha256 && (await fileHashes(archivePath)).SHA256 === run.archiveSha256 && store.getSettings().storage.failedRetentionHours > 0;
        if (retain) {
          for (const entry of await readdir(stage)) if (entry !== path.basename(run.archiveName)) await rm(path.join(stage, entry), { recursive: true, force: true });
          update(run.id, { cleanupStatus: 'retained' });
        } else {
          await rm(stage, { recursive: true, force: true });
          update(run.id, { cleanupStatus: 'cleaned' });
        }
      } catch (error) {
        const warning = `Interrupted staging cleanup failed: ${error.message}`;
        update(run.id, { cleanupStatus: 'failed', warnings: [...(store.getRun(run.id).warnings ?? []), warning] });
        log(run.id, warning, 'warn');
      }
    }
    await sweep().catch(() => {});
  })();
  activePromise = recoveryReady;
  housekeeping = setInterval(() => { if (!draining) sweep().catch(() => {}); }, 60000);
  housekeeping.unref();

  async function clearLocalArchive(runId) {
    await recoveryReady;
    const run = store.getRun(runId);
    if (!run || run.status !== 'succeeded' || run.cleanupStatus !== 'retained') throw new AppError('Retained local archive does not exist.', 404, 'LOCAL_ARCHIVE_NOT_FOUND');
    if (!run.archiveName || path.basename(run.archiveName) !== run.archiveName || ['.', '..'].includes(run.archiveName)) throw new AppError('Invalid local archive metadata.', 400, 'LOCAL_ARCHIVE_INVALID');
    await rm(stagePath(run.jobId, run.id), { recursive: true, force: true });
    update(run.id, { cleanupStatus: 'cleaned' });
    return { cleaned: true };
  }

  return {
    isJobActive(jobId) { return queuedJobs.has(jobId); },
    ensureWatchBaseline,
    clearLocalArchive,
    async clearLocalArchives() {
      await recoveryReady;
      let cleaned = 0;
      for (const run of listAllRuns().filter((item) => item.status === 'succeeded' && item.cleanupStatus === 'retained')) {
        await clearLocalArchive(run.id);
        cleaned++;
      }
      return { cleaned };
    },
    registerImportedArchive(archive) {
      if (!archive || archive.jobId !== 'system-config' || !Number.isSafeInteger(archive.archiveBytes) || archive.archiveBytes < 1
        || !/^[\da-f]{64}$/i.test(archive.archiveSha256 ?? '') || !Array.isArray(archive.targets) || archive.targets.length > 10
        || archive.targets.some((target) => !target || typeof target !== 'object')
        || !archive.archiveName || path.basename(archive.archiveName) !== archive.archiveName) return;
      const run = store.getRun(archive.runId);
      if (!run || run.jobId !== archive.jobId || run.type !== 'system') return;
      const targets = archive.targets.map((item) => ({
        destinationId: item.destinationId, remote: item.remote, destinationPath: item.destinationPath,
        folderName: item.folderName, path: item.path, status: 'recovering',
      }));
      try { for (const target of targets) assertOwnedTarget({ ...run, archiveName: archive.archiveName }, target); }
      catch { return; }
      update(run.id, {
        archiveName: archive.archiveName, archiveBytes: archive.archiveBytes, archiveSha256: archive.archiveSha256.toLowerCase(),
        archiveFormat: '7z', archiveEncrypted: true, targets, archiveRecovery: true,
      });
    },
    enqueue(jobId, trigger = 'manual') {
      if (stopped) throw new Error('Backup worker is stopping');
      if (queuedJobs.has(jobId)) {
        const existing = store.getRun(queuedJobs.get(jobId));
        if (existing && !finished.has(existing.status)) return existing;
      }
      const job = store.getJob(jobId);
      if (!job) throw new Error('Backup task not found');
      const run = store.createRun(job, trigger);
      queuedJobs.set(jobId, run.id);
      queue.push({ jobId, runId: run.id });
      activePromise = activePromise.then(drain);
      return run;
    },
    cancel(runId) {
      const run = store.getRun(runId);
      if (!run) throw new Error('Backup run not found');
      if (finished.has(run.status)) return run;
      if (controllers.has(runId)) controllers.get(runId).abort();
      else { update(runId, { status: 'cancelled', finishedAt: now(), error: 'Cancelled before execution', cleanupStatus: 'cleaned', notificationStatus: 'disabled' }); queuedJobs.delete(run.jobId); }
      return store.getRun(runId);
    },
    async shutdown() {
      stopped = true;
      clearInterval(housekeeping);
      for (const controller of controllers.values()) controller.abort();
      for (const controller of downloadOperations.keys()) controller.abort();
      for (const item of queue) {
        if (!finished.has(store.getRun(item.runId)?.status)) update(item.runId, { status: 'interrupted', finishedAt: now(), error: 'Service stopped before execution', cleanupStatus: 'cleaned', notificationStatus: 'disabled' });
      }
      queue.length = 0;
      await activePromise;
      await Promise.allSettled([...downloadOperations.values()]);
      for (const directory of downloadPaths.keys()) {
        await rm(directory, { recursive: true, force: true });
        downloadPaths.delete(directory);
      }
    },
    async recoverImportedArchives(jobId) {
      for (const run of listAllRuns().filter((item) => item.jobId === jobId && item.archiveRecovery)) {
        const targets = run.targets.map((target) => ({ ...target }));
        for (const target of targets.filter((item) => item.status === 'recovering')) {
          try {
            const base = assertOwnedTarget(run, target);
            const manifest = await rclone.readManifest(target.remote, `${base}/complete.json`);
            if (manifest.jobId !== run.jobId || manifest.runId !== run.id || manifest.archiveName !== run.archiveName
              || manifest.folderName !== target.folderName || manifest.archiveBytes !== run.archiveBytes
              || manifest.sha256 !== run.archiveSha256) continue;
            const remote = await rclone.stat(target.remote, target.path);
            if (remote.size !== run.archiveBytes) continue;
            target.status = 'verified'; target.verifiedAt = now();
          } catch { /* The remote can be unavailable after an import; retry on the next listing. */ }
        }
        update(run.id, { targets, archiveRecovery: targets.some((target) => target.status === 'recovering') });
      }
    },
    getArchives(jobId) {
      return listAllRuns().filter((run) => run.jobId === jobId && run.targets?.some((target) => target.status === 'verified')).map((run) => ({ runId: run.id, jobId, createdAt: run.createdAt, archiveName: run.archiveName, archiveBytes: run.archiveBytes, sha256: run.archiveSha256, format: run.archiveFormat, encrypted: run.archiveEncrypted, targets: run.targets.filter((target) => target.status === 'verified') }));
    },
    prepareDownload(jobId, runId, destinationId, { signal: externalSignal } = {}) {
      const controller = new AbortController();
      const signal = controller.signal;
      const cancel = () => controller.abort();
      if (externalSignal?.aborted) cancel();
      else externalSignal?.addEventListener('abort', cancel, { once: true });
      const operation = (async () => {
        const run = store.getRun(runId);
        if (!run || run.jobId !== jobId) throw new Error('Archive not found');
        const target = run.targets.find((item) => item.status === 'verified' && (!destinationId || item.destinationId === destinationId));
        if (!target) throw new Error('No verified remote copy exists for this archive');
        assertOwnedTarget(run, target);
        const directory = path.join(config.tempDir, 'downloads', randomUUID());
        const cleanup = async () => { await rm(directory, { recursive: true, force: true }); downloadPaths.delete(directory); };
        let monitor, monitorPromise = Promise.resolve(), monitoring = false;
        try {
          const admission = downloadAdmission.then(async () => {
            await recoveryReady;
            if (signal.aborted) throw aborted();
            if (stopped) throw new Error('Backup worker is stopping');
            if (!Number.isSafeInteger(run.archiveBytes) || run.archiveBytes < 1) throw new Error('Archive has invalid size metadata');
            await sweep();
            if ((await allocatedTempBytes()) + run.archiveBytes > store.getSettings().storage.maxTempBytes) throw new Error('Archive download exceeds the temporary storage budget');
            if (signal.aborted) throw aborted();
            downloadPaths.set(directory, run.archiveBytes);
          });
          downloadAdmission = admission.catch(() => {});
          await admission;
          const remoteInfo = await rclone.stat(target.remote, target.path, { signal });
          if (remoteInfo.size !== run.archiveBytes) throw new Error('Remote archive size changed; refusing to download it');
          const localPath = path.join(directory, path.basename(run.archiveName));
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const checkSize = async () => {
            if ((await treeSize(directory)) > run.archiveBytes) throw new Error('Downloaded data exceeds the recorded archive size');
            if ((await allocatedTempBytes()) > store.getSettings().storage.maxTempBytes) throw new Error('Archive download exceeds the temporary storage budget');
          };
          monitor = setInterval(() => {
            if (monitoring || signal.aborted) return;
            monitoring = true;
            monitorPromise = checkSize().catch((error) => controller.abort(Object.assign(error, { code: 'TEMP_LIMIT' }))).finally(() => { monitoring = false; });
          }, 250);
          monitor.unref();
          await rclone.download(target.remote, target.path, localPath, { signal, maxBytes: run.archiveBytes });
          clearInterval(monitor);
          await monitorPromise;
          if (signal.aborted) throw signal.reason?.code === 'TEMP_LIMIT' ? signal.reason : aborted();
          await checkSize();
          if ((await stat(localPath)).size !== run.archiveBytes || (await fileHashes(localPath, { signal })).SHA256 !== run.archiveSha256) throw new Error('Downloaded archive failed its size or SHA-256 check');
          if (signal.aborted) throw aborted();
          return { path: localPath, name: run.archiveName, cleanup };
        } catch (error) {
          clearInterval(monitor);
          await monitorPromise;
          await cleanup();
          throw signal.reason?.code === 'TEMP_LIMIT' ? signal.reason : error;
        }
      })();
      const tracked = operation.finally(() => { externalSignal?.removeEventListener('abort', cancel); downloadOperations.delete(controller); });
      downloadOperations.set(controller, tracked);
      return tracked;
    },
    async storage() {
      await recoveryReady;
      const settings = store.getSettings().storage;
      const localArchives = [];
      for (const run of listAllRuns().filter((item) => item.status === 'succeeded' && item.cleanupStatus === 'retained')) {
        if (!run.archiveName || path.basename(run.archiveName) !== run.archiveName || ['.', '..'].includes(run.archiveName)) continue;
        const info = await lstat(path.join(stagePath(run.jobId, run.id), run.archiveName)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.isFile()) localArchives.push({ runId: run.id, jobName: run.jobName, archiveName: run.archiveName, bytes: info.size, createdAt: run.createdAt });
      }
      return { tempBytes: await treeSize(config.tempDir), retainedBytes: localArchives.reduce((sum, archive) => sum + archive.bytes, 0), localArchives, ...settings };
    },
    async health() {
      const [rcloneTool, sevenZip, tar, pgDump, mysqlDump] = await Promise.all([
        rclone.status(), probe(config.sevenZipBinary, ['i']), probe(config.tarBinary ?? 'tar'), probe(config.pgDumpBinary), probe(config.mysqlDumpBinary),
      ]);
      return { rclone: rcloneTool, sevenZip, tar, sqlite: { available: true, version: process.versions.sqlite, builtin: true }, pgDump, mysqlDump };
    },
  };
}
