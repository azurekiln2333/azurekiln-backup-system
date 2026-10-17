# 互审报告:jobs-batch-grouping(p2)

- 审查人:`w1H:p5`(newapi-data-backup)
- 被审:`w1H:p2`(jobs-batch-grouping)
- 审查时间:2026-10-18
- 结论:**通过,无阻塞问题。** 3 条非阻塞建议(N1/N2 建议 p2 后续顺手修,N3 无需动作)。

---

## 一、审查范围(全部 p2 提交)

| 提交 | 内容 |
|---|---|
| `f7d558e` | feat(jobs): add task tags and batch creation API(`server/app.mjs` +41/-6,`server/store.mjs`,`shared/contracts.mjs` +18) |
| `8d219a8` | feat(web): add tag chips and batch add mode to job editor(`JobEditor.vue`,`App.vue`,`style.css`) |
| `dc37b52` | test: cover job tags and batch creation in API and browser(`tests/api.test.mjs`,`scripts/check-browser.mjs`) |
| `b0e7024` | docs: document task tags and batch directory creation(README* + spec) |
| `de6b8bb` | feat(web): extract job grouping composable(`web/src/jobGroups.ts`) |
| `08d59fb` | feat(web): add grouped collapsible jobs view component(`JobsView.vue`) |
| `5d9504c` | feat(web): prefill batch tag from parent folder name |
| `d27605a` | test(web): cover grouping modes and collapse persistence(`tests/job-groups.test.mjs`) |
| `878100e` | docs: document job list grouping and collapse behaviour |
| `bda3be4` / `0724c35` / `097dfd5` | 分组样式独立 css + 圆角 token 化 |
| `c3e5fef` | refactor: drop unused basename helper |
| `3e812f4` | feat(web): support newapi job type in grouping |
| `5f713b5` | fix(web): enable collapse-all unless every group is collapsed |
| `60f582f` | feat(web): wire grouped jobs view into console(`App.vue`) |
| `3f93081` | chore: ignore local scratch directory |
| `ca441db` / `6b85dfd` | spec 易错点 + 规划记录 |

---

## 二、重点核查

### 1. 批量创建:每个子目录是否真建成独立任务,远端路径是否为「目标根/子目录名」✅

**实现**(`server/app.mjs` `POST /api/jobs/batch`):

```js
const sourcePath = path.join(parentPath, folder);
const template = { ...input.template, type: 'directory' };
const job = validateJob({
  ...template,
  name: input.nameTemplate.replaceAll('{folder}', folder),
  sourcePath,
  destinations: (template.destinations ?? []).map((destination) => ({
    remote: destination?.remote,
    path: [String(destination?.path ?? '').replace(/\/+$/, ''), folder].filter(Boolean).join('/'),
  })),
}, config);
```

**真机端到端验证**(独立端口 16404 + 隔离临时目录,`POST /api/jobs/batch` 真实调用,34 项断言全过):

| 断言 | 结果 |
|---|---|
| 返回 201 且恰好 3 个任务 | ✅ |
| `mysql-a` 的 `sourcePath === parent/a` | ✅(b、c 同) |
| `mysql-a` 的 `destinations[0].path === Storage/CloudflareR2/ServerBackups/mysqlbackups/a` | ✅(b、c 同) |
| 每个任务 `destinations[0].id` 存在且**三个互不相同**(独立 destination id,保留/删除互不干扰) | ✅ |
| 模板里的 `retention.days=7` / `keepLast=3` / `archive.format=7z` 全部原样继承 | ✅ |
| `GET /api/jobs` 能查到 3 条(真的落库,不是只回显) | ✅ |
| 响应中无 `"password"` 明文字段(只有 `passwordSet`) | ✅ |

**结论**:完全满足父任务 C 项原话——`crontab_backup/{a,b,c}` 各自独立成任务,远端映射到 `.../mysqlbackups/{a,b,c}`,「其他设置项全部一致」也成立。

### 2. 冲突校验是否「全有或全无」✅

实现采用**先全量校验、再统一保存**:

```js
const existing = new Set(store.listJobs().filter(j => j.type === 'directory').map(j => j.sourcePath));
// Validate every task before saving any, so a bad folder never leaves a partial batch behind.
const jobs = input.folders.map(...);   // 任一抛错 -> 整体 500/409,循环中断
const created = jobs.map(job => store.getJob(store.saveJob(job).id));
```

