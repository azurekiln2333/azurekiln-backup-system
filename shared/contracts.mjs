import { z } from 'zod';

export const destinationSchema = z.object({
  id: z.string().optional(),
  remote: z.string().trim().min(1).max(128),
  path: z.string().trim().max(1024).default(''),
});

const archiveNameTemplate = z.string().trim().min(1).max(100).refine((value) => {
  const literal = value.replace(/\{datetime\}|\{task\}/g, '');
  return !/[{}]/.test(literal) && /^[\p{L}\p{N} ._-]*$/u.test(literal) && !/^\.+$/.test(value);
}, '名称只能使用文字、数字、空格、横线、下划线、点以及 {datetime}、{task}。');

const exclusionPattern = z.string().max(512).refine(
  value => !/[\0\r\n\\{}()\[\]]/.test(value) && !value.startsWith('!'),
  'Use literal paths with * or ? wildcards; extended glob syntax is not supported.',
);

// Shared database connection block: Vaultwarden and new-api both point at an existing server.
const databaseSchema = z.object({
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).optional(),
  name: z.string().default(''),
  username: z.string().default(''),
  password: z.string().max(1024).optional(),
  sslMode: z.enum(['default', 'disable', 'require', 'verify-ca', 'verify-full']).default('default'),
  sslCa: z.string().default(''),
  sslCert: z.string().default(''),
  sslKey: z.string().default(''),
});

// Vaultwarden keeps its historical defaults so existing tasks and validation keep working.
const vaultwardenDatabaseSchema = databaseSchema
  .extend({ name: z.string().default('vaultwarden'), username: z.string().default('vaultwarden') })
  .default({});

// Tags are free-form labels for grouping tasks; duplicates are removed case-insensitively, keeping the first spelling.
// Exported so site tags reuse the exact same rules while staying an independent value set from job tags.
export const tagListSchema = z.array(z.string().trim().min(1).max(32).refine((value) => !/[,\r\n\0]/.test(value), '标签不能包含逗号或换行。'))
  .max(10).default([])
  .transform(dedupeTags);

/** @param {string[]} tags @returns {string[]} */
function dedupeTags(tags) {
  return tags.filter((tag, index) => tags.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index);
}

// Site inventory contract. A site organizes existing backup tasks as many-to-many metadata; it never changes their execution.
export const SITE_DOMAIN_LIMIT = 20;
export const SITE_DOMAIN_MAX_LENGTH = 2048;
export const SITE_BACKUP_JOB_LIMIT = 200;
const SITE_DOMAIN_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// Canonical address boundary shared by API validation and the UI. Bare hosts default to HTTPS; the URL parser
// normalizes host casing and default ports while preserving case-sensitive path/query segments. No DNS or HTTP probe runs.
/** @param {string} input @returns {string} */
export function normalizeSiteDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('地址不能为空。');
  if (/[\0-\x1f\x7f ]/.test(raw)) throw new Error('地址不能包含空格或控制字符。');
  const candidate = SITE_DOMAIN_SCHEME.test(raw) ? raw : raw.startsWith('//') ? `https:${raw}` : `https://${raw}`;
  // A path-only input such as `/foo` or `https:///foo` has an empty authority; the URL parser would silently brand the path as a host.
  if (candidate.slice(candidate.indexOf('://') + 3).startsWith('/')) throw new Error('地址必须是主机名或 HTTP(S) 地址。');
  let url;
  try { url = new URL(candidate); } catch { throw new Error('地址必须是主机名或 HTTP(S) 地址。'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('地址只支持 http:// 或 https://。');
  if (url.username || url.password) throw new Error('地址不能包含用户名或密码。');
  if (!url.hostname) throw new Error('地址缺少主机名。');
  if (url.port === '0') throw new Error('端口 0 无效。');
  // Reject empty DNS labels (`.com`, `a..b.com`); a single trailing dot (FQDN form) stays valid and IPv6 literals are skipped.
  if (!url.hostname.startsWith('[')) {
    const labels = url.hostname.split('.');
    if (labels.at(-1) === '') labels.pop();
    if (labels.some((label) => label === '')) throw new Error('地址中的主机名包含空标签。');
  }
  const href = url.href;
  if (href.length > SITE_DOMAIN_MAX_LENGTH) throw new Error(`地址最多 ${SITE_DOMAIN_MAX_LENGTH} 个字符。`);
  return href;
}

// Display label for an address: keeps an explicit non-default http:// visible, otherwise shows host/path/query/fragment.
/** @param {string} value @returns {string} */
export function siteDomainLabel(value) {
  const url = new URL(normalizeSiteDomain(value));
  const path = url.pathname === '/' && !url.search && !url.hash ? '' : url.pathname;
  const suffix = `${url.host}${path}${url.search}${url.hash}`;
  return url.protocol === 'http:' ? `http://${suffix}` : suffix;
}

// Single safe link projection for the UI: canonical href plus a compact label, never reparsed from raw input.
/** @param {string} value @returns {{ href: string, label: string }} */
export function siteDomainLink(value) {
  const href = normalizeSiteDomain(value);
  return { href, label: siteDomainLabel(href) };
}

// Hostname-only label for the compact site identity row (no scheme, port, path, query or fragment).
// Kept separate from siteDomainLink/siteDomainLabel so editors keep showing the full address preview.
/** @param {string} value @returns {string} */
export function siteDomainHostname(value) {
  return new URL(normalizeSiteDomain(value)).hostname;
}

export const siteDomainSchema = z.string().trim().min(1).max(SITE_DOMAIN_MAX_LENGTH, `地址最多 ${SITE_DOMAIN_MAX_LENGTH} 个字符。`)
  .transform((value, ctx) => {
    try { return normalizeSiteDomain(value); }
    catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message }); return z.NEVER; }
  });

