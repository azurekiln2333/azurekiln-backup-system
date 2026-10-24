import express from 'express';
import { Cron } from 'croner';
import { z, ZodError } from 'zod';
import { readdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { batchJobSchema, jobSchema, settingsSchema } from '../shared/contracts.mjs';
import { AppError, isWithin, loadConfig, resolveSourcePath } from './config.mjs';
import { createStore, mergeConfig, SYSTEM_JOB_ID } from './store.mjs';
import { createAuth } from './auth.mjs';
import { applyPendingSystemRestore, stageSystemRestore } from './system-restore.mjs';
import { validateNewApiJob } from './newapi.mjs';
import { createWatcher } from './watcher.mjs';

const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const requiredText = z.string().trim().min(1).max(1024);
const remoteSchema = z.string().trim().min(1).max(128).regex(/^[\w .-]+$/, 'Invalid rclone remote name.');
const relativeRemotePath = z.string().max(1024).refine((value) => !value.includes('\0') && !/[\\\r\n]/.test(value) && !value.startsWith('/') && !value.split('/').includes('..') && !value.includes(':'), 'Destination must be a relative remote path.');
const remoteRequestSchema = z.object({ remote: remoteSchema, path: relativeRemotePath.default('') });
const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);

function validateJob(input, config, { allowMissing = false } = {}) {
  const job = jobSchema.parse(input);
  if (job.watch.enabled && job.type !== 'directory') throw new AppError('File watching is available only for directory tasks.', 400, 'WATCH_DIRECTORY_ONLY');
  if (!job.destinations.length && (job.type !== 'system' || job.enabled)) throw new AppError('Add at least one backup destination.', 400, 'DESTINATION_REQUIRED');
  if (job.type === 'system') {
    job.sourcePath = '';
    if (job.archive.format !== '7z' || !job.archive.encrypted) throw new AppError('System configuration backups require an encrypted 7z archive.', 400, 'SYSTEM_ARCHIVE_REQUIRED');
    if (job.enabled && !job.archive.password) throw new AppError('Set an archive password before enabling the system configuration task.', 400, 'ARCHIVE_PASSWORD_REQUIRED');
  } else if (job.type === 'directory') job.sourcePath = resolveSourcePath(config, job.sourcePath, { directory: true, allowMissing });
  else if (job.type === 'newapi') validateNewApiJob(job, config, { allowMissing });
  else {
    const dataDir = job.vaultwarden.dataDir || job.sourcePath;
    job.vaultwarden.dataDir = resolveSourcePath(config, dataDir, { directory: true, allowMissing });
    job.sourcePath = job.vaultwarden.dataDir;
    for (const key of ['sqlitePath', 'rsaKeyPath', 'attachmentsPath', 'sendsPath']) if (job.vaultwarden[key]) resolveSourcePath(config, job.vaultwarden[key], { allowMissing: true });
    for (const key of ['sslCa', 'sslCert', 'sslKey']) if (job.vaultwarden.database[key]) resolveSourcePath(config, job.vaultwarden.database[key], { allowMissing });
    if (job.vaultwarden.dbType !== 'sqlite') {
      const database = job.vaultwarden.database;
      if (!database.host || !database.name || !database.username || /[\r\n\0]/.test(`${database.host}${database.name}${database.username}`)) throw new AppError('Database host, name and username are required and must be single-line values.');
    }
  }
  for (const destination of job.destinations) remoteRequestSchema.parse(destination);
  if (new Set(job.destinations.filter((destination) => destination.id).map((destination) => destination.id)).size !== job.destinations.filter((destination) => destination.id).length) throw new AppError('Destination identifiers must be unique.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: job.schedule.timezone });
    const cron = new Cron(job.schedule.cron, { paused: true, timezone: job.schedule.timezone });
    cron.stop();
  } catch { throw new AppError('Enter a valid cron expression and IANA timezone.', 400, 'SCHEDULE_INVALID'); }
  if (job.archive.encrypted && (job.archive.format === 'tar.gz' || (!job.archive.password && (job.type !== 'system' || job.enabled)))) throw new AppError('Encrypted backups require a password and 7z or ZIP format.', 400, 'ARCHIVE_ENCRYPTION_INVALID');
  return job;
}

