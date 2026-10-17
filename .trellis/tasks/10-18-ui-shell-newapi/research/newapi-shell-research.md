# Research: newapi 外壳实现细节(布局 / 圆角 / 侧边栏动画 / 顶栏)

阅读对象:`D:\My2KProjects\new-api\web\src\...`、`D:\My2KProjects\codebuddy2api-ui_template\src\...`、本系统 `web/src/...`。

## 1. 圆角体系

### newapi

`web/src/styles/theme.css`

```
--radius-sm: calc(var(--radius) * 0.6);
--radius-md: calc(var(--radius) * 0.8);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) * 1.4);
--radius-2xl: calc(var(--radius) * 1.8);
--radius-3xl: calc(var(--radius) * 2.2);
--radius-4xl: calc(var(--radius) * 2.6);
```

`--radius` 的默认值写在 preset 里:

- `theme.css:98` — 默认 preset `--radius: 1rem`
- `theme-presets.css:52 / 200 / 345 / 691` — 多个 preset 用 `--radius: 0.5rem`(8px)

用户明确要求「newapi 有一档 0.5(rem)的圆角,参照那一档」。**结论:`--radius = 0.5rem = 8px`**,派生 `sm=4.8px`、`md=6.4px`、`lg=8px`。

### codebuddy2api-ui_template(成功案例,可借鉴)

`src/theme.scss:35-44`

```
/* Radius scale mirrors new-api/web --radius ... */
--radius: 8px;
--radius-sm: calc(var(--radius) * 0.6);
--radius-md: calc(var(--radius) * 0.8);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) * 1.4);
--panel-radius: var(--radius);
--workspace-radius: calc(var(--radius) * 1.4);
```

**它做对的事**:形状与 newapi 完全一致,基准值取 8px,并区分 `--panel-radius` / `--workspace-radius`。
**它做错的事**(需避免):`ui.module.scss:1922 border-radius: 18px`、`:2330 border-radius: 16px` — 少量硬编码大圆角逸出 token;且 `--workspace-radius = 11.2px` 已超过 8px 上限。

> 注意:上面两处 18px/16px 实际是 switch 胶囊(高 18px / 16px),视觉上是「小件全圆」,本身合理 —— 但它暴露了「不写变量就写死数字」这个坏习惯,让审计无法用 grep 判断是否越界。本项目统一用 `calc(<高> / 2)` 或 `999px` 表达「小件全圆」,便于审计。

### 本系统现状(改造前)

`web/src/style.css` 里圆角全是零散写死:

| 值 | 用处 | 备注 |
|---|---|---|
| `10px` | `input.switch` 开关 | 胶囊 |
| `8px` | `.empty-symbol`、`.modal` | 容器 8px,已在上限 |
| `6px` | `.toast-message` | 容器 |
| `5px` | input/select/.button/.icon-button/.notice/.main-nav/.settings-nav/.active-run/.status/.tag-chip/.segmented/.remote-item/.log-view/... | 主体容器与控件都是 5px |
| `4px` | `.nav-count`、`.count`、`.range-row output`、`.admin-avatar`、`.segmented button` | 小件 |
| `3px` | `.segmented button` | 小件 |
| `50%` | `.live-indicator i`、`input.switch:after` | 圆点 |

**结论**:现状容器圆角最大 8px,没有「大圆角」问题;真正的问题是**没有 token**,无法统一与审计。改造目标是把上表映射到 `--radius-*` 体系并保证任何 `border-radius` 都不出现裸数字。

## 2. 侧边栏

### newapi

`web/src/components/ui/sidebar.tsx`

```
const SIDEBAR_WIDTH = '13rem'          // 208px 展开
const SIDEBAR_WIDTH_MOBILE = '17rem'   // 272px 抽屉
const SIDEBAR_WIDTH_ICON = '2.75rem'   // 44px 收起
```

动画(全部 `duration-200 ease-linear`):

- 外层占位:`transition-[width] duration-200 ease-linear`
- 固定面板:`transition-[left,right,width] duration-200 ease-linear`
- 分组标题收起:`transition-[margin,opacity] duration-200 ease-linear` + `group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0`(**用 margin + opacity 做文字淡出,而不是 display:none**,因而不抖动)
- 菜单按钮:`transition-[width,height,padding]`
- 导航项文字:`[&>span:last-child]:truncate`
- 收起态 tooltip:`tooltipEnabled = Boolean(tooltip) && !isMobile && state === 'collapsed'`,`<TooltipContent side='right' align='center' />`,菜单项 `group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!`

状态记忆:`components/layout/components/authenticated-layout.tsx:36`

```
const defaultOpen = getCookie('sidebar_state') !== 'false'
```

**结论**:newapi 用 cookie;本项目要求 `localStorage` + try/catch。