`input.folders.map()` 里 `validateJob()` 抛出的 `AppError` 会直接中断整个请求,`store.saveJob()` 一次都没被调用 → **不存在部分落库**。

真机验证:

| 场景 | 结果 |
|---|---|
| 重复提交 `[a,b,c]`(均已存在) | 409 `JOB_SOURCE_EXISTS`,任务总数不变 ✅ |
| 提交 `[yyy-missing, zzz-missing]`(子目录不存在) | 404/400,任务总数不变 ✅ |
| `../escape` / `a/b` / `..` / `.` / `a\b` 作为 folder 名 | 全部 400(被 `batchFolderName` 拒绝)✅ |
| `nameTemplate` 不含 `{folder}` | 400 ✅ |
| `folders: []` | 400 ✅ |

另外 `batchFolderName` 还要求 `value.trim() === value`(拒绝首尾空格)且 `folders` 去重(`new Set(items).size === items.length`),`map` 上限 100,防止误提交上千任务。

### 3. 分组折叠是否有重复标题/重复元素 ✅

| 检查 | 结果 |
|---|---|
| `JobsView.vue` 内 `<h1>`/`<h2>` 数量 | **0**(标题只由 `App.vue` 的 `.page-heading h1` 提供) |
| `App.vue` 中 `<JobsView` 挂载次数 | **1**(旧内联任务表格已被 `v-else-if="page === 'jobs'"` 整体替换,无残留第二份列表) |
| `page === 'jobs'` 出现 2 次的解释 | 第 262 行是刷新按钮的 `['overview','jobs','runs'].includes(page)`,第 271 行是唯一 `JobsView` 挂载 → **不是重复列表** |
| 组头是否会与列表标题重复 | 不会:组头是 `<tr class="group-row">` 里的 `.group-toggle` 按钮,不是标题元素 |
| 我在真机页面上实测 `.main-content h1` 数量 | **1** |
| `jobs-groups.css` 是否重设既有 class | 否,只新增 `.group-*` / `.jobs-table tr.group-row`,文件头注释明确禁止改 `.table-wrap` / `.list-toolbar` / `.tag-chip` / `.segmented`,diff 也遵守 |

另:`097dfd5` 把 3 处裸圆角改为 `var(--radius-md)` / `var(--radius-pill)`,`node scripts/ui-radius-audit.mjs` 全仓通过——这一点直接关系到父任务 prd 里「圆角照 newapi 0.5 档」的硬约束。

### 4. localStorage 是否 try/catch ✅

`web/src/jobGroups.ts` 的 4 个读写函数全部包裹 try/catch 并降级:

| 函数 | 失败行为 |
|---|---|
| `readCollapsed(storage, mode)` | `storage` 为 `undefined` / `getItem` 抛错 / `JSON.parse` 抛错 / 值非数组 → 返回空 `Set`(等同于「不折叠」) |
| `writeCollapsed(...)` | `setItem` 抛错(quota / 隐私模式)→ 静默吞掉 |
| `readGroupMode(storage)` | 缺失或未知值 → `'none'` |
| `writeGroupMode(...)` | 抛错 → 静默吞掉 |

`JobsView.vue` 顶层还有 `const storage = typeof localStorage === 'undefined' ? undefined : localStorage;`,覆盖无 `localStorage` 的服务端/受限环境。

`tests/job-groups.test.mjs` 有专门用例覆盖:
- `'{not json'` 损坏值 → 空集合(L131-132)
- 同时抛 `getItem`/`setItem` 的 hostile storage → 不抛(L140)
- 未知 mode 值 → 回退 `'none'`(L148)
- `setItem` 抛 quota → `doesNotThrow`(L157)

**结论**:满足要求,且测试覆盖到位。

---

## 三、附加核查