// Repository navigation metadata: browser links on recognized providers, never cloned, probed or fetched.
export const SITE_REPOSITORY_LIMIT = 20;
export const SITE_REPOSITORY_MAX_LENGTH = 2048;
export const SITE_NOTES_MAX_LENGTH = 500;
export const SITE_REPOSITORY_HOSTS = Object.freeze({
  'github.com': 'github',
  'cnb.cool': 'cnb',
  'gitee.com': 'gitee',
  'gitcode.com': 'gitcode',
  'hub.gitcode.com': 'gitcode',
});
const SITE_REPOSITORY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// Prototype-safe exact-host lookup: a frozen literal object would otherwise answer for keys such as `__proto__`.
const repositoryProviderForHost = (hostname) => (Object.hasOwn(SITE_REPOSITORY_HOSTS, hostname) ? SITE_REPOSITORY_HOSTS[hostname] : null);

// Canonical repository URL boundary. Bare provider addresses default to HTTPS; an explicitly supplied http:// is
// preserved as submitted. Only exact recognized hosts are accepted; the target keeps its case-sensitive
// path/query/fragment and .git suffix, and no path cutting or alias rewriting happens here.
/** @param {string} input @returns {string} */
export function normalizeSiteRepository(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('仓库地址不能为空。');
  if (/[\0-\x1f\x7f \\]/.test(raw)) throw new Error('仓库地址不能包含空格、反斜杠或控制字符。');
  const candidate = SITE_REPOSITORY_SCHEME.test(raw) ? raw : raw.startsWith('//') ? `https:${raw}` : `https://${raw}`;
  if (candidate.slice(candidate.indexOf('://') + 3).startsWith('/')) throw new Error('仓库地址必须是受支持平台的仓库 URL。');
  let url;
  try { url = new URL(candidate); } catch { throw new Error('仓库地址必须是受支持平台的仓库 URL。'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仓库地址只支持 http:// 或 https://。');
  if (url.username || url.password) throw new Error('仓库地址不能包含用户名或密码。');
  if (!repositoryProviderForHost(url.hostname)) throw new Error(`仓库地址的主机不受支持，仅支持 ${Object.keys(SITE_REPOSITORY_HOSTS).join('、')}。`);
  // The URL parser already removed default ports, so any remaining port is nondefault and rejected.
  if (url.port) throw new Error('仓库地址不能使用非默认端口。');
  // Require owner/group plus repository path; nested/deep paths stay allowed and are never cut.
  if (url.pathname.split('/').filter((segment) => segment !== '').length < 2) throw new Error('仓库地址必须包含所有者/组织与仓库路径。');
  const href = url.href;
  if (href.length > SITE_REPOSITORY_MAX_LENGTH) throw new Error(`仓库地址最多 ${SITE_REPOSITORY_MAX_LENGTH} 个字符。`);
  return href;
}

/** @param {string} value @returns {'github'|'cnb'|'gitee'|'gitcode'|null} */
export function siteRepositoryProvider(value) {
  try { return repositoryProviderForHost(new URL(normalizeSiteRepository(value)).hostname); }
  catch { return null; }
}

// Safe repository projection: canonical href, derived provider and a distinguishable owner/repository path label.
// Throws on invalid input so presentation boundaries render a readable nonlink instead of an unsafe href.
/** @param {string} value @returns {{ href: string, provider: 'github'|'cnb'|'gitee'|'gitcode', label: string }} */
export function siteRepositoryLink(value) {
  const href = normalizeSiteRepository(value);
  const url = new URL(href);
  return { href, provider: repositoryProviderForHost(url.hostname), label: url.pathname.replace(/^\/+|\/+$/g, '') };
}

export const siteRepositorySchema = z.string().trim().min(1).max(SITE_REPOSITORY_MAX_LENGTH, `仓库地址最多 ${SITE_REPOSITORY_MAX_LENGTH} 个字符。`)
  .transform((value, ctx) => {
    try { return normalizeSiteRepository(value); }
    catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message }); return z.NEVER; }
  });

