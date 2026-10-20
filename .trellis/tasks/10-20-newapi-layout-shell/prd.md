# layout: 照 newapi 布局架构重做控制台

负责 pane:**w1H:p4**。父任务:`10-18-ui-revamp-newapi-backup`。

## 背景 / 为什么要重做

p3 的上一轮改造只动了**壳层细节**（圆角 token、侧边栏收起动画、账号挪右上角、去重），
但**布局架构没动**：仍是「侧边栏固定贴左 + 内容区平铺 `margin-left`」的老结构。

用户明确指出：要的是**照 newapi 的布局架构**整体重做，包括：
- 侧边栏的项目宽度
- 内容区域的布局

## 权威参数（实测 newapi + codebuddy2api 成功案例，两者一致）

| 项 | newapi 值 | 依据 |
|---|---|---|
| 侧边栏宽度 | `13rem` = **208px** | `web/src/components/ui/sidebar.tsx:50 SIDEBAR_WIDTH` |
| 收起宽度 | `2.75rem` = **44px** | `:52 SIDEBAR_WIDTH_ICON` |
| 移动抽屉 | `17rem` = 272px | `:51 SIDEBAR_WIDTH_MOBILE` |
| 侧边栏切换动画 | `transition-[width] duration-200 ease-linear` | `:241` |
| inset 工作区 | `m-2 ml-0 rounded-xl shadow-sm`，收起时 `ml-2` | `:330 SidebarInset` |
| 顶栏高度 | `--app-header-height`，贯穿**全宽**，侧边栏从其下方开始 | `:253 fixed top-[var(--app-header-height)]` |
| 内容最大宽度 | `max-width: 1600px` 居中 | codebuddy2api `.main` |
| 内容 padding | `20px 24px 28px` | codebuddy2api `.main` |

圆角：newapi 基础 `--radius: 1rem`，但**本项目父任务硬约束容器 ≤8px**，
故取 `--radius: 8px`，`--radius-lg = 8px`，`--workspace-radius = 11.2px`(=8×1.4，
与 newapi `rounded-xl` 同比例)。这与 codebuddy2api 的做法完全一致。

## 需求（R1–R6）

### R1 inset shell 布局模型（核心）
- 顶栏 `.header`：`sticky top:0`，高 48px，**横向贯穿全宽**，含品牌 + 收起按钮 + 面包屑 + 状态 + 主题 + 账号菜单。
- 侧边栏 `.sidebar`：`position: fixed; inset: 48px auto 0 0`（从顶栏下方开始），宽 208px，收起 44px。
- 内容区 `.workspace`：**独立浮起卡片** `margin: 8px 8px 0 calc(var(--sidebar-width) + 8px)`，
  `border: 1px solid var(--line)`、`border-radius: var(--workspace-radius)`、
  `background: var(--surface)`、`box-shadow: 0 1px 3px var(--shadow)`。
- 收起时 `.workspace { margin-left: calc(44px + 8px) }`，全程 `transition: margin var(--sidebar-motion)`。
- 移动端（≤900px）：侧边栏变抽屉（`transform: translateX(-100%)` + 遮罩），`.workspace` 无左 margin。

### R2 侧边栏规格
- 宽度 208/44px（当前 226/68 偏宽，必须改）。
- 导航项：`min-height: 36px`、`padding: 7px 10px`、`gap: 9px`、`border-radius: var(--radius-md)`、
  图标 16px（当前 19px 偏大）。
- 分组标签 `.navGroup` + `.navLabel`（11px、`margin: 0 10px 6px`、收起时淡出）。
- 收起态：图标居中、文字 `opacity:0 + max-width:0`、保留 `title` tooltip。
- 尊重 `prefers-reduced-motion`。

### R3 统一 panel 体系
- `.panel`：`border: 1px solid var(--line)` + `border-radius: var(--panel-radius)` + `overflow: hidden` + `background: var(--surface)`。
- `.panel-heading`：`min-height: 58px`、`padding: 16px 20px`，左侧标题 + 右侧操作。
- `.panel-body`：`padding: 0 20px 20px`。
- `.table-wrap`：`overflow: auto`、`overscroll-behavior-inline: contain`，表头 `position: sticky; top: 0; background: var(--soft)`。
- 替代现有 `.page-band` / `.section-heading`，逐页替换。

### R4 统计区
- `.stats`：`grid-template-columns: repeat(4, minmax(0,1fr))`、`gap: 0`、无边框无背景
  （`background: transparent; border: 0`），靠间距分隔，不是四个带框卡片。
- `.stat`：`padding: 18px 20px`；标签行 12px muted + 右侧 24px 图标；
  数字 `font-size: 26px; font-weight: 550; font-variant-numeric: tabular-nums`；说明 12px muted。

### R5 内容栅格
- `.content-grid`：`grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr)`（主内容 + 侧栏）。
- `.form-grid` / `.grid`：2 列 `gap: 16px`。
- `.main`：`max-width: 1600px; margin: 0 auto; padding: 20px 24px 28px`。

### R6 硬约束（不得违反）
- **色调不变**：`--blue / --green / --surface / --page` 等现有颜色 token 全部保留原值。
- **不出现重复元素/重复标题**：`<h1>` 全站只出现一次（`.main` 内）；顶栏面包屑不重复页面名。
- **圆角 ≤8px**（容器）；仅徽章/开关/头像可用 pill。
- **不得改崩任何既有功能**：所有页面流程（任务 CRUD、执行、下载、设置、文件浏览、分组、批量）必须完好。
- 遵循 `.trellis/spec/frontend/ui-api.md`。

## 实施顺序（逐页可验证）

1. 布局骨架：`style.css` token + `.app` / `.header` / `.sidebar` / `.workspace` / `.main`；
   `App.vue` 结构调整（顶栏贯穿、侧边栏移到顶栏之后、workspace 包住 main）。
2. `.panel` / `.stats` / `.content-grid` 体系落地。
3. 逐页替换：overview → jobs → runs → files → storage → settings。
4. Modal / RunDetail / JobEditor / PathPicker 的面板规范化。
5. 移动端 + 暗色主题巡检。

## 验收标准

- [ ] 侧边栏 208px / 收起 44px；顶栏 48px 贯穿全宽；内容区为浮起圆角卡片（inset shell）。
- [ ] 统计区 4 列透明网格（无边框卡片），数字 26px。
- [ ] `.panel` 体系统一，全站无遗留 `.page-band` 样式冲突。
- [ ] `.main` max-width 1600px 居中。
- [ ] 色调 token 未改；`<h1>` 全站仅一处；容器圆角 ≤8px。
- [ ] `npm run check`、`npm test`、`npm run build`、`npm run check:browser` 全绿。
- [ ] 桌面 1440 / 768 / 390 / 360 四档截图逐页核对，无横向溢出。
- [ ] 分批路径限定提交，每步立刻提交。

## 文件归属

- 本任务**拥有** `web/src/App.vue`、`web/src/style.css`（p3 已发 `ALL-DONE` 并释放）。
- 其他组件（`JobsView.vue` 等）只在必要时做**最小**样式类名替换并立刻提交。
