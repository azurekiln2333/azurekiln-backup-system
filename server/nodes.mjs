import path from 'node:path';
import { z } from 'zod';
import { jobSchema, nodeSyncSummarySchema, syncJobsRequestSchema } from '../shared/contracts.mjs';
import { AppError } from './config.mjs';
import { SYSTEM_JOB_ID } from './store.mjs';

const SECRET_FIELDS = [['archive', 'password'], ['vaultwarden', 'database', 'password'], ['newapi', 'database', 'password'], ['newapi', 'logDatabase', 'password']];
const SYNC_VERSION = 'azurekiln-sync-v1';
const readAt = (value, keys) => keys.reduce((part, key) => part?.[key], value);
const writeAt = (value, keys, next) => { const parent = readAt(value, keys.slice(0, -1)); if (parent) parent[keys.at(-1)] = next; };
const absolute = (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value);
const tokenStatusSchema = z.object({ ok: z.literal(true), version: z.literal(SYNC_VERSION), jobs: z.number().int().min(0) });

function summarize(jobs) {
  const synced = jobs.filter((job) => job.status === 'synced').length;
  const unmapped = jobs.filter((job) => job.status === 'unmapped').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  return { at: new Date().toISOString(), status: failed === jobs.length && failed ? 'failed' : failed || unmapped ? 'partial' : 'succeeded', total: jobs.length, synced, unmapped, failed, jobs };
}

// Project at both transport boundaries: IDs, history and secret values cannot cross with a definition.
function definition(input, { receiving = false } = {}) {
  if (receiving && SECRET_FIELDS.some((keys) => readAt(input, keys) !== undefined)) throw new AppError('Configure credentials locally on the receiving node.', 400, 'SYNC_SECRETS_FORBIDDEN');
  const job = jobSchema.parse(input);
  for (const keys of SECRET_FIELDS) {
    const parent = readAt(job, keys.slice(0, -1));
    if (parent) delete parent[keys.at(-1)];
  }
  // An inactive adapter's old settings are not part of this task's definition.
  if (job.type !== 'vaultwarden') delete job.vaultwarden;
  if (job.type !== 'newapi') delete job.newapi;
  return job;
}

function sourceFields(job) {
  if (job.type === 'directory' || job.type === 'file') return [['sourcePath']];
  const fields = [['sourcePath']];
  if (job.type === 'vaultwarden') {
    job.vaultwarden.dataDir ||= job.sourcePath;
    job.sourcePath = job.vaultwarden.dataDir;
    fields.push(['vaultwarden', 'dataDir']);
    for (const key of ['sqlitePath', 'rsaKeyPath', 'attachmentsPath', 'sendsPath']) fields.push(['vaultwarden', key]);
    // The shared receiver validator checks persisted TLS paths in every mode, including SQLite.
    for (const key of ['sslCa', 'sslCert', 'sslKey']) fields.push(['vaultwarden', 'database', key]);
  } else if (job.type === 'newapi') {
    job.newapi.dataDir ||= job.sourcePath;
    job.sourcePath = job.newapi.dataDir;
    for (const key of ['dataDir', 'sqlitePath', 'logSqlitePath', 'envFilePath', 'composeFilePath', 'serviceFilePath', 'proxyConfigPath', 'pluginsPath']) fields.push(['newapi', key]);
    if (job.newapi.includeLogs) fields.push(['newapi', 'logsPath']);
    for (const database of ['database', 'logDatabase']) for (const key of ['sslCa', 'sslCert', 'sslKey']) fields.push(['newapi', database, key]);
  }
  return fields.filter((keys) => readAt(job, keys));
}

function mappedDefinition(source, node, mapPath) {
  const job = definition(source);
  const fields = sourceFields(job);
  const unique = [...new Set(fields.map((keys) => readAt(job, keys)))];
  const overrides = node.jobOverrides[source.id]?.sources || [];
  const overrideRules = unique.flatMap((from, index) => overrides[index] ? [{ from, to: overrides[index] }] : []);
  const mapped = new Map();
  const unmapped = [];
  for (const [index, input] of unique.entries()) {
    let result;
    if (overrides[index]) result = { path: overrides[index], mapped: true };
    else {
      // Dependent files under an overridden source follow that override through the same pure mapper.
      if (overrideRules.length) result = mapPath(input, overrideRules);
      if (!result?.mapped) result = mapPath(input, node.pathRules);
    }
    if (result?.needsMapping || (absolute(input) && !result?.mapped) || !result?.path) unmapped.push(input);
    else mapped.set(input, result.path);
  }
  for (const keys of fields) if (mapped.has(readAt(job, keys))) writeAt(job, keys, mapped.get(readAt(job, keys)));
  for (const destination of job.destinations) {
    if (!absolute(destination.path)) continue;
    const result = mapPath(destination.path, node.pathRules);
    if (!result?.mapped || result.needsMapping || !result.path) unmapped.push(destination.path);
    else destination.path = result.path;
  }
  return { job, sources: [...mapped.values()], unmapped: [...new Set(unmapped)] };
}

