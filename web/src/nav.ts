import type { Component } from 'vue';
import { Activity, Folder, FolderOpen, HardDrive, LayoutDashboard, Settings2 } from 'lucide-vue-next';

/**
 * Console navigation registry.
 *
 * Adding a page = adding one row here. The sidebar, the page title, the hash
 * validator and the count badge all read from this array, so no other file
 * needs a matching edit for those concerns. The page body itself still needs a
 * `v-else-if` branch in `App.vue` (templates cannot be fully data-driven).
 *
 * Keep the palette and wording unchanged: this registry owns structure only.
 */
export interface NavItem {
  id: Page;
  label: string;
  icon: Component;
  /** Renders the enabled-task count badge in the sidebar. */
  badge?: 'jobs';
}

export type Page = 'overview' | 'jobs' | 'files' | 'runs' | 'storage' | 'settings';

export const navItems: readonly NavItem[] = [
  { id: 'overview', label: '备份概览', icon: LayoutDashboard },
  { id: 'jobs', label: '备份任务', icon: Folder, badge: 'jobs' },
  { id: 'files', label: '文件管理', icon: FolderOpen },
  { id: 'runs', label: '执行记录', icon: Activity },
  { id: 'storage', label: '远端存储', icon: HardDrive },
  { id: 'settings', label: '系统设置', icon: Settings2 },
];

export const isPage = (value: string): value is Page => navItems.some(item => item.id === value);

/** Title shown once, as the page `<h1>`. The topbar never repeats it. */
export const pageTitle = (page: Page): string => navItems.find(item => item.id === page)?.label ?? navItems[0].label;
