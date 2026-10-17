import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { jobSchema, settingsSchema } from '../shared/contracts.mjs';
import { AppError } from './config.mjs';

const jobSecrets = [['archive', 'password'], ['vaultwarden', 'database', 'password'], ['newapi', 'database', 'password'], ['newapi', 'logDatabase', 'password']];
const settingsSecrets = [['smtp', 'password'], ['oidc', 'clientSecret'], ['rclone', 'configPassword']];
export const SYSTEM_JOB_ID = 'system-config';
const clone = (value) => structuredClone(value);
const getAt = (object, keys) => keys.reduce((value, key) => value?.[key], object);
function setAt(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

export function mergeConfig(previous, patch) {
  const result = clone(previous);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && previous[key] && typeof previous[key] === 'object'
      ? mergeConfig(previous[key], value) : clone(value);
  }
  return result;
}

export function createStore(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(config.dataDir, 'state.sqlite');
  let key;
  if (config.masterKey) {
    key = /^[\da-f]{64}$/i.test(config.masterKey) ? Buffer.from(config.masterKey, 'hex') : Buffer.from(config.masterKey, 'base64');
  } else {
    if (!existsSync(config.masterKeyPath) && existsSync(databasePath)) throw new Error('The existing backup state requires its original secret.key. Restore the key before starting.');
    if (!existsSync(config.masterKeyPath)) writeFileSync(config.masterKeyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    key = readFileSync(config.masterKeyPath);
  }
  if (key.length !== 32) throw new Error('Backup master key must contain exactly 32 bytes.');
  const db = new DatabaseSync(databasePath);
  try { chmodSync(databasePath, 0o600); } catch { /* Windows ACLs are inherited from DATA_DIR. */ }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runs_job_time ON runs(job_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS logs_run ON logs(run_id, id);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_transactions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secret_check (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS watch_baselines (job_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, captured_at TEXT NOT NULL, data TEXT NOT NULL);
  `);
  function seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { sealed: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
  }
  function unseal(value) {
    if (!value?.sealed) return value || '';
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  }
  const check = db.prepare('SELECT data FROM secret_check WHERE id=1').get();
  if (check) {
    try {
      if (unseal(JSON.parse(check.data)) !== 'azurekiln-backup-key-v1') throw new Error('Invalid key marker.');
    } catch {
      db.close();
      throw new Error('The backup secret key does not match the existing state. Restore its original key.');
    }
  } else {
    db.prepare('INSERT INTO secret_check(id,data) VALUES(1,?)').run(JSON.stringify(seal('azurekiln-backup-key-v1')));
  }
  function encode(value, secrets) {
    const result = clone(value);
    for (const keys of secrets) {
      const secret = getAt(result, keys);
      if (secret) setAt(result, keys, seal(secret));
      else setAt(result, keys, '');
    }
    return JSON.stringify(result);
  }
  function decode(raw, secrets, includeSecrets) {
    const result = JSON.parse(raw);
    for (const keys of secrets) {
      const secret = getAt(result, keys);
      if (includeSecrets) setAt(result, keys, unseal(secret));
      else {
        setAt(result, [...keys.slice(0, -1), `${keys.at(-1)}Set`], Boolean(secret?.sealed || secret));
        const target = getAt(result, keys.slice(0, -1));
        if (target) delete target[keys.at(-1)];
      }
    }
    return result;
  }
  function retainSecrets(value, previous, keysList) {
    for (const keys of keysList) if (!getAt(value, keys) && getAt(previous, keys)) setAt(value, keys, getAt(previous, keys));
    return value;
  }
  function redact(message) {
    let result = String(message);
    const secrets = [];
    const settings = store.getSettings({ includeSecrets: true });
    for (const keys of settingsSecrets) secrets.push(getAt(settings, keys));
    for (const job of store.listJobs({ includeSecrets: true })) for (const keys of jobSecrets) secrets.push(getAt(job, keys));
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]');
    return result.replace(/(password|client_secret|access_token|refresh_token|authorization)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[redacted]').slice(0, 8000);
  }
  const lastRunSummary = (run) => Object.fromEntries(['id', 'status', 'phase', 'startedAt', 'finishedAt', 'createdAt', 'archiveBytes', 'error', 'progress'].map((field) => [field, run[field] ?? null]));
  const store = {
    ensureSystemJob() {
      if (store.getJob(SYSTEM_JOB_ID)) return store.getJob(SYSTEM_JOB_ID);
      const job = jobSchema.parse({
        name: '系统配置', type: 'system', enabled: false, destinations: [],
        archive: { format: '7z', encrypted: true, level: 5, fileTemplate: 'system-config' },
      });
      const now = new Date().toISOString();
      db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(SYSTEM_JOB_ID, encode({ ...job, id: SYSTEM_JOB_ID, createdAt: now, updatedAt: now, nextRunAt: null, lastRun: null }, jobSecrets));
      return store.getJob(SYSTEM_JOB_ID);
    },
    listJobs({ includeSecrets = false } = {}) {
      return db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map((row) => ({ description: '', tags: [], ...decode(row.data, jobSecrets, includeSecrets) }));
    },
    getJob(id, { includeSecrets = false } = {}) {
      const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
      return row ? { description: '', tags: [], ...decode(row.data, jobSecrets, includeSecrets) } : null;
    },
    saveJob(input, id) {
      const previous = id ? store.getJob(id, { includeSecrets: true }) : null;
      if (id && !previous) throw new AppError('Backup task does not exist.', 404, 'JOB_NOT_FOUND');
      const parsed = retainSecrets(jobSchema.parse(previous ? mergeConfig(previous, input) : input), previous, jobSecrets);
      if (!parsed.destinations.length && (parsed.type !== 'system' || parsed.enabled)) throw new AppError('Add at least one backup destination.', 400, 'DESTINATION_REQUIRED');
      parsed.destinations = parsed.destinations.map((destination) => ({ ...destination, id: destination.id || randomUUID() }));
      const now = new Date().toISOString();
      const job = { ...parsed, id: id || randomUUID(), createdAt: previous?.createdAt || now, updatedAt: now, nextRunAt: previous?.nextRunAt || null, lastRun: previous?.lastRun || null };
      db.prepare('INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, encode(job, jobSecrets));
      return store.getJob(job.id);
    },
    updateJob(id, patch) {
      const job = store.getJob(id, { includeSecrets: true });
      if (!job) return null;
      const next = mergeConfig(job, patch);
      next.id = id;
      next.createdAt = job.createdAt;
      next.updatedAt = new Date().toISOString();
      db.prepare('UPDATE jobs SET data=? WHERE id=?').run(encode(next, jobSecrets), id);
      return store.getJob(id);
    },
    deleteJob(id) {
      if (id === SYSTEM_JOB_ID) return false;
      db.prepare('DELETE FROM watch_baselines WHERE job_id=?').run(id);
      return db.prepare('DELETE FROM jobs WHERE id=?').run(id).changes > 0;
    },
    // Incremental watch baseline: the file snapshot ({relativePath: [size, mtimeMs] | ['link', target]}) already backed up.
    getWatchBaseline(jobId, sourcePath) {
      const row = db.prepare('SELECT source_path,captured_at,data FROM watch_baselines WHERE job_id=?').get(jobId);
      return row && row.source_path === sourcePath ? { capturedAt: row.captured_at, entries: JSON.parse(row.data) } : null;
    },
    saveWatchBaseline(jobId, sourcePath, entries, { onlyIfMissing = false } = {}) {
      const data = JSON.stringify(entries);
      const capturedAt = new Date().toISOString();
      // onlyIfMissing never overwrites a baseline for the same source, so a slow initial capture cannot undo a finished run.
      const sql = onlyIfMissing
        ? 'INSERT INTO watch_baselines(job_id,source_path,captured_at,data) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET source_path=excluded.source_path,captured_at=excluded.captured_at,data=excluded.data WHERE watch_baselines.source_path<>excluded.source_path'
        : 'INSERT INTO watch_baselines(job_id,source_path,captured_at,data) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET source_path=excluded.source_path,captured_at=excluded.captured_at,data=excluded.data';
      return db.prepare(sql).run(jobId, sourcePath, capturedAt, data).changes > 0;
    },
    deleteWatchBaseline(jobId) { db.prepare('DELETE FROM watch_baselines WHERE job_id=?').run(jobId); },
    getSettings({ includeSecrets = false } = {}) {
      const row = db.prepare('SELECT data FROM settings WHERE id=1').get();
      return row ? decode(row.data, settingsSecrets, includeSecrets) : decode(encode(settingsSchema.parse({}), settingsSecrets), settingsSecrets, includeSecrets);
    },
    saveSettings(patch) {
      const previous = store.getSettings({ includeSecrets: true });
      const value = retainSecrets(settingsSchema.parse(mergeConfig(previous, patch)), previous, settingsSecrets);
      db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(encode(value, settingsSecrets));
      return store.getSettings();
    },
    createRun(job, trigger = 'manual') {
      const run = { id: randomUUID(), jobId: job.id, jobName: job.name, type: job.type, status: 'queued', phase: 'queued', trigger, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, archiveName: null, archiveBytes: null, progress: null, error: null, warnings: [], targets: [], cleanupStatus: 'pending', notificationStatus: 'pending' };
      db.prepare('INSERT INTO runs(id,job_id,created_at,data) VALUES(?,?,?,?)').run(run.id, run.jobId, run.createdAt, JSON.stringify(run));
      store.updateJob(job.id, { lastRun: lastRunSummary(run) });
      return run;
    },
    getRun(id) {
      const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id);
      if (!row) return null;
      return { ...JSON.parse(row.data), logs: db.prepare('SELECT id,at,level,message FROM logs WHERE run_id=? ORDER BY id').all(id) };
    },
    updateRun(id, patch) {
      const run = store.getRun(id);
      if (!run) return null;
      delete run.logs;
      const next = { ...run, ...clone(patch), id, jobId: run.jobId };
      if (next.error) next.error = typeof next.error === 'string' ? redact(next.error) : { ...next.error, message: redact(next.error.message || '') };
      if (Array.isArray(next.warnings)) next.warnings = next.warnings.map((warning) => typeof warning === 'string' ? redact(warning) : warning);
      db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(next), id);
      const job = store.getJob(run.jobId);
      if (job?.lastRun?.id === id) store.updateJob(run.jobId, { lastRun: lastRunSummary(next) });
      return store.getRun(id);
    },
    appendLog(id, { level = 'info', message }) {
      db.prepare('INSERT INTO logs(run_id,at,level,message) VALUES(?,?,?,?)').run(id, new Date().toISOString(), level, redact(message));
      db.prepare('DELETE FROM logs WHERE run_id=? AND id NOT IN (SELECT id FROM logs WHERE run_id=? ORDER BY id DESC LIMIT 2000)').run(id, id);
    },
    listRuns({ jobId, status, limit = 50, offset = 0 } = {}) {
      const conditions = [];
      const args = [];
      if (jobId) { conditions.push('job_id=?'); args.push(jobId); }
      if (status) { conditions.push("json_extract(data,'$.status')=?"); args.push(status); }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const total = db.prepare(`SELECT count(*) AS count FROM runs${where}`).get(...args).count;
      const items = db.prepare(`SELECT data FROM runs${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map((row) => JSON.parse(row.data));
      return { items, total };
    },
    listCompletedRuns(jobId) { return store.listRuns({ jobId, limit: 100000 }).items.filter((run) => run.status === 'succeeded'); },
    getAdmin() { return db.prepare('SELECT username,password_hash AS passwordHash FROM admin WHERE id=1').get() || null; },
    createAdmin(username, passwordHash) {
      if (store.getAdmin()) throw new AppError('The administrator has already been initialized.', 409, 'ALREADY_INITIALIZED');
      db.prepare('INSERT INTO admin(id,username,password_hash) VALUES(1,?,?)').run(username, passwordHash);
      return { username };
    },
    saveSession(hash, csrf, expires) {
      db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      db.prepare('INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)').run(hash, csrf, expires);
    },
    getSession(hash) {
      const row = db.prepare('SELECT csrf,expires FROM sessions WHERE hash=?').get(hash);
      if (row && row.expires > Date.now()) return row;
      store.deleteSession(hash);
      return null;
    },
    deleteSession(hash) { db.prepare('DELETE FROM sessions WHERE hash=?').run(hash); },
    saveOAuthTransaction(hash, data, expires) {
      db.prepare('DELETE FROM oauth_transactions WHERE expires<?').run(Date.now());
      db.prepare('INSERT INTO oauth_transactions(hash,expires,data) VALUES(?,?,?)').run(hash, expires, JSON.stringify(seal(JSON.stringify(data))));
    },
    consumeOAuthTransaction(hash) {
      const row = db.prepare('SELECT data,expires FROM oauth_transactions WHERE hash=?').get(hash);
      db.prepare('DELETE FROM oauth_transactions WHERE hash=?').run(hash);
      return row && row.expires > Date.now() ? JSON.parse(unseal(JSON.parse(row.data))) : null;
    },
    redact,
    close() { db.close(); },
  };
  return store;
}
