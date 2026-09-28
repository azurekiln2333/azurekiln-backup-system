import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { AppError } from './config.mjs';
import { runProcess } from './process.mjs';

const requiredFiles = ['state.sqlite', 'secret.key', 'rclone.conf'];
const optionalFiles = ['deployment.env', 'deployment-compose.yaml'];
const pendingName = 'system-restore-pending';
const journalName = 'system-restore-in-progress.json';
const maxExtractedBytes = 2147483648;

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function configuredKey(config) {
  if (!config.masterKey) return null;
  return /^[\da-f]{64}$/i.test(config.masterKey) ? Buffer.from(config.masterKey, 'hex') : Buffer.from(config.masterKey, 'base64');
}

async function validateBundle(directory, config, { enforceEnvironmentKey = true } = {}) {
  const manifestPath = path.join(directory, 'system.json');
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.size > 65536) throw new AppError('System configuration manifest is missing or too large.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.kind !== 'azurekiln-system-config' || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new AppError('This is not a supported system configuration archive.');
  const names = Object.keys(manifest.files);
  if (requiredFiles.some((name) => !names.includes(name)) || names.some((name) => ![...requiredFiles, ...optionalFiles].includes(name))) throw new AppError('System configuration archive has an invalid file list.');
  for (const name of names) {
    const filePath = path.join(directory, name);
    const info = await lstat(filePath);
    const expected = manifest.files[name];
    if (!info.isFile() || !Number.isSafeInteger(expected?.size) || expected.size !== info.size || !/^[\da-f]{64}$/i.test(expected?.sha256) || (await sha256(filePath)) !== expected.sha256.toLowerCase()) throw new AppError(`System configuration file is invalid: ${name}`);
  }
  const key = await readFile(path.join(directory, 'secret.key'));
  if (key.length !== 32) throw new AppError('System configuration key is invalid.');
  const currentKey = configuredKey(config);
  const environmentKeyMismatch = Boolean(currentKey && (currentKey.length !== 32 || !timingSafeEqual(currentKey, key)));
  if (enforceEnvironmentKey && environmentKeyMismatch) throw new AppError('BACKUP_MASTER_KEY does not match this archive. Restore the matching environment key before restarting.');
  const database = new DatabaseSync(path.join(directory, 'state.sqlite'), { readOnly: true });
  try {
    const check = database.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new AppError('System configuration database failed its integrity check.');
    try {
      const marker = JSON.parse(database.prepare('SELECT data FROM secret_check WHERE id=1').get()?.data ?? 'null');
      if (!marker?.sealed) throw new Error('Missing key marker');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(marker.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(marker.tag, 'base64'));
      const text = Buffer.concat([decipher.update(Buffer.from(marker.data, 'base64')), decipher.final()]).toString('utf8');
      if (text !== 'azurekiln-backup-key-v1') throw new Error('Invalid key marker');
    } catch { throw new AppError('System configuration key does not match the database.'); }
  } finally { database.close(); }
  return { ...manifest, environmentKeyMismatch };
}

async function extractedBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await extractedBytes(item);
    else if (entry.isFile()) total += (await stat(item)).size;
    else throw new AppError('System configuration archive contains an unsupported file.');
    if (total > maxExtractedBytes) throw new AppError('Extracted system configuration exceeds 2 GiB.', 413, 'IMPORT_TOO_LARGE');
  }
  return total;
}

async function extractSelected(config, archivePath, extracted, password, names) {
  const controller = new AbortController();
  let limitError;
  let check = Promise.resolve();
  const monitor = setInterval(() => {
    check = check.then(() => extractedBytes(extracted)).catch((error) => {
      limitError = error;
      controller.abort();
    });
  }, 100);
  try {
    await runProcess(config.sevenZipBinary, ['e', archivePath, `-o${extracted}`, `-p${password}`, '-y', '-bd', ...names], {
      secrets: [password], timeoutMs: 300000, signal: controller.signal,
    });
    await check;
    await extractedBytes(extracted);
  } catch (error) { throw limitError ?? error; }
  finally { clearInterval(monitor); await check; }
}

