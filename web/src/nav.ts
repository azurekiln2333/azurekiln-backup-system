import type { Component } from 'vue';
import { Activity, Folder, FolderOpen, Globe, HardDrive, LayoutDashboard, Settings2 } from 'lucide-vue-next';

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
  /** Section label rendered above the item. Consecutive items sharing a group
   *  collapse into one labelled block, so grouping stays a property of this
   *  single registry rather than a second hand-maintained menu array. */
  group: string;
}

export type Page = 'overview' | 'jobs' | 'sites' | 'files' | 'runs' | 'storage' | 'settings';

export const navItems: readonly NavItem[] = [
  { id: 'overview', label: '备份概览', icon: LayoutDashboard, group: '工作区' },
  { id: 'jobs', label: '备份任务', icon: Folder, badge: 'jobs', group: '工作区' },
  { id: 'sites', label: '站点管理', icon: Globe, group: '工作区' },
  { id: 'files', label: '文件管理', icon: FolderOpen, group: '工作区' },
  { id: 'runs', label: '执行记录', icon: Activity, group: '监控' },
  { id: 'storage', label: '远端存储', icon: HardDrive, group: '系统' },
  { id: 'settings', label: '系统设置', icon: Settings2, group: '系统' },
];

/** Consecutive runs of items sharing `group`, in registry order. */
export interface NavSection {
  label: string;
  items: readonly NavItem[];
}

export const navSections: readonly NavSection[] = navItems.reduce<NavSection[]>((sections, item) => {
  const last = sections.at(-1);
  if (last && last.label === item.group) (last.items as NavItem[]).push(item);
  else sections.push({ label: item.group, items: [item] });
  return sections;
}, []);

export const isPage = (value: string): value is Page => navItems.some(item => item.id === value);

/** Title shown once, as the page `<h1>`. The topbar never repeats it. */
export const pageTitle = (page: Page): string => navItems.find(item => item.id === page)?.label ?? navItems[0].label;