function missingCredentials(job) {
  const missing = [];
  if (job.archive.encrypted && !job.archive.password) missing.push('archive');
  if (job.type === 'vaultwarden' && job.vaultwarden.dbType !== 'sqlite' && !job.vaultwarden.database.password) missing.push('database');
  if (job.type === 'newapi') {
    if (job.newapi.dbType !== 'sqlite' && !job.newapi.database.password) missing.push('database');
    if (['mysql', 'postgresql'].includes(job.newapi.logDbType) && !job.newapi.logDatabase.password) missing.push('log database');
  }
  return missing;
}

async function defaultMapper() {
  try { return (await import('./node-paths.mjs')).mapPath; }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('node-paths.mjs')) throw error;
    // The path-mapping workstream owns that module. Until it lands, absolute paths never leave this instance.
    return (input) => ({ path: input, mapped: false });
  }
}

export function createNodeService({ store, config, validateJob, backupService, scheduler, watcher, tokens, mapPath, fetchImpl = fetch, timeoutMs = 15000 }) {
  const syncing = new Set();
  const requests = new Set();
  let closed = false;
  const getNode = (id) => {
    const node = store.getNode(id, { includeSecrets: true });
    if (!node) throw new AppError('Server node does not exist.', 404, 'NODE_NOT_FOUND');
    return node;
  };
  async function request(node, endpoint, { method = 'GET', body } = {}) {
    if (closed) throw new AppError('Node synchronization is shutting down.', 503, 'NODE_SYNC_CLOSED');
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && Buffer.byteLength(encoded) > 1024 * 1024) throw new AppError('The synchronization payload is too large.', 400, 'NODE_PAYLOAD_TOO_LARGE');
      const response = await fetchImpl(`${node.baseUrl}${endpoint}`, {
        method, headers: { authorization: `Bearer ${node.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: encoded, redirect: 'manual', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new AppError('Node redirects are not allowed. Configure its final address.', 502, 'NODE_REDIRECT_FORBIDDEN');
      if (!response.ok) {
        if (response.status === 401) throw new AppError('The node rejected its API token.', 502, 'NODE_TOKEN_REJECTED');
        if (response.status === 403) throw new AppError('The node API token requires the sync scope.', 502, 'NODE_SCOPE_REJECTED');
        throw new AppError('The node rejected the synchronization request.', 502, 'NODE_REQUEST_FAILED');
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new AppError('The node response is too large.', 502, 'NODE_RESPONSE_INVALID');
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AppError('The node returned an invalid synchronization response.', 502, 'NODE_RESPONSE_INVALID'); }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(controller.signal.aborted ? 'The node connection timed out or was cancelled.' : 'The node could not be reached. Check its address and availability.', 502, controller.signal.aborted ? 'NODE_REQUEST_TIMEOUT' : 'NODE_UNREACHABLE');
    } finally {
      controller.abort();
      clearTimeout(timer);
      requests.delete(controller);
    }
  }
  return {
    async requireSyncToken(req, _res, next) {
      try {
        let principal;
        try { principal = tokens?.authenticate ? await tokens.authenticate(req.get('authorization')) : store.authenticateSyncToken(req.get('authorization')); }
        catch { throw new AppError('The API token is invalid.', 401, 'TOKEN_INVALID'); }
        if (!principal) throw new AppError('The API token is invalid.', 401, 'TOKEN_INVALID');
        if (!Array.isArray(principal.scopes) || !principal.scopes.includes('sync')) throw new AppError('This API token does not allow task synchronization.', 403, 'TOKEN_SCOPE_FORBIDDEN');
        if (req.get('origin') && req.get('origin') !== config.publicUrl) throw new AppError('Request origin is not allowed.', 403, 'ORIGIN_FORBIDDEN');
        next();
      } catch (error) { next(error); }
    },
    status() { return { ok: true, version: SYNC_VERSION, jobs: store.listJobs().filter((job) => job.type !== 'system').length }; },
    isSyncing(id) { return syncing.has(id); },
    async test(id) {
      const parsed = tokenStatusSchema.safeParse(await request(getNode(id), '/api/sync/status'));
      if (!parsed.success) throw new AppError('The node returned an invalid connection-test response.', 502, 'NODE_RESPONSE_INVALID');
      return { ...parsed.data, message: 'The node is reachable and its synchronization token is valid.' };
    },
    async sync(id) {
      const node = getNode(id);
      if (!node.enabled) throw new AppError('Enable the node before synchronizing.', 409, 'NODE_DISABLED');
      if (syncing.has(id)) throw new AppError('This node is already synchronizing.', 409, 'NODE_SYNC_BUSY');
      syncing.add(id);
      try {
        const mapper = mapPath || await defaultMapper();
        const sources = store.listJobs().filter((job) => job.type !== 'system' && !store.isSyncedJob(job.id));
        if (sources.length > 500) throw new AppError('Synchronize at most 500 tasks at once.', 400, 'NODE_TASK_LIMIT');
        const jobs = [];
        const payload = [];
        for (const source of sources) {
          try {
            const projected = mappedDefinition(source, node, mapper);
            if (projected.unmapped.length) jobs.push({ jobId: source.id, jobName: source.name, status: 'unmapped', unmapped: projected.unmapped, message: 'Configure node-local paths before synchronizing this task.' });
            else {
              payload.push({ syncKey: source.id, job: projected.job });
              jobs.push({ jobId: source.id, jobName: source.name, status: 'synced', sources: projected.sources });
            }
          } catch {
            jobs.push({ jobId: source.id, jobName: source.name, status: 'failed', code: 'NODE_PATH_MAPPING_FAILED', message: 'Check this task and the node path rules.' });
          }
        }
        if (payload.length) {
          try {
            const response = nodeSyncSummarySchema.safeParse(await request(node, '/api/sync/jobs', { method: 'PUT', body: { jobs: payload } }));
            if (!response.success) throw new AppError('The node returned an invalid synchronization result.', 502, 'NODE_RESPONSE_INVALID');
            const expected = new Set(payload.map((entry) => entry.syncKey));
            if (response.data.jobs.length !== expected.size || new Set(response.data.jobs.map((result) => result.jobId)).size !== expected.size || response.data.jobs.some((result) => !expected.has(result.jobId))) throw new AppError('The node returned an incomplete synchronization result.', 502, 'NODE_RESPONSE_INVALID');
            const results = new Map(response.data.jobs.map((result) => [result.jobId, result]));
            for (const job of jobs.filter((entry) => entry.status === 'synced')) {
              const remote = results.get(job.jobId);
              if (remote.status !== 'synced' || !remote.remoteJobId) Object.assign(job, { status: 'failed', code: remote.code || 'SYNC_JOB_REJECTED', message: 'The node rejected this task. Check its local paths and configuration.' });
              else {
                job.remoteJobId = remote.remoteJobId;
                if (remote.paused) Object.assign(job, { paused: true, message: 'Definition synchronized and paused. Configure its credentials locally on the node.' });
              }
            }
          } catch (error) {
            for (const job of jobs.filter((entry) => entry.status === 'synced')) Object.assign(job, { status: 'failed', code: error.code, message: error.message });
          }
        }
        const summary = summarize(jobs);
        store.recordNodeSync(id, summary);
        return summary;
      } finally { syncing.delete(id); }
    },
    receive(input) {
      const request = syncJobsRequestSchema.parse(input);
      let changed = false;
      const jobs = request.jobs.map(({ syncKey, job: inputJob }) => {
        try {
          if (syncKey === SYSTEM_JOB_ID || inputJob.type === 'system') throw new AppError('The built-in system task cannot be synchronized.', 400, 'SYNC_SYSTEM_JOB_FORBIDDEN');
          const incoming = definition(inputJob, { receiving: true });
          const previous = store.getSyncedJob(syncKey, { includeSecrets: true });
          if (previous && backupService.isJobActive(previous.id)) throw new AppError('Wait for the active backup before synchronizing this task.', 409, 'JOB_BUSY');
          // Local credentials belong to this node and survive every secret-free definition update.
          for (const keys of SECRET_FIELDS) if (readAt(previous, keys)) writeAt(incoming, keys, readAt(previous, keys));
          const missing = missingCredentials(incoming);
          if (missing.length) incoming.enabled = false;
          const validated = validateJob(incoming, { allowIncompleteSecrets: Boolean(missing.length) });
          const saved = store.saveSyncedJob(syncKey, validated);
          if (previous && (saved.type !== 'directory' || saved.watch.mode !== 'incremental' || saved.sourcePath !== previous.sourcePath)) store.deleteWatchBaseline(saved.id);
          changed = true;
          return { jobId: syncKey, jobName: saved.name, remoteJobId: saved.id, status: 'synced', ...(missing.length ? { paused: true, message: 'Configure credentials locally before enabling this task.' } : {}) };
        } catch (error) {
          return { jobId: syncKey, status: 'failed', code: error instanceof AppError ? error.code : 'SYNC_JOB_INVALID', message: error instanceof AppError ? store.redact(error.message).slice(0, 2048) : 'Check the task definition and node-local configuration.' };
        }
      });
      if (changed) { scheduler.refresh(); watcher.refresh(); }
      return summarize(jobs);
    },
    async close() {
      closed = true;
      for (const controller of requests) controller.abort();
      // Requests are abortable; the caller waits on active pushes before closing SQLite.
      while (requests.size || syncing.size) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}
