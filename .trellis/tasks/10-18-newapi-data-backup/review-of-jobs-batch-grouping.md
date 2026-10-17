# 互审报告:p5 → p2(jobs-batch-grouping)

审查人 pane:`w1H:p5`(newapi-data-backup)
被审 pane:`w1H:p2`(jobs-batch-grouping)
审查范围:`f7d558e~1..HEAD` 中属于 p2 的提交

| 提交 | 内容 |
|---|---|
| `f7d558e` | feat(jobs) contracts + app + store(基线) |
| `8d219a8` | feat(web) JobEditor + App + style(基线) |
| `dc37b52` | test api + check-browser(基线) |
| `b0e7024` | docs README* + spec(基线) |
| `de6b8bb` | feat(web) 抽取 jobGroups 组合式函数 |
| `08d59fb` | feat(web) 新增分组可折叠 JobsView 组件 |
| `5d9504c` | feat(web) 批量标签默认取父目录名 |
| `d27605a` | test(web) job-groups 单测 |
| `878100e` | docs 分组文档 + ui-api spec |
| `bda3be4` / `0724c35` / `097dfd5` | 分组样式(独立 css)+ 圆角 token 化 |
| `c3e5fef` | refactor 清理未用 basename |
| `3e812f4` | feat(web) 分组支持 newapi 类型 |
| `5f713b5` | fix(web) 全部折叠 disabled 倒置 |
| `60f582f` | feat(web) App.vue 接线 JobsView |

---

## 结论

**通过,无阻塞问题。** 3 条非阻塞建议(见下),其中 2 条与我的 newapi 类型直接相关,由我在自己文件内顺手修,不改变 p2 的归属。

---

## 核查项

### 1. 分组正确性 ✅

- `groupJobs()` 的契约是「每个匹配任务恰好出现在一个组」,`groups.flatMap(g => g.jobs).length === jobs.filter(match).length`;`d27605a` 的 137 任务用例覆盖不丢不重。
- `match` 在分桶**之前**应用,搜索/标签/启用筛选与分组正确复合。
- `tag` 模式按 `tags[0]` 分桶,未打标签的进 `UNGROUPED_KEY` 且排序永远在最后。
- `type` 模式按 `typeOrder` 固定顺序(`directory → vaultwarden → newapi → system`),而不是按标签字典序。
- `source` 模式 `system` 单独成组、`vaultwarden` 用 `dataDir`、其余用 `sourcePath`,与列表「来源」列语义一致。

### 2. 折叠状态持久化 ✅

- `readCollapsed` / `readGroupMode` 对 `undefined storage`、`JSON.parse` 异常、非数组值全部降级为「不折叠 / none」,**永不抛错**,这一点比同类代码常见写法更稳。
- `writeCollapsed` / `writeGroupMode` 用 try/catch 吞掉 quota 错误。
- 模式切换时 `watch(groupMode)` 会重新装载该模式的折叠集合,不会把 A 模式的折叠 key 泄漏到 B 模式。
- 搜索时 `isCollapsed` 强制返回 false(搜索结果永远可见),并在 UI 上把两个全折叠/全展开按钮 `disabled`。这一步很关键:否则「搜索命中但组是折叠的」会让用户以为没结果。

### 3. 无重复标题 / 无重复元素 ✅

- `JobsView.vue` 的模板根是 `.list-toolbar` + `.group-toolbar` + 表格,**不含任何 `<h1>`/`<h2>`**,标题仍只来自 `App.vue` 的 `.page-heading h1`。
- `App.vue` 只有一个 `v-else-if="page === 'jobs'"` 分支,旧的內联任务表格已被整体替换,没有残留的第二份列表。
- 我实测(`.tmp/p5` 专项回归)`:document.querySelectorAll('.main-content h1').length === 1`。

### 4. 样式隔离 ✅

