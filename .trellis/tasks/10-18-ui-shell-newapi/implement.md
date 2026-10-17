# Implement: ushell 参照 newapi 重做控制台外壳

依赖门禁:**board.md 出现 `BASELINE-DONE` 之前,禁止修改 `web/src/App.vue` 与 `web/src/style.css`。**
`scripts/check-browser.mjs` 当前被其他 pi 修改中(` M`),触碰前先 `git status` 确认,插入保持 1 行级最小改动。

---

## 阶段 A:准备(不碰 App.vue / style.css)

- [ ] A1 研究 newapi / codebuddy2api 模板 → `research/newapi-shell-research.md`(已完成)
- [ ] A2 留底截图:`npm run build` → `npm run check:browser` → 把 `.artifacts/screenshots/*` 复制到 `.artifacts/ui-before/`(已完成,46 个文件)
- [ ] A3 写 `design.md`(已完成)
- [ ] A4 写 `implement.md`(本文件)
- [ ] A5 配 `implement.jsonl` / `check.jsonl`
- [ ] A6 `python ./.trellis/scripts/task.py start 10-18-ui-shell-newapi`
- [ ] A7 board 追加 `PROGRESS`(规划完成,等 BASELINE-DONE)

## 阶段 B:纯新增文件(零冲突,可与他人并行)

- [ ] B1 新建 `web/src/nav.ts` — 导航注册表 + `Page` 类型派生 + `isPage()` / `pageTitle()`
- [ ] B2 新建 `web/src/errors.ts` — `friendlyError()` / `rawError()`
- [ ] B3 新建 `web/src/components/AccountMenu.vue` — 右上角头像下拉(头像/用户名/管理员/主题/分隔线/退出)
- [ ] B4 新建 `scripts/ui-radius-audit.mjs` — 圆角审计(不改 `package.json`)
- [ ] B5 `npm run check`(此时新文件未被引用,主要是类型自检)
- [ ] B6 提交:`refactor(ui): add navigation registry and error localizer`
      `git add web/src/nav.ts web/src/errors.ts web/src/components/AccountMenu.vue scripts/ui-radius-audit.mjs`
      `git commit -m "refactor(ui): add navigation registry and error localizer" -- <同上>`

## 阶段 C:圆角 token(R1)

前置:**BASELINE-DONE 已出现**

- [ ] C1 在 `style.css` `:root` 加 `--radius` / `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-pill`
- [ ] C2 按 `design.md` §2 映射表逐条替换所有裸 `border-radius`
- [ ] C3 新增样式(供后续阶段用)时也只允许 `var(--radius-*)`
- [ ] C4 跑 `node scripts/ui-radius-audit.mjs`,违规数必须为 0
- [ ] C5 `npm run check` && `npm run build`
- [ ] C6 提交:`refactor(ui): tokenize border radius scale`

## 阶段 D:侧边栏(R2)

- [ ] D1 `style.css` 加 `--sidebar-width` / `--sidebar-width-collapsed` / `--sidebar-motion`
- [ ] D2 `.sidebar` `transition: width`;`.workspace` `transition: margin-left`;`.sidebar { overflow-x: hidden }`
- [ ] D3 文字淡出:`opacity` + `max-width` 过渡;`display` 不变
- [ ] D4 `.sidebar.collapsed` 收起态:导航项居中、宽 40px、tooltip 走 `title`
- [ ] D5 `collapse` 状态只在 `@media (min-width: 851px)` 生效(不污染移动端抽屉)
- [ ] D6 `App.vue`:`collapsed` ref + `localStorage` 记忆(try/catch)+ 底部「收起/展开导航」按钮
- [ ] D7 `App.vue` 删除 `.sidebar-label`(工作空间)、`.sidebar-bottom`(管理员卡片/用户名/管理员/退出)
- [ ] D8 `App.vue` 删除概览 `.environment-footer`(「管理员会话已验证」)
- [ ] D9 `style.css` 删除 `.sidebar-label` / `.sidebar-bottom` / `.admin-avatar` / `.admin-info` / `.environment-footer`
- [ ] D10 `npm run check` && `npm run build`
- [ ] D11 提交:`feat(ui): add collapsible sidebar with persisted state`