export async function stageSystemRestore(request, config, password) {
  if (!password) throw new AppError('Enter the system archive password.');
  const pending = path.join(config.dataDir, pendingName);
  if (await stat(pending).catch(() => null)) throw new AppError('A system configuration import is already waiting for restart.', 409, 'RESTORE_PENDING');
  const work = path.join(config.dataDir, 'system-import-work', randomUUID());
  const extracted = path.join(work, 'extracted');
  const archivePath = path.join(work, 'archive.7z');
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  try {
    let received = 0;
    const maxBytes = 268435456;
    await pipeline(request, new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new AppError('System configuration archive exceeds 256 MiB.', 413, 'IMPORT_TOO_LARGE') : null, chunk);
    } }), createWriteStream(archivePath, { mode: 0o600 }));
    if (!received) throw new AppError('Select a system configuration archive.');
    const options = { secrets: [password], timeoutMs: 300000 };
    await runProcess(config.sevenZipBinary, ['t', archivePath, `-p${password}`, '-y', '-bd'], options);
    await extractSelected(config, archivePath, extracted, password, ['system.json', ...requiredFiles]);
    const info = await lstat(path.join(extracted, 'system.json')).catch(() => null);
    if (!info?.isFile() || info.size > 65536) throw new AppError('System configuration manifest is missing or too large.');
    const manifest = JSON.parse(await readFile(path.join(extracted, 'system.json'), 'utf8'));
    if (manifest?.files?.['deployment.env']) await extractSelected(config, archivePath, extracted, password, ['deployment.env']);
    if (manifest?.files?.['deployment-compose.yaml']) await extractSelected(config, archivePath, extracted, password, ['deployment-compose.yaml']);
    const validated = await validateBundle(extracted, config, { enforceEnvironmentKey: false });
    await writeFile(path.join(extracted, 'import.json'), JSON.stringify({ archiveBytes: received, archiveSha256: await sha256(archivePath) }), { mode: 0o600 });
    if (await stat(pending).catch(() => null)) throw new AppError('A system configuration import is already waiting for restart.', 409, 'RESTORE_PENDING');
    await rename(extracted, pending);
    return { pendingRestart: true, createdAt: manifest.createdAt, hasDeploymentEnv: Boolean(manifest.files['deployment.env']), hasDeploymentCompose: Boolean(manifest.files['deployment-compose.yaml']), environmentKeyMismatch: validated.environmentKeyMismatch };
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'SQLITE_ERROR' || error.code === 'TOOL_FAILED') throw new AppError('System configuration archive or password is invalid.');
    throw error;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function applyPendingSystemRestore(config) {
  const pending = path.join(config.dataDir, pendingName);
  const journalPath = path.join(config.dataDir, journalName);
  const writeJournal = async (value) => {
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, journalPath);
  };
  const originals = [
    ['state.sqlite', 'state.sqlite'], ['state.sqlite-wal', 'state.sqlite-wal'], ['state.sqlite-shm', 'state.sqlite-shm'],
    ['secret.key', 'secret.key'], ['rclone/rclone.conf', 'rclone/rclone.conf'], ['restored-deployment.env', 'restored-deployment.env'], ['restored-compose.yaml', 'restored-compose.yaml'],
  ];
  const rollback = async (journal) => {
    const previous = path.join(config.dataDir, journal.previous);
    for (const [source, target] of originals) {
      const live = path.join(config.dataDir, source);
      const saved = path.join(previous, target);
      if (await stat(saved).catch(() => null)) {
        await rm(live, { force: true });
        await rename(saved, live);
      } else if (!journal.existed.includes(source)) await rm(live, { force: true });
    }
    await rm(journalPath, { force: true });
  };
  const interrupted = await readFile(journalPath, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (interrupted) {
    if (typeof interrupted.previous !== 'string' || !/^system-restore-previous-\d+-[\da-f-]+$/.test(interrupted.previous) || !Array.isArray(interrupted.existed)) throw new AppError('System restore journal is invalid.');
    if (interrupted.phase === 'committed') {
      await rm(pending, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      return null;
    }
    await rollback(interrupted);
  }
  if (!(await stat(pending).catch(() => null))) return null;
  const manifest = await validateBundle(pending, config);
  const importInfo = JSON.parse(await readFile(path.join(pending, 'import.json'), 'utf8'));
  const previousName = `system-restore-previous-${Date.now()}-${randomUUID()}`;
  const previous = path.join(config.dataDir, previousName);
  await mkdir(path.join(previous, 'rclone'), { recursive: true, mode: 0o700 });
  const existed = [];
  for (const [source] of originals) if (await stat(path.join(config.dataDir, source)).catch(() => null)) existed.push(source);
  const journal = { previous: previousName, existed, phase: 'applying' };
  await writeJournal(journal);
  try {
    for (const [source, target] of originals) {
      const live = path.join(config.dataDir, source);
      if (existed.includes(source)) await rename(live, path.join(previous, target));
    }
    for (const name of requiredFiles) {
      const target = name === 'rclone.conf' ? config.rcloneConfigPath : path.join(config.dataDir, name);
      await copyFile(path.join(pending, name), target);
      await chmod(target, 0o600);
    }
    if (manifest.files['deployment.env']) {
      const target = path.join(config.dataDir, 'restored-deployment.env');
      await copyFile(path.join(pending, 'deployment.env'), target);
      await chmod(target, 0o600);
    }
    if (manifest.files['deployment-compose.yaml']) {
      const target = path.join(config.dataDir, 'restored-compose.yaml');
      await copyFile(path.join(pending, 'deployment-compose.yaml'), target);
      await chmod(target, 0o600);
    }
    return {
      previous,
      archive: { ...manifest.backup, ...importInfo },
      async complete() {
        await writeJournal({ ...journal, phase: 'committed' });
        await rm(pending, { recursive: true, force: true }).catch(() => {});
        if (!(await stat(pending).catch(() => null))) await rm(journalPath, { force: true }).catch(() => {});
      },
      async rollback() { await rollback(journal); },
    };
  } catch (error) {
    await rollback(journal);
    throw error;
  }
}