### 导航注册表(数据驱动)

- `layout/types.ts` — `NavItem = NavLink | NavCollapsible | NavChatPresets`,`NavGroup = { id, title, items }`
- `layout/lib/sidebar-view-registry.ts` — 嵌套视图注册表 `SIDEBAR_VIEWS`,`resolveSidebarView(pathname)` 按数组顺序首个匹配
- `components/layout/components/app-sidebar.tsx` —「新增一个嵌套视图只需要在注册表注册;本组件无需改动」

**结论**:本项目只需要「扁平一级导航 + 可选的 badge/计数解析」,不做 newapi 的 drill-in 嵌套视图(本系统只有 6 个一级页面,嵌套视图是过度设计)。注册表保留数据驱动能力:新增页面 = 往 `navItems` 加一行,`Page` 类型从注册表派生。

### 用户明确要删的东西(本系统现状)

`web/src/App.vue`:

- `<div class="sidebar-label">工作空间</div>` → 删除
- `<div class="sidebar-bottom">` 内含 `.admin-avatar` / `.admin-info`(用户名 + 「管理员」)/ 退出按钮 → 整体移除,迁到顶栏头像下拉
- `.workspace-footer`(「AzureKiln Backup」+「© 2026 AzureKiln」)在 `.main-content` 底部 → 删除

> 关于「侧边栏底部的『管理员会话』」:改造前的 App.vue 并没有这个字样,最接近的只有「概览 → 运行环境」里的 `<div class="environment-footer">管理员会话已验证</div>`,以及侧边栏底部的管理员卡片。两处都删。
>
> 关于「管理工作区 / 管理员卡片」:改造前侧边栏只有 `sidebar-label`「工作空间」+ 底部管理员卡片,没有独立卡片组件,同样整体删除。

## 3. 顶栏与账号

### newapi

`components/layout/components/app-header.tsx`

- 左:品牌 `SystemBrand`
- 右:`TopNav`(大屏)、`Search`、`NotificationPopover`、`LanguageSwitcher`、`ConfigDrawer`(主题)、`ProfileDropdown`
- 所有右侧元素统一 `flex shrink-0 items-center gap-1 sm:gap-2`

`components/profile-dropdown.tsx`

- 触发器:`<Avatar className='size-6'>`(24px 圆形)+ `getUserAvatarStyle(avatarName)` 生成的背景色
- 面板:`<DropdownMenuContent align='end' sideOffset={8} className='w-56'>`(224px)
  - 头部:32px 头像 + 名称(`truncate text-sm font-medium`)+ 角色(`text-muted-foreground text-xs`)
  - `<DropdownMenuSeparator />`
  - 菜单项:`Profile`、`Security & Access`、…,最后 `SignOutDialog` 二次确认

**结论**:本项目顶栏 = 左侧(移动端菜单按钮 + 面包屑「管理控制台 › 页面名」)、右侧(在线指示 + 主题切换 + 头像下拉)。头像下拉内含:头像 + 用户名 + 「管理员」角色、分隔线、主题切换、退出登录(点击即退出,不做二次确认 —— 现有实现就是直接退出,保持行为不变以免影响 `check-browser.mjs` 的登录断言)。

### 页面标题重复问题(本系统现状)

```
<header class="topbar">  … <strong>{{ title }}</strong></header>
<header class="page-heading"><div class="page-eyebrow">WORKSPACE</div><h1>{{ title }}</h1></header>
```

**同一个 `title` 出现两次**(顶栏面包屑 + 页面 h1)。这正是用户说的「重复标题」。

`check-browser.mjs` 的 `navigate()` 依赖 `.main-content h1` 出现,所以 **h1 必须保留在 `.main-content` 内**;被移除的是顶栏面包屑里的页面名(改成「管理控制台」固定文案 + 不再重复页面名),即:标题**只在页面 h1 出现一次**。

## 4. 「存储管理页显示 not found」根因分析

`web/src/components/StorageView.vue` 的渲染逻辑:

```
<div v-if="!remotes.length" class="empty-state compact">
  <HardDrive :size="30" /><h3>尚无远端存储</h3>
  <p>{{ status.available ? '未读取到 rclone 远端' : 'rclone 不可用' }}</p>
</div>
```

`PathPicker.vue` 的远端模式:

```
<div v-if="!entries.length" class="picker-empty">{{ error ? '目录不可用' : '没有子目录' }}</div>
```

`api.ts` 的错误文案:

```
throw new ApiError(data?.error?.message ?? `请求失败 (${response.status})`, ...)
```

推断根因:

