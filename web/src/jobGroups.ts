import type { Job } from './types';

/** How the task list buckets its rows. `none` keeps one flat list. */
export type GroupMode = 'none' | 'tag' | 'type' | 'source';

export interface JobGroup {
  key: string;
  label: string;
  jobs: Job[];
  /** Jobs in this group whose most recent run failed. */
  failed: number;
}

export interface GroupOptions {
  mode: GroupMode;
  /** Applied before bucketing so search/enable/tag filters and grouping compose. */
  match?: (job: Job) => boolean;
}

export const groupModeLabels: Record<GroupMode, string> = {
  none: '不分组',
  tag: '按标签',
  type: '按类型',
  source: '按源父目录',
};

/** Key of the bucket holding jobs that carry no tags. */
export const UNGROUPED_KEY = '__untagged';

const typeOrder: Job['type'][] = ['directory', 'vaultwarden', 'newapi', 'system'];
const typeLabels: Record<Job['type'], string> = { directory: '目录备份', vaultwarden: 'Vaultwarden', newapi: 'NewAPI', system: '系统配置' };

/** Parent directory of a path, or '' when there is none. Browser-safe (no node:path). */
export function dirname(value: string) {
  const trimmed = value.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index <= 0 ? (index === 0 ? trimmed.slice(0, 1) : '') : trimmed.slice(0, index);
}

/** The path a job's source lives at, mirroring the list's "source" column. */
function jobSource(job: Job) {
  if (job.type === 'system') return '';
  if (job.type === 'vaultwarden') return job.vaultwarden.dataDir;
  return job.sourcePath;
}

/** Cluster key for a job, or UNGROUPED_KEY when the mode has nothing to say about it. */
function bucket(job: Job, mode: GroupMode): { key: string; label: string } {
  if (mode === 'tag') {
    const tag = job.tags?.[0];
    return tag ? { key: `tag:${tag}`, label: tag } : { key: UNGROUPED_KEY, label: '未分组' };
  }
  if (mode === 'type') return { key: `type:${job.type}`, label: typeLabels[job.type] };
  if (mode === 'source') {
    if (job.type === 'system') return { key: 'source:system', label: '本系统配置' };
    const source = jobSource(job);
    const parent = dirname(source);
    return parent ? { key: `source:${parent}`, label: parent } : { key: 'source:root', label: '根目录' };
  }
  return { key: 'all', label: '全部任务' };
}

function isFailed(job: Job) {
  return job.lastRun?.status === 'failed';
}

/**
 * Bucket `jobs` by `mode` after applying `match`.
 *
 * The returned groups always cover every matching job exactly once, so callers can rely on
 * `groups.flatMap(group => group.jobs).length === jobs.filter(match).length`.
 */
export function groupJobs(jobs: Job[], { mode, match }: GroupOptions): JobGroup[] {
  const selected = match ? jobs.filter(match) : jobs.slice();
  const groups = new Map<string, JobGroup>();
  for (const job of selected) {
    const { key, label } = bucket(job, mode);
    const group = groups.get(key);
    if (group) {
      group.jobs.push(job);
      if (isFailed(job)) group.failed += 1;
    } else {
      groups.set(key, { key, label, jobs: [job], failed: isFailed(job) ? 1 : 0 });
    }
  }
  const list = [...groups.values()];
  if (mode === 'type') {
    // Keep the familiar directory → vaultwarden → system order instead of sorting labels.
    return list.sort((a, b) => typeOrder.indexOf(a.jobs[0]!.type) - typeOrder.indexOf(b.jobs[0]!.type));
  }
  return list.sort((a, b) => {
    if (a.key === UNGROUPED_KEY) return 1;
    if (b.key === UNGROUPED_KEY) return -1;
    return a.label.localeCompare(b.label, 'zh');
  });
}

/** Number of jobs in `groups` whose latest run failed. */
export function totalFailed(groups: JobGroup[]) {
  return groups.reduce((sum, group) => sum + group.failed, 0);
}

function storageKey(mode: GroupMode) {
  return `backup-job-groups:${mode}`;
}

/**
 * Collapsed group keys remembered for `mode`.
 *
 * Storage failures (disabled cookies, quota, corrupt JSON) degrade to "nothing collapsed"
 * instead of breaking rendering.
 */
export function readCollapsed(storage: Storage | undefined, mode: GroupMode): Set<string> {
  if (!storage || mode === 'none') return new Set();
  try {
    const raw = storage.getItem(storageKey(mode));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((key): key is string => typeof key === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist `collapsed` for `mode`. Never throws. */
export function writeCollapsed(storage: Storage | undefined, mode: GroupMode, collapsed: Iterable<string>): void {
  if (!storage || mode === 'none') return;
  try {
    storage.setItem(storageKey(mode), JSON.stringify([...collapsed]));
  } catch {
    // Losing the remembered collapse state is acceptable; failing to render is not.
  }
}

/** Selected grouping mode, falling back to `none` for missing or unknown stored values. */
export function readGroupMode(storage: Storage | undefined): GroupMode {
  if (!storage) return 'none';
  try {
    const raw = storage.getItem('backup-jobs-group-mode');
    return raw === 'tag' || raw === 'type' || raw === 'source' ? raw : 'none';
  } catch {
    return 'none';
  }
}

/** Persist the grouping mode. Never throws. */
export function writeGroupMode(storage: Storage | undefined, mode: GroupMode): void {
  if (!storage) return;
  try {
    storage.setItem('backup-jobs-group-mode', mode);
  } catch {
    // Same reasoning as writeCollapsed.
  }
}
