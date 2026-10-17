import { ApiError } from './api';

/**
 * Localize low-level failures before they reach the user.
 *
 * The API layer surfaces `data.error.message` verbatim, and for rclone/HTTP
 * failures that is raw English such as `directory not found` or
 * `didn't find section in config file`. Showing that string as-is is what made
 * the storage page look broken, so every user-facing error string goes through
 * here. The original text stays available for troubleshooting via
 * {@link rawError} and is rendered as a `title` tooltip, not as body copy.
 *
 * A message that matches no rule is returned unchanged: this function
 * classifies, it never hides information.
 */
const rules: readonly (readonly [RegExp, string])[] = [
  [/specify an existing|configuration file|didn't find section|no section|config (file )?(not|does not)|rclone (is )?not configured|no remotes? found/i, 'rclone 尚未配置,请先在「rclone 配置」导入有效的配置文件'],
  [/not found|no such file|does not exist|cannot find the (file|path)|404/i, '远端路径不存在,请返回上一级或选择其他目录'],
  [/permission denied|EACCES|access is denied/i, '没有访问权限,请检查目录或配置文件的权限'],
  [/connection refused|ECONNREFUSED|ECONNRESET|timeout|timed out|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i, '无法连接到远端服务,请检查网络或稍后重试'],
  [/unauthorized|forbidden|401|403/i, '登录状态已失效,请重新登录'],
];

export function rawError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : '';
}

export function friendlyError(cause: unknown, fallback = '操作失败'): string {
  const raw = rawError(cause).trim();
  if (!raw) return fallback;
  // Already-localized API messages (CJK) are our own validation copy: keep them.
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  return rules.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;
}

/** True when the failure is a genuine "this remote path does not exist". */
export const isMissingPath = (cause: unknown): boolean =>
  cause instanceof ApiError ? cause.status === 404 : /not found|no such file/i.test(rawError(cause));
