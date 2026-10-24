import path from 'node:path';
import { mkdirSync, realpathSync, lstatSync, existsSync } from 'node:fs';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  if (env === process.env && existsSync(path.join(cwd, '.env'))) process.loadEnvFile(path.join(cwd, '.env'));
  const dataDir = path.resolve(cwd, env.DATA_DIR || '.data');
  const rawRoots = env.SOURCE_ROOTS || path.join(cwd, 'sources');
  const roots = rawRoots.startsWith('[') ? JSON.parse(rawRoots) : rawRoots.split(path.delimiter).filter(Boolean);
  if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== 'string' || !root.trim())) throw new Error('SOURCE_ROOTS must contain at least one directory.');
  const sourceRoots = roots.map((root) => path.resolve(cwd, root));
  const tempDir = path.join(dataDir, 'tmp');
  const port = Number(env.BACKUP_PORT || 16323);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BACKUP_PORT must be between 1 and 65535.');
  for (const root of sourceRoots) {
    if (isWithin(root, dataDir) || isWithin(dataDir, root)) throw new Error('DATA_DIR and SOURCE_ROOTS must not overlap.');
    mkdirSync(root, { recursive: true });
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const rcloneConfigPath = path.join(dataDir, 'rclone', 'rclone.conf');
  mkdirSync(path.dirname(rcloneConfigPath), { recursive: true, mode: 0o700 });
  const publicUrl = env.BACKUP_PUBLIC_URL || `http://${env.BACKUP_HOST || '127.0.0.1'}:${port}`;
  const parsed = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('BACKUP_PUBLIC_URL must be an HTTP(S) origin.');
  const config = {
    dataDir, sourceRoots: sourceRoots.map((root) => realpathSync(root)), tempDir, port,
    host: env.BACKUP_HOST || '127.0.0.1', publicUrl: parsed.origin,
    setupToken: env.SETUP_TOKEN || '', adminUsername: env.ADMIN_USERNAME || '', adminPassword: env.ADMIN_PASSWORD || '',
    rcloneBinary: env.RCLONE_BINARY || 'rclone', sevenZipBinary: env.SEVEN_ZIP_BINARY || '7z',
    sqliteBinary: env.SQLITE_BINARY || 'sqlite3', pgDumpBinary: env.PG_DUMP_BINARY || 'pg_dump',
    mysqlDumpBinary: env.MYSQL_DUMP_BINARY || 'mariadb-dump',
    rcloneSourceConfigPath: env.RCLONE_CONFIG_SOURCE || '', rcloneConfigPath,
    masterKeyPath: path.join(dataDir, 'secret.key'), masterKey: env.BACKUP_MASTER_KEY || '',
    systemEnvPath: env.SYSTEM_ENV_FILE ? path.resolve(cwd, env.SYSTEM_ENV_FILE) : (existsSync(path.join(cwd, '.env')) ? path.join(cwd, '.env') : ''),
    systemComposePath: env.SYSTEM_COMPOSE_FILE ? path.resolve(cwd, env.SYSTEM_COMPOSE_FILE) : (existsSync(path.join(cwd, 'compose.yaml')) ? path.join(cwd, 'compose.yaml') : ''),
  };
  const realDataDir = realpathSync(dataDir);
  if (config.sourceRoots.some((root) => isWithin(root, realDataDir) || isWithin(realDataDir, root))) throw new Error('Resolved DATA_DIR and SOURCE_ROOTS must not overlap.');
  return config;
}

export function resolveSourcePath(config, input, { allowMissing = false, directory = false, file = false } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0') || !path.isAbsolute(input)) throw new AppError('Select an absolute source path inside an allowed root.', 400, 'SOURCE_PATH_INVALID');
  const absolute = path.resolve(input);
  const root = config.sourceRoots.find((item) => isWithin(item, absolute));
  if (!root || isWithin(absolute, config.dataDir) || isWithin(config.dataDir, absolute)) throw new AppError('Source path is outside the allowed roots or overlaps backup state.', 403, 'SOURCE_PATH_FORBIDDEN');
  // Check each component so a symlink cannot leave and re-enter an allowed root.
  let current = root;
  const pieces = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (const piece of pieces) {
    current = path.join(current, piece);
    if (!existsSync(current)) {
      if (allowMissing) return absolute;
      throw new AppError('Source path does not exist.', 404, 'SOURCE_PATH_MISSING');
    }
    if (lstatSync(current).isSymbolicLink()) throw new AppError('Symbolic-link source paths are not allowed.', 403, 'SOURCE_SYMLINK_FORBIDDEN');
  }
  if (!existsSync(absolute)) {
    if (allowMissing) return absolute;
    throw new AppError('Source path does not exist.', 404, 'SOURCE_PATH_MISSING');
  }
  const real = realpathSync(absolute);
  if (!isWithin(root, real)) throw new AppError('Source path escapes its allowed root.', 403, 'SOURCE_PATH_FORBIDDEN');
  if (directory && !lstatSync(real).isDirectory()) throw new AppError('Select a directory.', 400, 'SOURCE_NOT_DIRECTORY');
  // File tasks must point at one regular file; directories, symlinks and special files are rejected.
  if (file && !lstatSync(real).isFile()) throw new AppError('Select a regular file.', 400, 'SOURCE_NOT_FILE');
  return real;
}