## 阶段 E:顶栏与账号(R3)

- [ ] E1 `App.vue` 顶栏右侧接入 `<AccountMenu :username :theme @toggle-theme @logout>`
- [ ] E2 顶栏面包屑去掉页面名,只保留「管理控制台」
- [ ] E3 删除 `.page-eyebrow`(DOM + CSS),h1 保留在 `.main-content` 内
- [ ] E4 删除 `.workspace-footer`(「AzureKiln Backup」+ 版权)
- [ ] E5 `style.css` 新增 `.account-trigger` / `.avatar` / `.account-menu` 样式
- [ ] E6 `npm run check` && `npm run build`
- [ ] E7 提交:`feat(ui): move account controls into topbar dropdown`

## 阶段 F:存储页 "not found"(R5)

- [ ] F1 用本地临时数据目录在 16402 端口起服务,复现存储页错误文案
- [ ] F2 `StorageView.vue`:`errorMessage` → `friendlyError`,错误面板加 `:title="raw"`
- [ ] F3 `StorageView.vue` 空状态补下一步入口(聚焦导入表单)
- [ ] F4 `PathPicker.vue`:`errorMessage` → `friendlyError`;出错时不再渲染空状态文案
- [ ] F5 `npm run check` && `npm test`
- [ ] F6 提交:`fix(ui): localize storage errors and dedupe empty states`

## 阶段 G:浏览器断言适配

- [ ] G1 `scripts/check-browser.mjs`:退出登录前先点开账号菜单(1 行插入)
- [ ] G2 `npm run build` && `npm run check:browser` 全绿
- [ ] G3 提交:`test(ui): open account menu before signing out`

## 阶段 H:收尾

- [ ] H1 `npm run check` && `npm test` && `npm run build` && `npm run check:browser` 全绿
- [ ] H2 逐页对比 `.artifacts/ui-before/` 与 `.artifacts/screenshots/`
- [ ] H3 更新 `.trellis/spec/frontend/ui-api.md`:圆角 token、导航注册表、账号菜单、错误本地化
- [ ] H4 提交:`docs(spec): record console shell conventions`
- [ ] H5 board 追加 `SHELL-DONE` + 导航注册表用法说明
- [ ] H6 等其余三个 pane `DONE`,做整体回归,board 追加 `ALL-DONE`

---

## 验证命令

```powershell
npm run check                                              # vue-tsc
npm test                                                   # node --test
npm run build                                              # vite build
npm run check:browser                                      # Playwright 全流程 + 截图
node scripts/ui-radius-audit.mjs                           # 圆角审计
git diff --cached --stat                                   # 提交前自查
```

## 校验门(每阶段不通过不许提交)

| 门 | 条件 |
|---|---|
| G-类型 | `npm run check` 无错误 |
| G-构建 | `npm run build` 成功且 `web/dist/index.html` 更新 |
| G-圆角 | `ui-radius-audit` 违规数 = 0(阶段 C 之后) |
| G-浏览器 | `npm run check:browser` 通过(阶段 E 之后每次) |
| G-路径 | `git diff --cached --name-only` 全部属于本阶段声明的文件 |

## 冲突处理

1. `git add` 只用明确路径;`git commit -m "..." -- <路径>` 双重限定。
2. 提交前 `git diff --cached --stat`,混入他人文件立刻 `git restore --staged <file>`。
3. `index.lock` 占用 → `Start-Sleep -Seconds 3` 后重试,最多 5 次。
4. 发现 `App.vue`/`style.css` 有他人未提交改动 → board 记 `BLOCKED`,先做阶段 F 与新文件,稍后重试。

## 回滚点

| 阶段 | 回滚方式 |
|---|---|
| B | `git revert` 单 commit(纯新增文件) |
| C | `git revert` 单 commit(仅 style.css + 脚本) |
| D / E | 各自独立 commit,单独 revert 不影响圆角 token |
| F | 两个调用点换回 `errorMessage` |
| G | 单行改动 invert |
