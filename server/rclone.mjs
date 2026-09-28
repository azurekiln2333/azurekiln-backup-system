import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat as fsStat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess, probe } from './process.mjs';

export function normalizeRemotePath(value = '') {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.includes(':')) throw new Error('Invalid remote directory');
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Remote directory traversal is not allowed');
  return parts.join('/');
}

export function createRcloneService({ config, getSettings, saveSettings }) {
  let pending = Promise.resolve();
  const serialize = (action) => {
    const next = pending.then(() => action(), () => action());
    pending = next.catch(() => {});
    return next;
  };
  async function execute(args, options = {}, configPath = config.rcloneConfigPath) {
    const password = options.configPassword ?? getSettings().rclone.configPassword ?? '';
    const result = await runProcess(config.rcloneBinary, [
      '--config', configPath, '--ask-password=false', '--contimeout', '20s', '--timeout', '5m',
      ...args,
    ], { ...options, env: { ...options.env, RCLONE_CONFIG_PASS: options.omitConfigPassword ? undefined : password }, secrets: [password, ...(options.secrets ?? [])] });
    return result.stdout;
  }
  async function remotes(configPath, configPassword) {
    try {
      const json = JSON.parse(await execute(['listremotes', '--json'], { configPassword }, configPath));
      const rows = Array.isArray(json) ? json : json.remotes;
      if (!Array.isArray(rows)) throw new Error('rclone returned an invalid remote list');
      return rows.map((row) => typeof row === 'string' ? { name: row.replace(/:$/, ''), type: 'unknown' } : { name: row.name.replace(/:$/, ''), type: row.type ?? 'unknown' });
    } catch (error) {
      if (!/unknown flag.*json/i.test(error.message)) throw error;
      // Older rclone returns a structured config dump; expose metadata only.
      const dump = JSON.parse(await execute(['config', 'dump'], { configPassword }, configPath));
      return Object.entries(dump).map(([name, value]) => ({ name, type: value.type ?? 'unknown' }));
    }
  }
  async function target(remote, remotePath) {
    if (typeof remote !== 'string' || !remote || /[:/\\\0]/.test(remote) || remote.startsWith('-')) throw new Error('Invalid rclone remote name');
    if (!(await remotes()).some((item) => item.name === remote)) throw new Error('Selected rclone remote is not configured');
    return `${remote}:${normalizeRemotePath(remotePath)}`;
  }
  async function readStat(remote, remotePath, options = {}) {
    const value = JSON.parse(await execute(['lsjson', await target(remote, remotePath), '--stat', '--hash'], options));
    if (!value || value.IsDir || !Number.isFinite(value.Size)) throw new Error('Remote archive is missing or is not a file');
    return { name: value.Name, size: value.Size, hashes: value.Hashes ?? {} };
  }
  return {
    async status() {
      const tool = await probe(config.rcloneBinary, ['version']);
      let configured = false;
      try { configured = (await fsStat(config.rcloneConfigPath)).isFile(); } catch { /* No imported configuration yet. */ }
      return { ...tool, configured, configPath: config.rcloneConfigPath };
    },
    importConfig(sourceConfigPath, configPassword) {
      return serialize(async () => {
        const source = sourceConfigPath || getSettings().rclone.sourceConfigPath || config.rcloneSourceConfigPath;
        if (!source) throw new Error('Specify an existing rclone configuration file');
        await access(source);
        if (!(await fsStat(source)).isFile()) throw new Error('rclone configuration must be a file');
        await mkdir(path.dirname(config.rcloneConfigPath), { recursive: true, mode: 0o700 });
        const candidate = `${config.rcloneConfigPath}.${randomUUID()}.pending`;
        const previous = `${config.rcloneConfigPath}.${randomUUID()}.previous`;
        let replaced = false, hadPrevious = false;
        try {
          await copyFile(source, candidate);
          await chmod(candidate, 0o600);
          const candidatePassword = configPassword ?? getSettings().rclone.configPassword ?? '';
          await remotes(candidate, candidatePassword);
          let acceptedPassword = candidatePassword;
          if (!/^RCLONE_ENCRYPT_V0:\s*$/m.test(await readFile(candidate, 'utf8'))) {
            if (!saveSettings) throw new Error('Sealed configuration persistence is required to import a plaintext rclone config');
            acceptedPassword = randomBytes(32).toString('base64url');
            // rclone parses this fixed command as a space-separated CSV list.
            const quote = (value) => `"${value.replace(/"/g, '""')}"`;
            const command = [process.execPath, fileURLToPath(new URL('./rclone-password.mjs', import.meta.url))].map((value) => quote(value.replace(/\\/g, '/'))).join(' ');
            await execute(['config', 'encryption', 'set', '--password-command', command], {
              configPassword: '', omitConfigPassword: true, env: { AZUREKILN_RCLONE_CONFIG_PASSWORD: acceptedPassword }, secrets: [acceptedPassword],
            }, candidate);
            await remotes(candidate, acceptedPassword);
            if (!/^RCLONE_ENCRYPT_V0:\s*$/m.test(await readFile(candidate, 'utf8'))) throw new Error('rclone did not encrypt its configuration');
            await chmod(candidate, 0o600);
          }
          if (acceptedPassword !== (getSettings().rclone.configPassword ?? '') && !saveSettings) throw new Error('Sealed configuration persistence is required to import this encrypted rclone config');
          try { await copyFile(config.rcloneConfigPath, previous); await chmod(previous, 0o600); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await rename(candidate, config.rcloneConfigPath);
          replaced = true;
          if (saveSettings) await saveSettings({ rclone: { configPassword: acceptedPassword, sourceConfigPath: path.resolve(source) } });
        } catch (error) {
          if (replaced) {
            if (hadPrevious) await rename(previous, config.rcloneConfigPath);
            else await rm(config.rcloneConfigPath, { force: true });
          }
          throw error;
        } finally { await rm(candidate, { force: true }); await rm(previous, { force: true }); }
        return this.status();
      });
    },
    listRemotes() { return serialize(remotes); },
    listDirectories(remote, remotePath = '') {
      return serialize(async () => {
        const base = normalizeRemotePath(remotePath);
        const rows = JSON.parse(await execute(['lsjson', await target(remote, base), '--dirs-only']));
        return rows.map((row) => ({ name: row.Name, path: normalizeRemotePath([base, row.Path].filter(Boolean).join('/')) }));
      });
    },
    mkdir(remote, remotePath) { return serialize(async () => { await execute(['mkdir', await target(remote, remotePath)]); return { ok: true }; }); },
    testConnection(remote, remotePath = '') {
      return serialize(async () => { await execute(['lsjson', await target(remote, remotePath), '--dirs-only']); return { ok: true }; });
    },
    upload(localPath, remote, remotePath, { signal, onProgress } = {}) {
      return serialize(async () => {
        await execute(['copyto', localPath, await target(remote, remotePath), '--immutable', '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE', '--retries', '1', '--low-level-retries', '1'], {
          signal, onLine(line) {
            try {
              const entry = JSON.parse(line);
              if (entry.stats) onProgress?.({ bytes: entry.stats.bytes, totalBytes: entry.stats.totalBytes, speed: entry.stats.speed, eta: entry.stats.eta });
            } catch { /* rclone may emit a non-JSON diagnostic. */ }
          },
        });
        return readStat(remote, remotePath, { signal });
      });
    },
    stat(remote, remotePath, options = {}) { return serialize(() => readStat(remote, remotePath, options)); },
    readManifest(remote, remotePath, { signal } = {}) {
      return serialize(async () => JSON.parse(await execute(['cat', await target(remote, remotePath)], { signal, maxOutputBytes: 65536 })));
    },
    remove(remote, remotePath, { signal } = {}) {
      return serialize(async () => {
        try { await execute(['deletefile', await target(remote, remotePath)], { signal }); }
        catch (error) {
          if (error.code !== 'TOOL_FAILED' || !/[:\s](?:object|directory) not found(?:\s|$)/i.test(error.message)) throw error;
        }
      });
    },
    rmdir(remote, remotePath, { signal } = {}) { return serialize(async () => { await execute(['rmdir', await target(remote, remotePath)], { signal }); }); },
    download(remote, remotePath, localPath, { signal, maxBytes } = {}) {
      return serialize(async () => {
        await execute(['copyto', await target(remote, remotePath), localPath, '--retries', '1', ...(Number.isSafeInteger(maxBytes) && maxBytes > 0 ? ['--max-transfer', String(maxBytes), '--cutoff-mode', 'HARD'] : [])], { signal });
      });
    },
    listArchives(job) {
      return serialize(async () => {
        const result = [];
        for (const destination of job.destinations) {
          const base = normalizeRemotePath(destination.path);
          const rows = JSON.parse(await execute(['lsjson', await target(destination.remote, base), '--recursive', '--files-only']));
          const files = new Map(rows.map((row) => [normalizeRemotePath(`${base}/${row.Path}`), row]));
          for (const row of rows.filter((item) => item.Name === 'complete.json')) {
            const manifestPath = normalizeRemotePath(`${base}/${row.Path}`);
            let manifest;
            try { manifest = JSON.parse(await execute(['cat', await target(destination.remote, manifestPath)], { maxOutputBytes: 65536 })); }
            catch (error) { if (error instanceof SyntaxError) continue; throw error; }
            if (manifest.jobId !== job.id || typeof manifest.archiveName !== 'string') continue;
            const archivePath = normalizeRemotePath(`${base}/${path.posix.dirname(row.Path)}/${manifest.archiveName}`);
            const archive = files.get(archivePath);
            if (archive) result.push({ destinationId: destination.id, remote: destination.remote, path: archivePath, archiveName: archive.Name, archiveBytes: archive.Size });
          }
        }
        return result;
      });
    },
  };
}
