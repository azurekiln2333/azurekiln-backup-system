# ui-shell-newapi:参照 newapi 重做控制台外壳

负责 pane:**w1H:p3**。父任务:`10-18-ui-revamp-newapi-backup`(先读它的 prd.md 全局规则)。

## 参考

- newapi 前端源码:`D:\My2KProjects\new-api`(重点看布局、侧边栏、顶栏、圆角 token、侧边栏动画)。
- 成功案例:`D:\My2KProjects\codebuddy2api-ui_template`(照着 newapi 改的)。**学它的做法,但避开它的缺陷**(见下)。
- 本系统当前外壳:`web/src/App.vue`、`web/src/style.css`、`web/src/components/*.vue`。

## 需求

### R1 圆角体系
- 面板/卡片/弹窗等容器圆角取 newapi 的 **0.5(rem)** 那一档,或 MD3 标准圆角。落成 CSS token(如 `--radius-sm/md/lg`),全站统一引用,**不允许**零散写死大圆角。
- 硬上限:容器圆角不超过 8px(0.5rem);输入框/按钮可更小;仅徽标、开关、头像这类小件允许全圆。
- 全站巡检:含 Modal、RunDetail、SettingsView、StorageView、FileManagerView、PathPicker、JobEditor 里的所有面板与卡片。

### R2 侧边栏
- 移除「管理工作区 / 管理员」卡片。
- 移除侧边栏底部的「管理员会话」。
- 展开/收起要有**动画**(参考 newapi:宽度过渡 + 文字淡入淡出,不抖动、不闪烁);尊重 `prefers-reduced-motion`;收起态保留图标与 tooltip;状态记忆(`localStorage`,try/catch)。
- 移动端抽屉行为保持可用。
- 导航项做成**数据驱动的注册表**,以便后续新增「令牌管理」等页面时只加一行。

### R3 顶栏与账号
- 参考 newapi:头像 / 账号名 / 退出登录收进**右上角**的头像下拉菜单(退出、可放主题切换等已有功能)。
- 页面标题只出现**一次**(顶栏的面包屑/标题),页面内部不再重复同名标题。

### R4 去重与清理
- 删除主体内容底部的「AzureKiln · 管理控制台」。
- 逐页巡检并删除重复元素:重复标题、重复统计、重复进度条、卡片上下多余的分隔线/双边框(用户在模板里踩过的坑:账号卡片上下多出两条线、「全部账号」出现两条额度条)。
- 本系统的概览、任务、执行记录、存储、文件、设置各页都要检查一遍,**同一指标只展示一次**。

### R5 存储管理页不得出现 "not found"
- 先用真实后端复现:StorageView 的接口路径、空数据、未配置 rclone 等情况下,页面不得显示 "not found" 之类的原始错误。
- 定位根因(路由?空状态?404 被当错误展示?),修根因而不是遮掩;空状态给出友好的中文提示与下一步入口。

### R6 色调与稳定性
- **色调保持本系统原样**(颜色 token 不动,亮/暗主题如已有则保持)。
- **不要改崩任何已有界面与流程**。改前先用 `npm run check:browser` 的截图能力给每个页面留底(放 `.artifacts/ui-before/`,不提交),改后逐页对比。
- 遵循 `.trellis/spec/frontend/*`(特别是 ui-api.md、component-guidelines.md、quality-guidelines.md)。

## 文件归属与顺序

- 你是 `web/src/App.vue`、`web/src/style.css` 的主人。**等 board 出现 `BASELINE-DONE`(jobs-batch-grouping 提交完它的 WIP)后才能改这两个文件**;在此之前做:研究 newapi、留底截图、写 `design.md`/`implement.md`、配 jsonl。
- 你完成外壳后立刻提交并在 board 写 `SHELL-DONE`(同时写明导航注册表的用法),其他子任务才会接线他们的页面。
- 之后你负责:收尾时对整个应用做最终回归,并在 board 写 `ALL-DONE`。

## 验收标准

- [ ] 圆角 token 化,全站容器 ≤ 8px,无遗留大圆角。
- [ ] 侧边栏无工作区/管理员卡片、无「管理员会话」;展开/收起有平滑动画与记忆。
- [ ] 账号/退出在右上角;页面标题只出现一次;底部「AzureKiln · 管理控制台」已删除。
- [ ] 全站无重复标题/重复指标/多余分隔线;存储页不再出现 "not found",且有根因说明。
- [ ] 色调未变;所有既有页面功能完好;`npm run check`、`npm test`、`npm run build`、`npm run check:browser` 全绿。
- [ ] 分批提交且已立刻提交;更新 `.trellis/spec/frontend/ui-api.md`。
