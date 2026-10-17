# Design: ushell 参照 newapi 重做控制台外壳

依据:`prd.md`、`research/newapi-shell-research.md`、`.trellis/spec/frontend/ui-api.md`。

## 0. 变更通知(2026-10-18)

「令牌管理」页已取消,不属于本项目。导航注册表保留**数据驱动**能力即可,**不预留、不添加**任何令牌管理入口、路由、占位页或注释里的 TODO。

## 1. 边界与文件归属

### 我拥有(可自由改)

| 文件 | 角色 |
|---|---|
| `web/src/style.css` | 圆角 token、侧边栏/顶栏/下拉菜单样式、去冗余样式 |
| `web/src/App.vue` | 外壳结构 + 导航注册表消费 + 顶栏账号下拉 |
| `web/src/nav.ts`(新) | 导航注册表(数据驱动,新增单元) |
| `web/src/errors.ts`(新) | `friendlyError()` 底层错误 → 中文可操作文案 |
| `web/src/components/AccountMenu.vue`(新) | 右上角头像下拉 |
| `web/src/components/StorageView.vue` | R5 修复(非共享文件,归属我) |
| `web/src/components/PathPicker.vue` | R5 修复(错误面板/空状态互斥) |

### 我不改(他人拥有)

`web/src/components/JobEditor.vue`(p2 主人)、`server/*`、`shared/contracts.mjs`。

> `StorageView.vue` / `PathPicker.vue` 未被父任务 prd 列为共享文件,且 R5 明确要求我修存储页,因此由我修改。

### 顺序门禁

**必须等 board.md 出现 `BASELINE-DONE`** 才能改 `App.vue` / `style.css`。
在此之前允许:研究、留底截图、写 `design.md`/`implement.md`、配 jsonl、写**新建文件**(`nav.ts`、`errors.ts`、`AccountMenu.vue`)。新建文件零冲突。

若 `BASELINE-DONE` 迟迟不出现:先完成 §3/§4 的新文件与 `errors.ts` 接线,把 `App.vue`/`style.css` 改动攒成一个原子批次,在 board 记 `BLOCKED` 并写「已选默认方案:继续等待,期间只做新文件与 R5」。

## 2. 圆角体系设计(R1)

### Token

在 `style.css` 的 `:root` 顶部加**唯一的圆角源**,`[data-theme=dark]` 不覆盖(圆角与主题无关):

```css
/* Radius scale mirrors new-api --radius (0.5rem tier). Containers never exceed --radius-lg (8px). */
--radius: 0.5rem;                          /* 8px  — 容器硬上限 */
--radius-sm: calc(var(--radius) * 0.6);    /* 4.8px → 徽标、计数、小标签 */
--radius-md: calc(var(--radius) * 0.8);    /* 6.4px → 输入框、按钮、下拉项 */
--radius-lg: var(--radius);                /* 8px   → 面板、卡片、弹窗 */
--radius-pill: 999px;                      /* 仅徽标/开关/头像/圆点 */
```

### 映射表(改造前 → 改造后)

| 选择器 | 旧值 | 新值 | 理由 |
|---|---|---|---|
| `input, select, textarea` | `5px` | `var(--radius-md)` | 控件 |
| `.button` | `5px` | `var(--radius-md)` | 控件 |
| `.icon-button` | `5px` | `var(--radius-md)` | 控件 |
| `.notice` | `5px` | `var(--radius-md)` | 内联提示,控件级 |
| `.main-nav button` | `5px` | `var(--radius-md)` | 导航项 |
| `.settings-nav button` | `5px` | `var(--radius-md)` | 导航项 |
| `.active-run` | `5px` | `var(--radius-lg)` | 卡片 |
| `.remote-item` | `5px` | `var(--radius-lg)` | 卡片 |
| `.log-view` | `5px` | `var(--radius-md)` | 代码块 |
| `.job-symbol` / `.admin-avatar` | `5px` | `var(--radius-md)` | 图标瓦片 |
| `.segmented` | `5px` | `var(--radius-md)` | 控件组 |
| `.segmented button` | `3px` | `var(--radius-sm)` | 内嵌项 |
| `.empty-symbol` | `8px` | `var(--radius-lg)` | 容器 |
| `.modal` | `8px` | `var(--radius-lg)` | 容器 |
| `.toast-message` | `6px` | `var(--radius-md)` | 浮层小件 |
| `.status` | `4px` | `var(--radius-sm)` | 徽标 |
| `.tag-chip` | `4px` | `var(--radius-sm)` | 徽标 |
| `.count` / `.nav-count` | `4px` | `var(--radius-sm)` | 徽标 |
| `.range-row output` | `4px` | `var(--radius-sm)` | 小件 |
| `.tag-input` | `5px` | `var(--radius-md)` | 控件 |
| `.account-menu`(新) | — | `var(--radius-lg)` | 容器 |
| `.account-menu button`(新) | — | `var(--radius-md)` | 菜单项 |
| `input.switch` | `10px` | `var(--radius-pill)` | 开关(高 18px,胶囊) |
| `.live-indicator i` / `input.switch:after` / `.avatar` | `50%` | `var(--radius-pill)` | 圆点/头像 |