// Optional plain-text remarks; internal newlines survive, ends are trimmed and '' is the empty value.
export const siteNotesSchema = z.string().trim().max(SITE_NOTES_MAX_LENGTH).default('');

/** @param {string[]} items @returns {string[]} */
const dedupeStrings = (items) => items.filter((item, index) => items.indexOf(item) === index);

export const siteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  domains: z.array(siteDomainSchema).max(SITE_DOMAIN_LIMIT).default([]).transform(dedupeStrings),
  tags: tagListSchema,
  repositoryUrls: z.array(siteRepositorySchema).max(SITE_REPOSITORY_LIMIT).default([]).transform(dedupeStrings),
  notes: siteNotesSchema,
  backupJobIds: z.array(z.string().trim().min(1).max(100)).max(SITE_BACKUP_JOB_LIMIT).default([]).transform(dedupeStrings),
});

export const jobSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
  tags: tagListSchema,
  type: z.enum(['directory', 'file', 'vaultwarden', 'system', 'newapi']).default('directory'),
  enabled: z.boolean().default(true),
  sourcePath: z.string().trim().default(''),
  destinations: z.array(destinationSchema).max(10).default([]),
  excludes: z.array(exclusionPattern).max(100).default([]),
  schedule: z.object({
    enabled: z.boolean().default(false),
    cron: z.string().trim().min(1).default('0 3 * * *'),
    timezone: z.string().default('Asia/Shanghai'),
  }).default({}),
  watch: z.object({
    enabled: z.boolean().default(false),
    // full: every change re-archives the whole directory; incremental: watch runs archive only new/modified files.
    mode: z.enum(['full', 'incremental']).default('full'),
    debounceSeconds: z.number().int().min(1).max(300).default(5),
  }).default({}),
  archive: z.object({
    format: z.enum(['tar.gz', '7z', 'zip']).default('7z'),
    encrypted: z.boolean().default(false),
    password: z.string().max(1024).optional(),
    level: z.number().int().min(0).max(9).default(5),
    method: z.enum(['lzma2', 'lzma']).default('lzma2'),
    threads: z.number().int().min(0).max(8).default(0),
    dictionaryMiB: z.union([z.literal(0), z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128), z.literal(256)]).default(0),
    folderTemplate: archiveNameTemplate.refine((value) => value.includes('{datetime}'), '文件夹名必须包含 {datetime}。').default('{datetime}'),
    fileTemplate: archiveNameTemplate.default('{task}'),
  }).default({}),
  retention: z.object({
    days: z.number().int().min(0).max(36500).default(30),
    keepLast: z.number().int().min(1).max(10000).default(7),
  }).default({}),
  retry: z.object({
    attempts: z.number().int().min(1).max(10).default(3),
    delaySeconds: z.number().int().min(1).max(3600).default(10),
  }).default({}),
  notification: z.object({
    start: z.boolean().default(false),
    success: z.boolean().default(true),
    failure: z.boolean().default(true),
  }).default({}),
  vaultwarden: z.object({
    dataDir: z.string().default(''),
    dbType: z.enum(['sqlite', 'postgresql', 'mysql']).default('sqlite'),
    sqlitePath: z.string().default(''),
    rsaKeyPath: z.string().default(''),
    attachmentsPath: z.string().default(''),
    sendsPath: z.string().default(''),
    database: vaultwardenDatabaseSchema,
  }).default({}),

  // new-api keeps authoritative state in one main database plus an optional separate log database.
  // Everything outside those databases (.env, compose, data dir) must travel with the archive too.
  newapi: z.object({
    dataDir: z.string().default(''),
    dbType: z.enum(['sqlite', 'postgresql', 'mysql']).default('sqlite'),
    sqlitePath: z.string().default(''),
    // 'same' means LOG_SQL_DSN is unset, so the log tables live in the main database.
    logDbType: z.enum(['same', 'sqlite', 'postgresql', 'mysql', 'clickhouse']).default('same'),
    logSqlitePath: z.string().default(''),
    database: databaseSchema.default({}),
    logDatabase: databaseSchema.default({}),
    envFilePath: z.string().default(''),
    composeFilePath: z.string().default(''),
    serviceFilePath: z.string().default(''),
    proxyConfigPath: z.string().default(''),
    pluginsPath: z.string().default(''),
    includeLogs: z.boolean().default(false),
    logsPath: z.string().default(''),
    includeLogTable: z.boolean().default(true),
    appVersion: z.string().default(''),
  }).default({}),
});

