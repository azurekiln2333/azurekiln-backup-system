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

export const jobSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
  type: z.enum(['directory', 'vaultwarden', 'system']).default('directory'),
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
    database: z.object({
      host: z.string().default(''),
      port: z.number().int().min(1).max(65535).optional(),
      name: z.string().default('vaultwarden'),
      username: z.string().default('vaultwarden'),
      password: z.string().max(1024).optional(),
      sslMode: z.enum(['default', 'disable', 'require', 'verify-ca', 'verify-full']).default('default'),
      sslCa: z.string().default(''),
      sslCert: z.string().default(''),
      sslKey: z.string().default(''),
    }).default({}),
  }).default({}),
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