### 硬约束的机械化校验

`scripts/ui-radius-audit.mjs`(**不新增 npm script**,避免与其他 pi 冲突;由人工/CI 手动跑):

- 扫描 `web/src/**/*.{vue,css}` 里所有 `border-radius` 声明
- 允许值:`var(--radius-*)`、`0`、`inherit`、`calc(...)`
- 禁止:任何裸 `px` / `rem` / `%` 数字(除 `border-radius: 0`)
- 输出违规清单,非空则 exit 1

> 这个脚本放 `scripts/` 属于共享目录,但**新建文件**不冲突。若 `BASELINE-DONE` 前不想碰 `scripts/`,就先放 `web/src/../` 不方便 → 决定:放 `scripts/ui-radius-audit.mjs`,只新增文件不改 `package.json`。

## 3. 侧边栏设计(R2)

### 两套形态,互不干扰

| 断点 | 形态 | 收起机制 |
|---|---|---|
| `> 850px` | 常驻侧边栏 | `width: var(--sidebar-width)`;收起时 `width: var(--sidebar-width-collapsed)` |
| `<= 850px` | 抽屉 | `transform: translateX(-100%)` ↔ `translateX(0)`(现有 `.open` 语义不变) |

```css
:root {
  --sidebar-width: 226px;
  --sidebar-width-collapsed: 68px;
  --sidebar-motion: 200ms ease;   /* 与 newapi duration-200 ease-linear 对齐,改 ease 让淡出更自然 */
}
```

### 状态与记忆

```ts
const STORAGE_KEY = 'backup-sidebar-collapsed';
const collapsed = ref(readCollapsed());
function readCollapsed() { try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; } }
watch(collapsed, value => { try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch { /* 隐私模式忽略 */ } });
```

### 动画细节(照 newapi,不抖动)

1. `.sidebar { transition: width var(--sidebar-motion); }`
2. `.workspace { margin-left: …; transition: margin-left var(--sidebar-motion); }`
3. **文字淡出用 `opacity` + `max-width`,不用 `display:none`**(display 切换会瞬间跳变):
   ```css
   .main-nav button > span:not(.nav-count) {
     opacity: 1; max-width: 140px;
     transition: opacity var(--sidebar-motion), max-width var(--sidebar-motion);
     overflow: hidden; white-space: nowrap;
   }
   .sidebar.collapsed .main-nav button > span:not(.nav-count) { opacity: 0; max-width: 0; }
   ```
4. 品牌文字 `.brand > div`、`.sidebar-label` 同样处理;`.sidebar-label` 收起时 `height/opacity → 0`(不留空隙)。
5. 导航项在收起态:`justify-content: center; padding-inline: 0;` + `width: 40px; margin-inline: auto`,与 newapi `group-data-[collapsible=icon]:size-8!` 等价。
6. `overflow` — `.sidebar { overflow-x: hidden }`,防止过渡期间内容溢出产生横向滚动条(会让 `check-browser` 的 `scrollWidth <= innerWidth` 断言炸掉)。
7. `prefers-reduced-motion`:已有全局规则把 `transition-duration` 压到 `.01ms`,满足要求,无需额外代码;但要确保动画**只**依赖 transition,不用 keyframes。
8. 收起态 tooltip:给导航按钮加 `:title="collapsed ? item.label : undefined"`(原生 tooltip,零 JS,零布局抖动)。
9. 收起按钮:侧边栏底部(原管理员卡片位置)放一个独立的「收起/展开导航」按钮,**不写「管理员会话」**。