// Batch creation: one directory task per selected child folder of parentPath, sharing every other setting.
export const batchFolderName = z.string().min(1).max(255).refine(
  (value) => value.trim() === value && !['.', '..'].includes(value) && !/[\\/:\0\r\n]/.test(value),
  '子目录名称无效。',
);
export const batchJobSchema = z.object({
  parentPath: z.string().trim().min(1).max(1024),
  folders: z.array(batchFolderName).min(1).max(100).refine((items) => new Set(items).size === items.length, '子目录不能重复。'),
  nameTemplate: z.string().trim().min(1).max(100).refine((value) => value.includes('{folder}'), '任务名称模板必须包含 {folder}。').default('{folder}'),
  template: z.record(z.unknown()),
});

export const settingsSchema = z.object({
  smtp: z.object({
    enabled: z.boolean().default(false),
    host: z.string().trim().default(''),
    port: z.number().int().min(1).max(65535).default(587),
    mode: z.enum(['starttls', 'tls', 'none']).default('starttls'),
    username: z.string().default(''),
    password: z.string().max(1024).optional(),
    from: z.string().trim().default(''),
    to: z.array(z.string().trim().email()).default([]),
  }).default({}),
  oidc: z.object({
    enabled: z.boolean().default(false),
    issuer: z.string().trim().default(''),
    clientId: z.string().trim().default(''),
    clientSecret: z.string().max(4096).optional(),
    subject: z.string().trim().default(''),
  }).default({}),
  rclone: z.object({
    sourceConfigPath: z.string().default(''),
    configPassword: z.string().max(1024).optional(),
  }).default({}),
  storage: z.object({
    successCleanupMode: z.enum(['immediate', 'manual']).default('immediate'),
    failedRetentionHours: z.number().int().min(0).max(168).default(24),
    maxTempBytes: z.number().int().min(1048576).max(Number.MAX_SAFE_INTEGER).default(10737418240),
  }).default({}),
});

export const defaultSettings = settingsSchema.parse({});

export function newJob(type = 'directory') {
  return {
    ...jobSchema.omit({ name: true, destinations: true }).parse({ type }),
    name: '',
    destinations: [{ remote: '', path: '' }],
  };
}