1. **`StorageView` 自身不会显示 "not found"**;它的空状态是中文。
2. 能出现 "not found" 的是 `PathPicker` 走 `/rclone/directories` 时,后端 `rclone` 返回的原始错误(典型 `directory not found` / `didn't find section in config file`)被 `data.error.message` 原样带到界面 —— 即**后端原始错误文本未经本地化直接呈现**。
3. 另一个来源:`StorageView.load()` 里 `Promise.all([/rclone/status, /settings])` 任一 404/500 都会把 error 塞进 `.notice.error`;若后端返回的是 `{ error: { message: 'not found' } }`,页面顶部就直接显示英文 "not found"。
4. 还有一个**:远端浏览失败后 `error` 面板与空状态同时存在**(`picker-empty` 显示「目录不可用」,同时顶部 `.notice.error` 显示英文原始文本),造成重复提示。

**修复策略(修根因,不遮掩)**:

- 新增 `web/src/errors.ts`:`friendlyError(cause, fallback)` 把已知的英文/底层错误归类为中文可操作文案(404 → 「远端路径不存在,请返回上一级或选择其他目录」;配置缺失 → 「rclone 尚未配置,请先导入配置文件」;网络 → 「无法连接服务,请稍后重试」),**保留原始 message 到 `title` 属性**便于排障。
- `StorageView` / `PathPicker` 用它替代裸 `errorMessage`。
- `PathPicker` 出错时**只显示错误面板**,不再同时渲染空状态;空状态只在「确实没有子目录」时出现。
- `StorageView` 空状态里直接给出下一步入口(导入配置 / 前往设置)。

> 这是「UI 层收敛 + 根因定位」:后端确实会透传底层错误,前端必须负责不把底层错误原样丢给用户。该结论要写进 spec。

## 5. 用户踩过的坑(codebuddy2api 模板)与本项目对应检查点

| 坑 | 本系统是否可能 | 本次处理 |
|---|---|---|
| 面板圆角太大 | 否(最大 8px),但无 token | token 化 |
| 账号卡片上下各一条多余线 | 侧边栏管理员卡片有 `border-top`;移除后不再存在 | 删除卡片 |
| 「全部账号」卡片两条额度条 | 无对应 UI | 巡检概览/任务/执行记录:同一指标只出现一次 |
| 存储管理页 not found | **是** | 见 §4 |
| 侧边栏管理工作区/管理员卡片 | **是** | 删除 |
| 侧边栏展开/收起无动画 | **是**(桌面端根本没有收起功能) | 新增收起 + 200ms 宽度过渡 + 文字淡出 + tooltip |
| 侧边栏底部「管理员会话」 | **是**(近似:概览「管理员会话已验证」+ 管理员卡片) | 删除 |
| 主体底部「AzureKiln · 管理控制台」 | **是**(`.workspace-footer`) | 删除 |

## 6. 本系统重复元素巡检清单(改造前)

| 页面 | 重复项 | 处理 |
|---|---|---|
| 全部页面 | `title` 在顶栏面包屑 + 页面 h1 各一次 | 顶栏改为固定「管理控制台」,标题只在 h1 |
| 概览 | 「系统在线 / N 个执行中」在线指示 + 「运行环境」+「管理员会话已验证」 | 保留顶栏指示与运行环境;删除「管理员会话已验证」 |
| 概览 | 指标卡「备份任务 N 个」+「备份任务 [count]」列表标题 | 保留(不同粒度,一个是数量一个列表),但去掉 h2 里重复的 `.count`?→ 保留 count,因为它是列表条目数而非指标 |
| 任务页 | 无重复标题 | — |
| 执行记录 | 表格「状态 / 阶段」中 status 与 phase 同格,属一次展示 | — |
| 存储 | 错误面板 + 空状态同时出现 | 见 §4 |
| 概览 `page-eyebrow`(WORKSPACE / BACKUP JOBS …) | h1 之上还有英文小标题,与 h1 语义重复 | 删除 `page-eyebrow`(与「不要重复标题」一致) |
| 全站 | `.workspace-footer` | 删除 |

## 7. 关键约束

- `check-browser.mjs` 的锚点(不能破坏):
  - `page.locator('.main-content h1')` — 每页必须有 h1
  - `getByRole('button', { name: '新建任务', exact: true }).first()` — 必须有且按钮名精确
  - `.remote-item`、`.connection-form select`、`.jobs-table tbody tr`、`.dialog-tabs`、`.settings-nav`、`.picker-rows`
  - `page.getByRole('button', { name: '关闭', exact: true })`(Modal)
  - 侧边栏:`.sidebar` / `.sidebar.open`(移动端抽屉),`getByRole('button', {name:'打开导航'})`
  - `screenshot()` 断言 `document.documentElement.scrollWidth <= innerWidth + 1` 且可见控件不出视口
- 移动端断点 850px:抽屉用 `transform: translateX(-100%)`,桌面收起用 `width`,两者不能互相污染。