### 导航注册表(`web/src/nav.ts`)

```ts
import { Activity, Folder, FolderOpen, HardDrive, LayoutDashboard, Settings2 } from 'lucide-vue-next';
import type { Component } from 'vue';

export type PageId = 'overview' | 'jobs' | 'files' | 'runs' | 'storage' | 'settings';
export interface NavItem { id: PageId; label: string; eyebrow?: string; icon: Component; badge?: 'jobs' }
export const navItems: readonly NavItem[] = [
  { id: 'overview', label: '备份概览', icon: LayoutDashboard },
  { id: 'jobs',     label: '备份任务', icon: Folder, badge: 'jobs' },
  { id: 'files',    label: '文件管理', icon: FolderOpen },
  { id: 'runs',     label: '执行记录', icon: Activity },
  { id: 'storage',  label: '远端存储', icon: HardDrive },
  { id: 'settings', label: '系统设置', icon: Settings2 },
];
export type Page = NavItem['id'];
export const isPage = (value: string): value is Page => navItems.some(item => item.id === value);
export const pageTitle = (page: Page) => navItems.find(item => item.id === page)?.label ?? navItems[0].label;
```

- `Page` 类型由注册表派生 → 新增页面只加一行,`App.vue` 的渲染分支仍需加一个 `<template v-else-if>`(模板无法完全数据驱动,这是 Vue 的现实;但导航、标题、计数、图标、路由校验全部自动)。
- `badge: 'jobs'` 让「任务数」徽标也有数据来源,而不是硬编码 `item.id === 'jobs'`。
- **不预留给令牌管理的任何分支**。

## 4. 顶栏与账号设计(R3)

### 结构

```
<header class="topbar">
  <div class="topbar-left">
    <button 打开导航>            <!-- 仅移动端可见 -->
    <div class="breadcrumb">管理控制台 <ChevronRight/> <strong>{{ title }}</strong></div>  <!-- 见下 -->
  </div>
  <div class="topbar-actions">
    <span class="live-indicator">…</span>
    <button 主题切换>            <!-- 保留 label 深色主题/浅色主题 -->
    <AccountMenu :username="auth.user?.username" :theme="theme" @toggle-theme :logout />
  </div>
</header>
```

### 标题只出现一次(关键决策)

PRD 要求「页面标题只出现一次(顶栏的面包屑/标题),页面内部不再重复同名标题」,而 `check-browser.mjs` 的 `navigate()` 依赖 `.main-content h1`。

**默认方案(已选)**:保留页面内 `<h1>{{ title }}</h1>`(兼容浏览器断言 + 更符合内容型控制台),把**顶栏面包屑里的页面名去掉**,改成固定定位标签:

```
<div class="breadcrumb"><span class="workspace-label">管理控制台</span></div>
```

- 全站 `<h1>` 只出现一次/页;顶栏不再重复页面名。
- 面包屑在 `mobile-menu` 旁边仍提供上下文(移动端 `workspace-label` 保留)。
- 顺带删除 `.page-eyebrow`(WORKSPACE / BACKUP JOBS 等英文小标题)——它与 h1 语义重复,属于「重复标题」。

> 若日后需要顶栏显示路径,只需在 `breadcrumb` 里加 `{{ title }}` 并把页面 h1 换成 `<h2>`,同时改 `check-browser.mjs`;本次不改测试脚本。

