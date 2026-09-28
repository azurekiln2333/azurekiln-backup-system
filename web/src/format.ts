import type { Run } from './types';

export const statusLabels: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  verified: '已验证', uploaded: '已上传', pending: '待处理', skipped: '已跳过', completed: '已完成',
  removed: '已清理', cleaned: '已清理', sent: '已发送', disabled: '未启用', retained: '等待清理', pruned: '已清理',
};
export const phaseLabels: Record<string, string> = {
  queued: '等待执行', preflight: '检查环境', preparing: '准备数据', archiving: '压缩归档', verifying_archive: '校验压缩包',
  uploading: '上传备份', verifying_remote: '验证远端', pruning: '清理过期版本', cleanup: '清理临时文件', completed: '完成',
};
export const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export const shortTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export function bytes(value?: number | null) {
  if (value == null) return '—';
  if (value === 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}
export function duration(run: Run) {
  if (!run.startedAt) return '—';
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function progress(run: Pick<Run, 'progress'>) {
  const value = run.progress;
  const raw = typeof value === 'number' ? value : value?.percent ?? (value?.totalBytes && value.bytes != null ? value.bytes / value.totalBytes * 100 : null);
  return raw == null ? null : Math.min(100, Math.max(0, raw));
}
