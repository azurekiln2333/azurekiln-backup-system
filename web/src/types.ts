import type { z } from 'zod';
import { jobSchema, settingsSchema, siteSchema } from '../../shared/contracts.mjs';

export type JobInput = z.infer<typeof jobSchema>;
/**
 * The custom notification template.
 *
 * The shared `settingsSchema` owns the field; this local declaration keeps the
 * web build honest until that shared field is present in the compiled contract.
 * An empty string means "use the built-in default template".
 */
export interface NotificationTemplate {
  subject: string;
  body: string;
}
export type Settings = z.infer<typeof settingsSchema> & {
  smtp: { passwordSet?: boolean };
  oidc: { clientSecretSet?: boolean };
  rclone: { configPasswordSet?: boolean };
  notification: z.infer<typeof settingsSchema>['notification'] & {
    template?: NotificationTemplate;
  };
};
export interface Job extends JobInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRun?: Pick<Run, 'id' | 'status' | 'phase' | 'startedAt' | 'finishedAt' | 'createdAt' | 'archiveBytes' | 'error' | 'progress'> | null;
  archive: JobInput['archive'] & { passwordSet?: boolean };
  vaultwarden: JobInput['vaultwarden'] & { database: JobInput['vaultwarden']['database'] & { passwordSet?: boolean } };
  newapi: JobInput['newapi'] & {
    database: JobInput['newapi']['database'] & { passwordSet?: boolean };
    logDatabase: JobInput['newapi']['logDatabase'] & { passwordSet?: boolean };
  };
}
/**
 * Site inventory: metadata plus many-to-many links to existing backup jobs.
 *
 * Derived from the shared contract, which owns name/domain/tag validation and
 * canonicalizes each address to an HTTP(S) href. The server owns `id`/timestamps
 * and projects `backupJobIds` from the relation table, so links are never
 * duplicated inside job DTOs.
 */
export type SiteInput = z.infer<typeof siteSchema>;
export interface Site extends SiteInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * Server node the console pushes task definitions to.
 *
 * The node is another installation of this application authenticated with one of
 * its API tokens, so `tokenSet` is the only token fact the API exposes — the
 * token value never returns after it is saved.
 */
export interface NodePathRule {
  /** Prefix as written on this controller. */
  from: string;
  /** Prefix on the node that replaces `from`. */
  to: string;
}
export interface NodeJobOverride {
  /** Mapped sources for one task, overriding the node's path rules. */
  sources: string[];
}
export type NodeSyncStatus = 'succeeded' | 'partial' | 'failed';
export interface NodeSyncJobResult {
  jobId: string;
  jobName?: string;
  /** The node's local task id; present only for a task it accepted. */
  remoteJobId?: string;
  /** `synced` pushed; `unmapped` has no usable path mapping; `failed` was rejected by the node. */
  status: 'synced' | 'unmapped' | 'failed';
  /** Controller-side sources after mapping, when the mapping succeeded. */
  sources?: string[];
  /** Paths that could not be mapped; the task is skipped instead of pushing wrong paths. */
  unmapped?: string[];
  /** Server error code, e.g. `NODE_PATH_MAPPING_FAILED`. */
  code?: string;
  message?: string;
  /** The node stored the definition paused because credentials stay local. */
  paused?: boolean;
}
/** Result of one push, recorded on the node as `lastSync` alongside `lastSyncAt`/`lastStatus`. */
export interface NodeSyncSummary {
  at: string;
  status: NodeSyncStatus;
  total: number;
  synced: number;
  unmapped: number;
  failed: number;
  jobs: NodeSyncJobResult[];
}
export interface AppNode {
  id: string;
  name: string;
  baseUrl: string;
  /** True when a token is stored; the value itself is redacted to `[redacted]` in responses. */
  tokenSet?: boolean;
  enabled: boolean;
  pathRules: NodePathRule[];
  jobOverrides: Record<string, NodeJobOverride>;
  lastSyncAt?: string | null;
  lastStatus?: NodeSyncStatus | null;
  /** Per-task outcome of the latest push; `null` until the node was synced once. */
  lastSync?: NodeSyncSummary | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface NodeInput {
  name: string;
  baseUrl: string;
  /** Omitted or empty on edit keeps the stored token. */
  token?: string;
  enabled: boolean;
  pathRules: NodePathRule[];
  jobOverrides: Record<string, NodeJobOverride>;
}
/** Test response from `POST /api/nodes/:id/test`; a failure is an ApiError, not `ok:false`. */
export interface NodeTestResult {
  ok: true;
  version: string;
  jobs: number;
  message?: string;
}
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface Target {
  destinationId?: string;
  remote: string;
  path?: string;
  remotePath?: string;
  status: string;
  error?: string;
  verification?: string;
}
export interface Run {
  id: string;
  jobId: string;
  jobName: string;
  type: 'directory' | 'file' | 'vaultwarden' | 'system' | 'newapi';
  status: RunStatus;
  phase: string;
  trigger: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  archiveName?: string | null;
  archiveBytes?: number | null;
  progress?: number | { percent?: number; bytes?: number; totalBytes?: number; speed?: number; eta?: number; step?: string; updatedAt?: string } | null;
  error?: string | null;
  warnings?: string[];
  skipped?: string[];
  targets?: Target[];
  cleanupStatus?: string;
  notificationStatus?: string;
  backupKind?: 'full' | 'incremental';
  changes?: { added: number; modified: number; deleted: number; sample: string[] };
  logs?: { id: number; at: string; level: string; message: string }[];
}
export interface Archive {
  runId?: string;
  id?: string;
  archiveName?: string;
  name?: string;
  archiveBytes?: number;
  size?: number;
  createdAt?: string;
  finishedAt?: string;
  targets?: Target[];
  destinationId?: string;
  remote?: string;
  path?: string;
  sha256?: string;
}
export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  user: { username: string } | null;
  csrfToken?: string;
  oidcEnabled: boolean;
  setupTokenRequired: boolean;
}
export interface Remote { name: string; type: string }
export interface SourceEntry { name: string; path: string; isDirectory: boolean; size?: number | null; modifiedAt?: string }
export interface SourceListing { roots: string[]; path: string | null; parent?: string | null; entries: SourceEntry[]; total?: number }
export interface RcloneStatus { available: boolean; configured: boolean; version?: string; configPath?: string; error?: string }
export interface ToolStatus { name?: string; available: boolean; version?: string; error?: string }
export interface Overview {
  jobs: Job[];
  totalJobs: number;
  enabledJobs: number;
  lastSuccessAt?: string | null;
  recentRuns: Run[];
  tools: Record<string, ToolStatus | boolean> | ToolStatus[];
  watchStatus?: Record<string, { state: 'watching' | 'error'; mode?: 'full' | 'incremental'; capturing?: boolean; pending: boolean; error: string | null; lastEventAt: string | null }>;
  storage: LocalStorageStatus;
}
export interface LocalStorageStatus {
  tempBytes: number;
  retainedBytes: number;
  maxTempBytes: number;
  failedRetentionHours: number;
  successCleanupMode?: 'immediate' | 'manual';
  tempDir?: string;
  localArchives: { runId: string; jobName: string; archiveName: string; bytes: number; createdAt: string }[];
}