- `jobs-groups.css` 只新增 `.group-*` / `.jobs-table tr.group-row` 等**新**类,文件头注释明确写了不得重设 `.table-wrap` / `.list-toolbar` / `.tag-chip` / `.segmented`,实际 diff 也遵守了。
- 3 处裸圆角已在 `097dfd5` 改为 `var(--radius-md)` / `var(--radius-pill)`;`node scripts/ui-radius-audit.mjs` 全仓通过。
- `.jobs-table tbody.group-collapsed tr.group-row td { border-bottom: 0 }` 解决了「折叠后组头下多出一条线」的问题,属于父任务 prd 里点名的「多余线条」类缺陷,处理正确。

### 5. 与 newapi 类型的集成 ✅

- `3e812f4` 已把 `newapi` 加入 `typeOrder` 与 `typeLabels`,`npm run check` 无 TS2741。
- 我的 `JobEditor.vue` 接线复用了 `newapi` 分支,没有与 p2 的批量逻辑冲突(`canBatch` 仍只对 `directory` 生效)。
- `jobSource()` 对 `newapi` 未显式分支,回退到 `job.sourcePath`。我的适配器在 `validateNewApiJob()` 里写了 `job.sourcePath = job.newapi.dataDir`,所以**运行时正确**;但这种隐式依赖值得加注释或显式分支。

### 6. 批量创建 ✅(父任务 C 项)

- `POST /api/jobs/batch` 全量校验后一次性保存,任一子目录非法则整批拒绝(无部分落库),重复源返回 409。
- 每个 `destination` 追加 `/<folder>`,`crontab_backup/{a,b,c}` → `.../mysqlbackups/{a,b,c}` 的映射符合父任务原话要求。
- p2 已用真实 API 端到端验证(`.tmp/p2/verify-batch.mjs`,隔离目录)。

### 7. 测试 ✅

`tests/job-groups.test.mjs` 覆盖分组不丢不重、类型顺序、标签兜底、折叠容错、模式回退。`npm test` 当前 76 项(75 pass / 1 skip)。

---

## 非阻塞建议

| # | 建议 | 严重度 | 处理 |
|---|---|---|---|
| N1 | `jobSource()` 增加 `job.type === 'newapi'` 显式分支(或用 `job.sourcePath` 但加注释说明 newapi 的 sourcePath 等于 dataDir),避免将来有人改 `validateNewApiJob` 时静默破坏「按源父目录」分组 | 低 | 我在自己的 `server/newapi.mjs` 旁补注释说明该约定;`jobGroups.ts` 属 p2,若需要显式分支请 p2 决定 |
| N2 | `bucket()` 的 `type` 模式排序用 `typeOrder.indexOf(...)`,未来若出现未登记类型会返回 `-1` 排到最前 | 低 | 建议改为 `const rank = typeOrder.indexOf(t); return (rank === -1 ? typeOrder.length : rank)`;不影响当前行为 |
| N3 | `JobsView.vue` 的 `watchLabel` 对 `newapi` 返回 `''`(非 directory 走 `—`),这是正确的;但模板里 `jest`/`—` 分支与我的 `NewApiFields` 同样不提供文件监听,二者一致,无需改 | — | 无动作 |

---

## 我( p5 )本任务内已做的关联修复

- 在 `server/newapi.mjs` 的 `validateNewApiJob()` 里补注释:显式写明「`sourcePath` 必须等于 `dataDir`,以让任务列表的『按源父目录』分组与来源列对 newapi 生效」。
- 未修改 `web/src/jobGroups.ts` / `JobsView.vue` / `jobs-groups.css` / `App.vue` / `style.css`,保持 p2 的文件归属。

---

## 验证证据

| 命令 | 结果 |
|---|---|
| `npm run check` | 绿 |
| `npm test` | 76 项,75 pass / 0 fail / 1 skip(Windows 符号链接用例) |
| `npm run build` | 绿 |
| `npm run check:browser` | 44 截图全绿(p5 端口 16404) |
| `node scripts/ui-radius-audit.mjs` | 全仓通过 |
| p5 专项真机回归 | 12/12(单一 h1、new-api 表单字段各出现一次、强制加密 7z) |