### AccountMenu(新组件)

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { LogOut, Moon, Sun } from 'lucide-vue-next';
defineProps<{ username?: string; theme: string }>();
const emit = defineEmits<{ 'toggle-theme': []; logout: [] }>();
const open = ref(false);
const root = ref<HTMLElement>();
function outside(event: MouseEvent) { if (open.value && !root.value?.contains(event.target as Node)) open.value = false; }
function escape(event: KeyboardEvent) { if (event.key === 'Escape') open.value = false; }
onMounted(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape); });
onBeforeUnmount(() => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); });
</script>
```

要求:

- 触发器:`<button class="account-trigger" :aria-label="\`账号菜单 ${username}\`" :title="username" aria-haspopup="menu" :aria-expanded="open">` + `.avatar`(首字母大写,`var(--radius-pill)`)+ `ChevronDown`。
- 面板:`.account-menu`,**`position: absolute; right: 0; top: calc(100% + 8px); width: 224px`**(与 newapi `w-56` 对齐);`z-index` 高于 topbar。
- 头部:头像 + 用户名(`truncate`)+ 「管理员」;与面板之间**一条** `border-bottom`(只一条,对应「账号卡片上下各一条多余线」的坑:头部用 `border-bottom`,`<hr>` 不再额外加)。
- 菜单项:主题切换(显示当前主题的反向动作 `Sun`/`Moon`)、分隔线、退出登录(`LogOut`)。
- **退出登录必须在菜单项里可直接点到**:`check-browser.mjs:499` 只做 `getByRole('button', {name:'退出登录'}).click()`,没有先开菜单。两种兼容做法:
  1. `.account-menu` 常驻 DOM + `hidden` 属性控制(collapsed 不渲染)→ `getByRole` 找不到 hidden 元素,**会失败**。
  2. 改成 `v-show`(display:none)→ Playwright 仍视为不可见,**会失败**。

**默认方案(已选)**:菜单展开由 `open` 控制,但**在 `check-browser.mjs` 里这是黑盒**。为同时满足「右上角头像下拉」与「不破坏既有断言」:

- 触发器按钮与菜单项**在首次点击触发器后**渲染;`check-browser.mjs:499` 之前的最后一次交互是 `page.getByRole('button', { name: 'directory-a', exact: true }).click()`(文件页内),不会打开账号菜单。
- 因此**必须修改 `check-browser.mjs`**,在 `.click()` 前加 `await page.getByRole('button', { name: /账号菜单/ }).click()`。

`scripts/check-browser.mjs` 是共享文件且**当前已被其他 pi 修改**(`git status` 显示 ` M scripts/check-browser.mjs`)。父任务规则要求避免冲突。

**最终默认方案(降冲突风险)**:保留一个**语义与位置都合规的常驻退出按钮**:
- 顶栏右侧依次渲染:在线指示 → 主题切换 → 头像(打开账号下拉)→ 其右侧**不再有单独退出按钮**;
- 账号下拉内的退出按钮作为**唯一**退出入口;
- 同一次提交里对 `scripts/check-browser.mjs` 做**最小插入**(1 行 `await page.getByRole('button', { name: /账号菜单|账号/ }).click();`),因为 R3 的验收就是「退出挪到右上角下拉」,不改测试无法验证新设计。

> 结论写进 board 的 `BLOCKED` 行:默认方案 = 改 `check-browser.mjs` 一行以适配「退出收进下拉」,若他人正在改同一区域则等我方批次提交后再插入。

## 5. 去重与清理(R4)

| 项 | 处理 |
|---|---|
| `.workspace-footer`(「AzureKiln Backup」+「© 2026 AzureKiln」) | 删除 DOM + CSS |
| `.sidebar-label`(「工作空间」) | 删除 |
| `.sidebar-bottom`(管理员卡片:头像 + 用户名 + 管理员 + 退出) | 删除,迁入 `AccountMenu` |
| `.environment-footer`(「管理员会话已验证」) | 删除 DOM + CSS |
| `.page-eyebrow`(英文小标题) | 删除 DOM + CSS |
| 顶栏面包屑里的页面名 | 删除(见 §4) |
| `.admin-avatar` / `.admin-info` CSS | 删除(被 `.avatar` 取代) |
| 存储页错误 + 空状态双显 | 修(Picker 互斥) |
| 概览「备份任务 N 个」指标 + 「备份任务 [count]」列表 | 保留(粒度不同,非重复) |

## 6. R5 存储页 "not found" 根因与修法

见 `research/newapi-shell-research.md` §4。落地:

```ts
// web/src/errors.ts
const rules: [RegExp, string][] = [
  [/not found|no such file|didn't find|does not exist/i, '远端路径不存在,请返回上一级或选择其他目录'],
  [/didn't find section|no section|config.*not exist|rclone.*未配置/i, 'rclone 尚未配置,请先在「rclone 配置」导入配置文件'],
  [/connection refused|ECONNREFUSED|timeout|ETIMEDOUT/i, '无法连接到远端服务,请检查网络或稍后重试'],
];
export function friendlyError(cause: unknown, fallback = '操作失败'): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (!raw) return fallback;
  const hit = rules.find(([pattern]) => pattern.test(raw));
  return hit ? hit[1] : raw;   // 未命中不等于要吞掉,原样返回
}
export function rawError(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause ?? ''); }
```

- `StorageView`:`error.value = friendlyError(cause)`;错误面板加 `:title="raw"`。
- `PathPicker`:同样;并把 `error` 与空状态改为互斥:
  ```
  <div v-else-if="error" class="picker-empty">…</div>   <!-- 不再同时出现 .notice.error + 空状态? -->
  ```
  实际做法:`PathPicker` 顶部 `.notice.error` 保留(带重试),`picker-rows` 空态文案改为 `error ? '' : '没有子目录'`,即**出错时不渲染空状态**。
- `StorageView` 空状态补「前往设置」/「导入配置」跳转按钮(已在同页,直接用 `#settings` 锚点太远 → 改为聚焦导入表单:`importSection?.scrollIntoView()`)。