function validateSettings(input) {
  const settings = settingsSchema.parse(input);
  if (settings.smtp.enabled) {
    if (!settings.smtp.host || /[\r\n\0]/.test(settings.smtp.host)) throw new AppError('SMTP host is required.');
    z.string().email().parse(settings.smtp.from);
    if (!settings.smtp.to.length) throw new AppError('At least one notification recipient is required.');
  }
  if (settings.oidc.enabled) {
    let issuer;
    try { issuer = new URL(settings.oidc.issuer); } catch { throw new AppError('Enter a valid OIDC issuer URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
    if ((issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && loopback)) || issuer.username || issuer.password || issuer.search || issuer.hash) throw new AppError('OIDC requires HTTPS; loopback HTTP is allowed for local development.');
    if (!settings.oidc.clientId || !settings.oidc.clientSecret || !settings.oidc.subject) throw new AppError('OIDC client ID, client secret and exact administrator subject are required.');
  }
  return settings;
}

export async function createApp(options = {}) {
  const config = options.config || loadConfig();
  const restore = options.store ? null : await applyPendingSystemRestore(config);
  let store, rclone, backupService;
  try {
    store = options.store || createStore(config);
    store.ensureSystemJob?.();
    rclone = options.rclone || (await import('./rclone.mjs')).createRcloneService({
      config,
      getSettings: () => store.getSettings({ includeSecrets: true }),
      saveSettings: (patch) => store.saveSettings(patch),
    });
    backupService = options.backupService || (await import('./backup.mjs')).createBackupService({ store, config, rclone });
    if (restore?.archive) backupService.registerImportedArchive?.(restore.archive);
    await restore?.complete();
  } catch (error) {
    await backupService?.shutdown?.();
    if (!options.store) store?.close();
    await restore?.rollback();
    throw error;
  }
  const scheduler = options.scheduler || (await import('./scheduler.mjs')).createScheduler({ store, backupService });
  const watcher = options.watcher || createWatcher({ store, config, backupService });
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '1mb' }));
  const auth = createAuth({ store, config });
  app.use('/api', auth.identify);
  app.get('/api/auth/status', auth.status);
  app.post('/api/auth/setup', auth.checkOrigin, wrap(auth.setup));
  app.post('/api/auth/login', auth.checkOrigin, wrap(auth.login));
  app.post('/api/auth/logout', auth.requireAuth, auth.checkOrigin, auth.csrf, auth.logout);
  app.get('/api/auth/oidc/start', wrap(auth.start));
  app.get('/api/auth/oidc/callback', wrap(auth.callback));
  app.use('/api', auth.requireAuth, auth.checkOrigin, auth.csrf);

  const getJob = (id) => {
    const job = store.getJob(id);
    if (!job) throw new AppError('Backup task does not exist.', 404, 'JOB_NOT_FOUND');
    return job;
  };
  app.get('/api/jobs', (_req, res) => res.json(store.listJobs()));
  app.post('/api/jobs', wrap(async (req, res) => {
    const job = validateJob(req.body, config);
    if (job.type === 'system') throw new AppError('The built-in system configuration task already exists.', 409, 'SYSTEM_JOB_EXISTS');
    const saved = store.saveJob(job);
    scheduler.refresh();
    watcher.refresh();
    res.status(201).json(store.getJob(saved.id));
  }));
  app.post('/api/jobs/batch', wrap(async (req, res) => {
    const input = batchJobSchema.parse(req.body);
    const parentPath = resolveSourcePath(config, input.parentPath, { directory: true });
    const existing = new Set(store.listJobs().filter((job) => job.type === 'directory').map((job) => job.sourcePath));
    // Validate every task before saving any, so a bad folder never leaves a partial batch behind.
    const jobs = input.folders.map((folder) => {
      const sourcePath = path.join(parentPath, folder);
      const template = { ...input.template, type: 'directory' };
      const job = validateJob({
        ...template,
        name: input.nameTemplate.replaceAll('{folder}', folder),
        sourcePath,
        destinations: (Array.isArray(template.destinations) ? template.destinations : []).map((destination) => ({
          remote: destination?.remote, path: [String(destination?.path ?? '').replace(/\/+$/, ''), folder].filter(Boolean).join('/'),
        })),
      }, config);
      if (existing.has(job.sourcePath)) throw new AppError(`A directory task already backs up ${folder}.`, 409, 'JOB_SOURCE_EXISTS');
      return job;
    });
    const created = jobs.map((job) => store.getJob(store.saveJob(job).id));
    scheduler.refresh();
    watcher.refresh();
    res.status(201).json(created);
  }));
  app.get('/api/jobs/:id', wrap((req, res) => res.json(getJob(req.params.id))));
  app.patch('/api/jobs/:id', wrap((req, res) => {
    const previous = store.getJob(req.params.id, { includeSecrets: true });
    if (!previous) throw new AppError('Backup task does not exist.', 404, 'JOB_NOT_FOUND');
    const patch = z.record(z.unknown()).parse(req.body);
    const merged = jobSchema.parse(mergeConfig(previous, patch));
    if ((merged.type === 'system') !== (previous.type === 'system')) throw new AppError('The built-in system task type cannot be changed.', 400, 'SYSTEM_JOB_TYPE_IMMUTABLE');
    // An empty password field means keep the currently configured password.
    if (!merged.archive.password) merged.archive.password = previous.archive.password;
    if (!merged.vaultwarden.database.password) merged.vaultwarden.database.password = previous.vaultwarden.database.password;
    // Pausing a task or turning its watcher off must still work while a mounted source is missing.
    const onlyKey = Object.keys(patch).length === 1 ? Object.keys(patch)[0] : null;
    const switchingOff = (onlyKey === 'enabled' && patch.enabled === false)
      || (onlyKey === 'watch' && patch.watch && typeof patch.watch === 'object' && Object.keys(patch.watch).length === 1 && patch.watch.enabled === false);
    const validated = validateJob(merged, config, { allowMissing: switchingOff });
    const saved = store.saveJob(validated, previous.id);
    // Pausing keeps the baseline so a resumed task catches up; leaving incremental mode makes it stale.
    if (saved.type !== 'directory' || saved.watch.mode !== 'incremental' || saved.sourcePath !== previous.sourcePath) store.deleteWatchBaseline(saved.id);
    scheduler.refresh();
    watcher.refresh();
    res.json(store.getJob(saved.id));
  }));
  app.delete('/api/jobs/:id', wrap((req, res) => {
    getJob(req.params.id);
    if (req.params.id === SYSTEM_JOB_ID) throw new AppError('The built-in system configuration task cannot be deleted.', 403, 'SYSTEM_JOB_PROTECTED');
    if (store.listRuns({ jobId: req.params.id, limit: 10000 }).items.some((run) => ['queued', 'running'].includes(run.status))) throw new AppError('Cancel active executions before deleting this task.', 409, 'JOB_BUSY');
    store.deleteJob(req.params.id);
    scheduler.refresh();
    watcher.refresh();
    res.status(204).end();
  }));
  // Sites are inventory metadata: reading and mutating them never refreshes the scheduler, watchers or job records.
  app.get('/api/sites', (_req, res) => res.json(store.listSites()));
  app.post('/api/sites', wrap((req, res) => res.status(201).json(store.saveSite(z.record(z.unknown()).parse(req.body)))));
  app.get('/api/sites/:id', wrap((req, res) => {
    const site = store.getSite(req.params.id);
    if (!site) throw new AppError('Site does not exist.', 404, 'SITE_NOT_FOUND');
    res.json(site);
  }));
  app.patch('/api/sites/:id', wrap((req, res) => res.json(store.saveSite(z.record(z.unknown()).parse(req.body), req.params.id))));
  app.delete('/api/sites/:id', wrap((req, res) => {
    if (!store.getSite(req.params.id)) throw new AppError('Site does not exist.', 404, 'SITE_NOT_FOUND');
    store.deleteSite(req.params.id);
    res.status(204).end();
  }));
  app.post('/api/jobs/:id/run', wrap((req, res) => {
    const job = getJob(req.params.id);
    if (job.type === 'system' && (!job.destinations.length || !job.archive.passwordSet)) throw new AppError('Configure a remote destination and archive password before running the system task.', 400, 'SYSTEM_JOB_UNCONFIGURED');
    res.status(202).json(backupService.enqueue(req.params.id, 'manual'));
  }));
  app.post('/api/system/import', wrap(async (req, res) => {
    if (req.get('content-type')?.split(';')[0] !== 'application/octet-stream') throw new AppError('Upload the system 7z archive as a file.', 415, 'IMPORT_CONTENT_TYPE');
    const encoded = z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/).parse(req.get('x-archive-password-base64'));
    const password = z.string().min(1).max(1024).parse(Buffer.from(encoded, 'base64').toString('utf8'));
    res.status(202).json(await stageSystemRestore(req, config, password));
  }));
  app.get('/api/jobs/:id/archives', wrap(async (req, res) => {
    getJob(req.params.id);
    await backupService.recoverImportedArchives?.(req.params.id);
    res.json(await backupService.getArchives(req.params.id));
  }));
  app.get('/api/jobs/:id/archives/:runId/download', wrap(async (req, res) => {
    getJob(req.params.id);
    const run = store.getRun(req.params.runId);
    const destinationId = req.query.destinationId ? requiredText.parse(req.query.destinationId) : undefined;
    if (!run || run.jobId !== req.params.id || !run.targets.some((target) => target.status === 'verified' && (!destinationId || target.destinationId === destinationId))) throw new AppError('A verified archive copy does not exist for this task and destination.', 404, 'ARCHIVE_NOT_FOUND');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const file = await backupService.prepareDownload(req.params.id, req.params.runId, destinationId, { signal: controller.signal });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      Promise.resolve(file.cleanup()).catch(() => {});
    };
    res.on('close', cleanup);
    if (res.destroyed) { cleanup(); return; }
    res.download(file.path, file.name, (error) => { cleanup(); if (error && !res.headersSent) res.status(502).json({ error: { code: 'DOWNLOAD_FAILED', message: 'The archive could not be downloaded.' } }); });
  }));
  app.get('/api/runs', wrap((req, res) => {
    const limit = req.query.limit === undefined ? 50 : z.coerce.number().int().min(1).max(200).parse(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : z.coerce.number().int().min(0).max(1000000).parse(req.query.offset);
    const jobId = req.query.jobId === undefined ? undefined : requiredText.parse(req.query.jobId);
    const status = req.query.status === undefined ? undefined : runStatusSchema.parse(req.query.status);
    res.json(store.listRuns({ jobId, status, limit, offset }));
  }));
  app.get('/api/runs/:id', wrap((req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) throw new AppError('Execution does not exist.', 404, 'RUN_NOT_FOUND');
    res.json(run);
  }));
  app.post('/api/runs/:id/cancel', wrap(async (req, res) => {
    if (!store.getRun(req.params.id)) throw new AppError('Execution does not exist.', 404, 'RUN_NOT_FOUND');
    await backupService.cancel(req.params.id);
    res.json(store.getRun(req.params.id));
  }));
  app.get('/api/settings', (_req, res) => res.json(store.getSettings()));
  app.patch('/api/settings', wrap((req, res) => {
    const previous = store.getSettings({ includeSecrets: true });
    const merged = settingsSchema.parse(mergeConfig(previous, z.record(z.unknown()).parse(req.body)));
    for (const [section, field] of [['smtp', 'password'], ['oidc', 'clientSecret'], ['rclone', 'configPassword']]) if (!merged[section][field]) merged[section][field] = previous[section][field];
    const settings = validateSettings(merged);
    res.json(store.saveSettings(settings));
  }));
  app.get('/api/storage', wrap(async (_req, res) => res.json(await backupService.storage())));
  app.delete('/api/storage/local-archives', wrap(async (_req, res) => res.json(await backupService.clearLocalArchives())));
  app.delete('/api/storage/local-archives/:id', wrap(async (req, res) => res.json(await backupService.clearLocalArchive(req.params.id))));
  app.post('/api/settings/test-email', wrap(async (req, res) => {
    const input = z.object({ to: z.string().email().optional() }).parse(req.body || {});
    const settings = store.getSettings({ includeSecrets: true });
    const smtp = settings.smtp;
    if (!smtp.enabled) throw new AppError('Enable and save SMTP settings before sending a test email.', 400, 'SMTP_DISABLED');
    const { sendNotificationEmail } = await import('./backup.mjs');
    const result = await sendNotificationEmail(settings, { to: input.to, subject: 'AzureKiln Backup SMTP test', text: 'SMTP test completed successfully.' });
    res.json(result);
  }));
  app.get('/api/sources', wrap((req, res) => {
    const limit = req.query.limit === undefined ? undefined : z.string().pipe(z.coerce.number().int().min(1).max(200)).parse(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : z.string().min(1).pipe(z.coerce.number().int().min(0).max(1000000)).parse(req.query.offset);
    const search = req.query.search === undefined ? '' : z.string().max(200).parse(req.query.search).toLocaleLowerCase();
    if (req.query.path === undefined || req.query.path === '') return res.json({ roots: config.sourceRoots, path: null, parent: null, entries: config.sourceRoots.map((root) => ({ name: path.basename(root) || root, path: root, isDirectory: true })), total: config.sourceRoots.length });
    const selected = resolveSourcePath(config, requiredText.parse(req.query.path), { directory: true });
    const all = readdirSync(selected, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isFile()) && entry.name.toLocaleLowerCase().includes(search))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const entries = (limit === undefined ? all : all.slice(offset, offset + limit)).flatMap((entry) => {
      const entryPath = path.join(selected, entry.name);
      try {
        const info = lstatSync(entryPath);
        if (!info.isDirectory() && !info.isFile()) return [];
        return [{ name: entry.name, path: entryPath, isDirectory: info.isDirectory(), size: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() }];
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
        throw error;
      }
    });
    const root = [...config.sourceRoots].map((item) => path.resolve(item)).sort((a, b) => b.length - a.length).find((item) => isWithin(item, selected));
    const parent = root && path.relative(root, selected) !== '' ? path.dirname(selected) : null;
    res.json({ roots: config.sourceRoots, path: selected, parent, entries, total: all.length });
  }));
  app.get('/api/rclone/status', wrap(async (_req, res) => res.json(await rclone.status())));
  app.post('/api/rclone/import', wrap(async (req, res) => {
    const input = z.object({ sourceConfigPath: requiredText.optional(), configPassword: z.string().max(4096).optional() }).parse(req.body || {});
    res.json(await rclone.importConfig(input.sourceConfigPath, input.configPassword || undefined));
  }));
  app.get('/api/rclone/remotes', wrap(async (_req, res) => res.json(await rclone.listRemotes())));
  app.get('/api/rclone/directories', wrap(async (req, res) => {
    const input = remoteRequestSchema.parse(req.query);
    res.json(await rclone.listDirectories(input.remote, input.path));
  }));
  app.post('/api/rclone/directories', wrap(async (req, res) => {
    const input = remoteRequestSchema.parse(req.body);
    await rclone.mkdir(input.remote, input.path);
    res.status(201).json({ created: true });
  }));
  app.post('/api/rclone/test', wrap(async (req, res) => { const input = remoteRequestSchema.parse(req.body); res.json(await rclone.testConnection(input.remote, input.path)); }));
  app.get('/api/overview', wrap(async (_req, res) => {
    const jobs = store.listJobs();
    const recentRuns = store.listRuns({ limit: 8 }).items;
    const lastSuccessAt = store.listRuns({ limit: 100000 }).items.find((run) => run.status === 'succeeded')?.finishedAt || null;
    const tools = await backupService.health();
    const storage = typeof backupService.storage === 'function' ? await backupService.storage() : { tempBytes: folderBytes(config.tempDir), ...store.getSettings().storage };
    res.json({ jobs, totalJobs: jobs.length, enabledJobs: jobs.filter((job) => job.enabled).length, lastSuccessAt, recentRuns, tools, watchStatus: watcher.status(), storage: { ...storage, tempDir: config.tempDir } });
  }));
  app.use('/api', (_req, _res, next) => next(new AppError('API endpoint does not exist.', 404, 'NOT_FOUND')));
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Check the submitted values.', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    const status = error.status || (error.code === 'ENOENT' ? 503 : 500);
    const code = error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
    const message = store.redact(error.message || 'The request failed.');
    res.status(status >= 400 && status <= 599 ? status : 500).json({ error: { code, message, ...(error.details ? { details: error.details } : {}) } });
  });
  scheduler.start();
  watcher.start();
  const close = async () => { scheduler.stop(); watcher.stop(); await backupService.shutdown(); if (!options.store) store.close(); };
  return { app, store, config, backupService, rclone, scheduler, watcher, close };
}

function folderBytes(folder) {
  if (!existsSync(folder)) return 0;
  return readdirSync(folder, { withFileTypes: true }).reduce((bytes, entry) => {
    const target = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) return bytes;
    return bytes + (entry.isDirectory() ? folderBytes(target) : statSync(target).size);
  }, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = await createApp();
  const server = runtime.app.listen(runtime.config.port, runtime.config.host, () => console.log(`AzureKiln Backup: ${runtime.config.publicUrl}`));
  const stop = async () => { server.close(); await runtime.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