| 项 | 结果 |
|---|---|
| 分组不丢不重(`groups.flatMap(g=>g.jobs).length === filtered.length`) | ✅ 137 任务用例覆盖 |
| 搜索/标签/启用筛选与分组复合(先过滤再分桶) | ✅ |
| `type` 分组顺序 `directory → vaultwarden → newapi → system` | ✅(`3e812f4` 已加 `newapi`,我的 `JobEditor` 接线无 TS2741) |
| 搜索命中但组被折叠的陷阱 | ✅ `searching` 时 `isCollapsed` 强制 false,且全折叠/全展开按钮在搜索时 `disabled` |
| 模式切换时折叠集合不串味 | ✅ `watch(groupMode)` 重新按新 mode 读取 |
| 组头下「多出一条线」 | ✅ `.jobs-table tbody.group-collapsed tr.group-row td { border-bottom: 0 }` |
| `npm test` / `npm run check` / `npm run build` | ✅ 76 项(75 pass / 1 skip Windows 符号链接) |
| `npm run check:browser` | ✅ 44 截图全绿(p5 端口 16404) |

---

## 四、非阻塞建议

### N1 — `f7d558e` 基线提交误带令牌接线(历史问题,已修复)

`f7d558e` 的 `server/app.mjs` diff 里包含 `import { createTokens } from './tokens.mjs'`、`/api/tokens` 路由块、`auth.tokenGuard` 等**不属于 jobs 任务**的代码,而 `server/tokens.mjs` 并不存在 → 该提交点 HEAD 无法 import。

- 现状:**已由 p4 的 `1d6846a` 修复**(删除全部令牌行,`L108` 守卫还原为基线原样)。
- 教训(p2 已在 board 自陈):基线类提交也必须先 review 完整 diff 再 `git add`,不能整文件 add。
- 建议:在 `.trellis/spec/` 留一条「共享文件提交前必须 `git diff --cached` 逐 hunk 复核」的约定。**这条我已在 p5 自己的提交流程中执行**(本轮我两次发现并 `git restore --staged` 剔除了误入的 `App.vue`/`style.css`)。

### N2 — `bucket()` 类型排序对未知类型返回 `-1`

```ts
return list.sort((a, b) => typeOrder.indexOf(a.jobs[0]!.type) - typeOrder.indexOf(b.jobs[0]!.type));
```

若将来新增任务类型但忘记同步 `typeOrder`,`indexOf` 返回 `-1`,该类型会**排到最前面**(甚至排在 `directory` 之前),而 `typeLabels[job.type]` 会是 `undefined`,组头渲染成空白。

建议(1 行):

```ts
const rank = (type: Job['type']) => { const i = typeOrder.indexOf(type); return i === -1 ? typeOrder.length : i; };
return list.sort((a, b) => rank(a.jobs[0]!.type) - rank(b.jobs[0]!.type));
```

`ca441db` 的 spec 已记录「type map 易错点」,本条可一并补进去。**当前行为无 bug**,仅防御未来。

### N3 — `jobSource()` 对 `newapi` 走隐式回退(无需改)

`jobSource()` 无 `newapi` 分支,回退到 `job.sourcePath`。我的适配器在 `validateNewApiJob()` 里显式写了 `job.sourcePath = job.newapi.dataDir`,所以「按源父目录」分组运行时正确。我已在 `server/newapi.mjs` 加注释固化该约定(提交 `68c35c0`)。

若 p2 希望代码自解释,可加一行 `if (job.type === 'newapi') return job.newapi.dataDir;`——纯可读性,不改行为,由 p2 决定。

---

## 五、给作者(p2)的结论

**无需修复即可保持 DONE。** 若愿意处理 N2,建议单独一个小提交(`refactor(web): rank unknown job types after known ones`),不要与其它改动混在一起。

已通知:见 board.md `[w1H:p5] [REVIEW]` 行。

---

## 六、p5 侧同步动作

- 已在 `server/newapi.mjs` 的 `validateNewApiJob()` 补注释说明 `sourcePath === dataDir` 是任务列表「来源列 + 按源父目录分组」的依赖(提交 `68c35c0`)。
- 未修改 p2 拥有的任何文件(`web/src/jobGroups.ts`、`JobsView.vue`、`jobs-groups.css`、`App.vue`、`style.css`、`server/app.mjs` batch 部分)。

## 七、验证脚本

本报告所有「真机」结论来自 `.tmp/p5-review/verify-batch.mjs`(独立端口 16404 + 系统临时目录,34 项断言,跑完自清理,已从工作树移除)。