## 7. 兼容性/回归风险

| 风险 | 缓解 |
|---|---|
| 侧边栏收起后 `check-browser` 的控件出视口断言 | 收起态导航按钮仍完整可见(仅文字隐藏),`box.right <= 0` 豁免已存在 |
| `scrollWidth > innerWidth` 因过渡中溢出 | `.sidebar { overflow-x: hidden }` + 过渡只改 width/margin |
| 移动端 `.sidebar.open` 语义被 collapsed 污染 | collapsed 只在 `min-width: 851px` 生效(`@media` 内声明) |
| 账号下拉遮挡 toast | `z-index`: backdrop 100、topbar 20 → 下拉 `z-index: 25`;toast 200 更高 |
| `深色主题` 按钮从 topbar 移到菜单里 → 测试第 493 行失败 | **保留 topbar 上的主题切换按钮**,菜单里再放一份(不同 `aria-label`:菜单项叫「切换到深色/浅色主题」),避免与 `getByRole({name:'深色主题'})` 冲突 |
| h1 被删 → 测试炸 | h1 保留 |

> 主题切换:topbar 的按钮保持 `aria-label="深色主题"`/`"浅色主题"`(唯一精确匹配);账号菜单里的主题项用不同文案,不产生 strict mode 多重匹配。

## 8. 提交切片(每片可独立验证并立即提交)

1. `refactor(ui): tokenize border radius scale` — 仅 `style.css` 圆角 token + 映射 + `scripts/ui-radius-audit.mjs`
2. `refactor(ui): extract navigation registry` — `web/src/nav.ts` + App.vue 改为消费注册表(无视觉变化)
3. `feat(ui): collapsible sidebar with persisted state` — 侧边栏收起/展开 + 动画 + tooltip + 记忆;删除工作空间标签/管理员卡片/管理员会话
4. `feat(ui): move account controls into topbar dropdown` — `AccountMenu.vue` + 顶栏改造 + 标题去重 + 删页脚
5. `fix(ui): localize storage errors and dedupe empty states` — `errors.ts` + StorageView + PathPicker
6. `test(ui): open account menu before signing out` — `scripts/check-browser.mjs` 一行适配
7. `docs(spec): record shell conventions` — `.trellis/spec/frontend/ui-api.md`

每片提交后跑 `npm run check`;第 2/3/4 片后 `npm run build`;全部完成后 `npm test` + `npm run check:browser`。

## 9. 回滚

- 每片一个 commit,`git revert <sha> -- <paths>` 可独立回滚。
- `style.css` 圆角片与结构片分离,即使结构回滚,圆角 token 仍可独立保留。
- `errors.ts` 为新增文件,回滚只需把两个调用点换回 `errorMessage`。
