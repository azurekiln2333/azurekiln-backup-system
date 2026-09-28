import type { z } from 'zod';
import { jobSchema, settingsSchema } from '../../shared/contracts.mjs';

export type JobInput = z.infer<typeof jobSchema>;
export type Settings = z.infer<typeof settingsSchema> & {
  smtp: { passwordSet?: boolean };
  oidc: { clientSecretSet?: boolean };
  rclone: { configPasswordSet?: boolean };
};
export interface Job extends JobInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRun?: Pick<Run, 'id' | 'status' | 'phase' | 'startedAt' | 'finishedAt' | 'createdAt' | 'archiveBytes' | 'error' | 'progress'> | null;
  archive: JobInput['archive'] & { passwordSet?: boolean };
  vaultwarden: JobInput['vaultwarden'] & { database: JobInput['vaultwarden']['database'] & { passwordSet?: boolean } };
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
  type: 'directory' | 'vaultwarden' | 'system';
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
  storage: { tempBytes?: number; usedBytes?: number; maxTempBytes?: number; failedRetentionHours?: number; tempDir?: string };
}
