# p2 → p3 (ui-shell-newapi) 互审

审查范围:`d16529e` `83972b1` `8cd2128` `9aeb3c9` `6f28176` `e094088`(p3 全部提交)。
审查人:w1H:p2(jobs-batch-grouping)。审查时间:本会话。

## 结论:通过,无阻塞问题

## 正面确认

1. **导航注册表抽取(`d16529e`)** — `web/src/nav.ts` 成为唯一页面声明处,`Page` 类型从注册表派生,`isPage()` 做运行时校验,`pageTitle()` 提供标题。消除了 App.vue 里 `navItems` 与 `Page` 类型的两处重复。这是正确的去重方向。
2. **标题去重(`8cd2128`)** — `.main-content h1` 现在只出现一次(我已在真实浏览器专项回归中实测:`document.querySelectorAll('.main-content h1').length === 1`,文本为「备份任务」)。顶栏面包屑只保留「管理控制台」,不再重复页面名。满足父任务 PRD「不要出现重复元素、重复标题」。
3. **侧边栏收起** — `backup-sidebar-collapsed` 用 `'1'`/`'0'` 存储,try/catch 包裹(inline 注释说明 private mode),与我的 `backup-job-groups:*` 保持一致的容错风格。
4. **圆角 token(`83972b1`)** — 定义 `--radius-sm/md/lg/pill` 并提供 `scripts/ui-radius-audit.mjs` 做机械化审计。这个做法值得保留:它在我的 `jobs-groups.css` 里查出 3 处裸圆角,我已改为 `var(--radius-md)` / `var(--radius-pill)`,现在全仓审计通过。
5. **storage 空态去重(`9aeb3c9` `6f28176`)** — 两个同名「导入 rclone 配置」按钮改为区分语义的空态按钮,相关错误走 `friendlyError` 本地化。`6f28176` 是一行改名,提交粒度恰当。

## 观察(非阻塞,无需修复)

1. `8cd2128` 同批次修改了 `scripts/check-browser.mjs`(1 行),用于适配账号菜单里的退出入口。这让该文件在两个 pane 之间被共享修改;父任务规则里 `check-browser.mjs` 未明确归属。后续建议把「浏览器脚本因 UI 结构变化需要的适配」集中到一次提交,降低并行冲突面。
2. `AccountMenu.vue` 独立承担头像/用户名/管理员/主题/退出,组件边界清晰。我在真实浏览器验证中确认 Escape 可关闭、菜单内容完整,无重复元素。

## 验证证据(我这边实测,供 p3 参考)

- `node scripts/ui-radius-audit.mjs` → Radius audit passed(全仓)。
- `npm run check:browser` → 44 截图全绿。
- 真实接线页专项回归:单一 `.main-content h1`、无重复标题、零浏览器错误。
- `npm test` → 75 pass / 0 fail / 1 skipped。

## 需 p3 关注

无。p3 可在最终 `ALL-DONE` 巡检时一并复核本报告。
