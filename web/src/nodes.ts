import type { AppNode, NodeSyncStatus } from './types';

/**
 * Console-side helpers for the server-node page.
 *
 * Path mapping itself runs on the server: the console must never decide which
 * paths get pushed. What lives here is the honest status projection (including
 * the "never synced" case, which is not a failure) and the base-URL check that
 * runs before a request the server would reject.
 */

export const nodeStatusLabels: Record<NodeSyncStatus, string> = {
  succeeded: '同步成功',
  partial: '部分同步',
  failed: '同步失败',
};

/** Label for a node's latest push; no sync yet is `pending`, never `failed`. */
export function nodeStatusLabel(node: Pick<AppNode, 'lastSyncAt' | 'lastStatus'>): { label: string; className: string } {
  if (!node.lastSyncAt && !node.lastStatus) return { label: '尚未同步', className: 'pending' };
  if (node.lastStatus === 'succeeded') return { label: nodeStatusLabels.succeeded, className: 'succeeded' };
  // Partial results are a warning, not a success: some tasks were skipped.
  if (node.lastStatus === 'partial') return { label: nodeStatusLabels.partial, className: 'queued' };
  if (node.lastStatus === 'failed') return { label: nodeStatusLabels.failed, className: 'failed' };
  return { label: '状态未知', className: 'pending' };
}

/**
 * Normalize the node address to `scheme://host[:port][/path]` without a trailing
 * slash. Credentials and non-HTTP(S) schemes return null so the editor can show
 * a field error instead of sending a request the server rejects.
 */
export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Per-task override sources joined for the editor's one-path-per-line textarea. */
export function overrideText(node: Pick<AppNode, 'jobOverrides'>, jobId: string): string {
  return (node.jobOverrides?.[jobId]?.sources ?? []).join('\n');
}
