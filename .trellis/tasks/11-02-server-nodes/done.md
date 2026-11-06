# done: 路径映射纯模块 + README 文档（pi p7 分工）

## 交付内容

### 1. `server/node-paths.mjs`（新增，纯模块，无 I/O）

节点路径映射的唯一定义处，供 `server/nodes.mjs` 同步流程调用。导出：

- `mapPath(path, rules, overrides?) -> { path, mapped, needsMapping, rule }`
- `normalizeRule` / `normalizeRules`（校验，返回规范化规则）
- `splitPath` / `joinPath` / `isWindowsStyle`（无文件系统访问的路径切分与重建）
- `NODE_PATH_RULE_LIMIT` (50) / `NODE_PATH_MAX_LENGTH` (1024)

实现的契约（对应 PRD）：

| 要求 | 实现 |
| --- | --- |
| 最长前缀优先 | 按 `from` 的段数取最长；书写顺序不影响结果 |
| 完整路径段匹配 | `/srv-old` 不命中 `/srv` |
| 大小写/分隔符按 `from` 风格 | Windows 风格（盘符或反斜杠）→ 不区分大小写；POSIX → 区分大小写 |
| 目标保留自己的分隔符 | `/srv → C:\apps` 得到 `C:\apps\...`，反之亦然 |
| 重复/混合/结尾分隔符 | `/srv//data/x`、`/srv/data\x`、`/srv/data/x/` 均命中 |
| 无匹配且为绝对路径 → 需映射 | `needsMapping: true`，且**原样返回**路径供日志记录 |
| job 级 override 优先 | 第三个参数；override 存在时**不与节点规则混用** |
| 相对路径不需映射 | `needsMapping: false` |
| 盘符相对路径（`C:data`） | 不映射也不接受为规则源（依赖该盘当前目录，跨机器无意义） |
| `..` 不被静默消解 | 保留为段，重建后仍可见，不会静默越界 |

与 `shared/contracts.mjs` 的 `nodePathRuleSchema` 对齐：`from` 与 `to` **都必须是绝对路径**（我最初允许空 `to`，读到真实 schema 后收紧）。

与后端 lane `server/nodes.mjs` 的实际调用方式对齐：它只用**两个参数**调用 `mapPath`，并把 `jobOverrides[jobId].sources` 自行转换成 `{from,to}` 规则传入。第三个参数按 PRD 保留并有独立测试，但不是同步主路径。

### 2. `tests/node-paths.test.mjs`（新增，17 个测试，全通过）

覆盖：最长前缀、段边界（`/srv-old`）、精确匹配、跨平台分隔符、Windows/POSIX 大小写语义、混合分隔符、未映射绝对/相对路径、空输入、无规则、override 语义、两节点映射同一任务到不同路径、规则校验与重复检测、`..` 保留、盘符/UNC、盘符相对路径。

### 3. 三份 README 新增章节

`README.md`、`README.en.md`、`README.zh-TW.md` 各新增两章（插在「站点管理/站點管理」之后、「授权登录与邮件」之前），三份 h2 数量一致（13 = 13 = 13）：

- **服务器节点 / Server nodes / 伺服器節點**：节点字段、令牌加密与权限、`baseUrl` 约束、路径映射五条规则、只同步任务定义、`syncKey` 幂等、逐任务结果、停用/删除语义。
- **通知聚合与模板 / Notification aggregation and templates / 通知聚合與範本**：聚合窗口（`aggregateWindowSec`，默认 120，范围 0–86400，0=关闭）、30 分钟最长等待、重启不丢批次、模板变量清单（汇总 7 个标量 + `items` 段；单封 7 个）、8192 字符上限、缺省用内置模板、HTML 转义。

文档中的事实逐条对照代码核实后才写入，未采信 schema 注释：

- `TEMPLATE_MAX_LENGTH = 8192`（`server/notify-template.mjs`）
- `maxWaitMs = 30 * 60 * 1000`（`server/notify-batch.mjs:9`）
- `aggregateWindowSec` `.min(0).max(86400).default(120)`（`shared/contracts.mjs:287`）
- `redirect: 'manual'`（`server/nodes.mjs:122`）→ 文档写"不跟随重定向"有据
- 模板变量名取自 `TEMPLATE_VARIABLES` / `sampleContext()` 实际导出
- 转义行为实测：`html` 部分已转义（`&lt;script&gt;`），`text` 部分保留原文（纯文本上下文，正确）；文档据此表述为"不会当作 HTML 执行"

**修正的一处错误**：初稿写了"保存前会拒绝回环/链路本地/私有网段（SSRF 防护）"。核对后确认 `nodeBaseUrlSchema` **没有任何内网/回环过滤**，已改为如实描述——不做过滤，安全边界取决于填写的地址，并提示不要指向不受控的公网主机。

## 验证

| 命令 | 结果 |
| --- | --- |
| `node --test tests/node-paths.test.mjs` | **17/17 pass**，0 fail，0 skipped |
| `npm test`（全量） | **197 tests，194 pass，0 fail，3 skipped** |

全量基线说明：本次会话中途 `npm test` 曾出现 2 个失败
（`tests/integration.test.mjs` 的 `notificationStatus` 期望 `sent` 实得 `failed`，
以及 `tests/notify-batch.test.mjs` 的 Windows `EPERM` 临时目录清理）。
两者都位于 notify-aggregate lane 正在改动的 `server/backup.mjs` / `server/notify-batch.mjs`，
与本模块无关（当时没有任何文件 import `node-paths.mjs`）。该 lane 完成后全量转绿。

## 未完成 / 遗留

1. **`mapPath` 第三参数目前是"备用接口"**：PRD 写了 `mapPath(path, rules, overrides?)`，我实现了并测试了，
   但后端 lane 的 `server/nodes.mjs` 选择在调用方展开 override 规则（只用两参数）。
   这是可用的实现，但**不是唯一事实来源**——若后续要统一，应由 `nodes.mjs` 改为传入第三参数，
   或由 PRD 明确删除该参数。属跨 lane 决策，未擅自改动对方文件。
2. **未做真实节点联调**：没有可用节点实例，`mapPath` 只做了纯函数级验证；
   `nodes.mjs` 的 HTTP 同步、令牌鉴权、`syncKey` 幂等 upsert 由后端 lane 与其 `tests/nodes.test.mjs` 负责。
3. **未验证 README 渲染效果**：只核对了标题结构与事实准确性，未跑浏览器/布局检查（非本分工范围）。
4. **未提交**：按共用约束，未执行任何 git commit / push。

---

## Backend API, storage and sync (codex p9)

The assigned backend implementation and scoped review are complete. This section supplements the pi p7 report above; its content and other workers' changes were preserved. No git commit, staging, task archive or journal commit was performed.

### Files changed in this assignment

| File | Backend change |
| --- | --- |
| `shared/contracts.mjs` | Additive node input/base URL/path-rule and synchronization request/result schemas. |
| `server/store.mjs` | Additive `nodes` and `synced_jobs` tables; AES-256-GCM node tokens; public `tokenSet`; blank-token preservation; sanitized persisted sync results; stable incoming job identities; compatibility authentication against the planned API-token table. |
| `server/app.mjs` | Node CRUD, connection test and push routes; separately authenticated receiver routes; narrowly scoped validation for paused definitions lacking local credentials; synchronization shutdown. |
| `server/nodes.mjs` | New push/receive service, external `mapPath` integration and conservative missing-module stub, explicit source overrides, per-job outcomes, bounded requests/responses, redirect rejection, scoped token authentication, local secret/runtime preservation and echo-loop prevention. |
| `tests/nodes.test.mjs` | Eleven isolated HTTP/SQLite acceptance tests. |

Task-local artifacts added/updated: `design.md`, `implement.md`, `backend-integration.md`, `implement.jsonl`, `check.jsonl`, `task.json` activation metadata, and this appended completion section. No frontend, path-mapper, README, token-management, notification implementation or existing executor test changes belong to this backend assignment. Shared-file edits from those workstreams were preserved.

### Delivered behavior and API handoff

- Administrator-session routes: `GET/POST /api/nodes`, `GET/PATCH/DELETE /api/nodes/:id`, `POST /api/nodes/:id/test`, and `POST /api/nodes/:id/sync`. Mutations retain existing origin/CSRF protections.
- Receiver routes: `GET /api/sync/status` and `PUT /api/sync/jobs`. Require a valid Bearer API token with explicit `sync` scope. Administrator cookies and outbound node credentials alone do not authorize receiving definitions; `read`/`run` scopes remain insufficient.
- Receive envelope: `{jobs:[{syncKey,job}]}`. Incoming jobs receive independent local IDs and persist their `syncKey` mapping across restart. Repeated synchronization updates the same task. Deleting that task removes its mapping through a foreign key.
- Summaries match the node UI: `{at,status,total,synced,unmapped,failed,jobs}` with task `synced|unmapped|failed` and summary `succeeded|partial|failed`. Public nodes include `lastSyncAt`, `lastStatus`, `lastSync`, and `tokenSet`; never the token.
- Push only task definitions. Do not transfer passwords, settings, runs, logs, baselines or system tasks. Receiver-local archive/database credentials and execution history survive updates. New encrypted or database-backed definitions missing local credentials remain paused and report that configuration is required.
- Map source fields, nested Vaultwarden/new-api paths/TLS assets and absolute destination paths through pi p7's `mapPath`. String-array source overrides are final node-local paths; dependent files use derived override rules through the same mapper. Any unresolved absolute path skips the whole task. Imported tasks are excluded from outbound pushes to avoid replication loops.
- Independent review fixed a missing Vaultwarden TLS mapping case: persisted TLS paths must be mapped even in SQLite mode because shared validation still checks them. The added regression fails before that fix and passes afterward.

Full request/response and dependency details are in `backend-integration.md`.

### Validation

| Command / check | Result |
| --- | --- |
| `node --test tests/nodes.test.mjs` | 11 passed, 0 failed. |
| Independent scoped review | Completed; Vaultwarden TLS omission fixed and covered by regression. |
| `node --check` for the five backend-related files | Passed. |
| `npm test` (final rerun) | **198 tests: 195 passed, 0 failed, 3 skipped**. |
| `npm run check` | Passed, including final main-session run. |
| `npm run build` | Passed. |
| Scoped `git diff --check` | Passed. |

The first full-suite run had one failure in the existing executor test `upload failure preserves previous successful archive and bounded failure staging` (`tests/executor.test.mjs:300`, older failed staging still existed at the assertion). Its wait condition can observe `cleanupStatus:'retained'` before the subsequent asynchronous sweep finishes; the observed failure is consistent with that existing timing window. The focused executor test then passed, and a fresh full `npm test` passed as recorded above. Neither the executor test nor cleanup implementation was changed by this assignment. Logs: `.artifacts/nodes-backend-test.log` and `.artifacts/nodes-backend-test-rerun.log`.

Browser/layout checks remain with the frontend assignment; no visual verification is claimed here.

### Remaining integration work / limits

1. **API-token issuance dependency:** the current branch still lacks `server/tokens.mjs` / token management. It must support issuing `sync` scope using the planned `api_tokens` contract. The receiver fails closed when no valid token exists; it does not issue tokens or reuse outbound credentials as inbound authentication. A supplied token authenticator is also supported through app options.
2. **Mapper defects remain in pi p7's completed module:** final integration probes still incorrectly map different Windows drives and UNC shares, and lowercase unmatched Windows suffixes. Reproductions are recorded in `backend-integration.md`. These can select wrong node-local paths and require corrections in the mapper-owned lane; its files were not changed here. Passing existing mapper tests does not cover these negative cases.
3. **Destination model:** current backup destinations accept relative rclone paths. Absolute destination paths are mapped before transport but remain subject to the existing receiver validation; this assignment does not introduce a new local-destination type or distribute remote credentials/configuration.
4. The shared task remains `in_progress`; this section marks only codex p9's backend delivery. The coordinating session retains ownership of integration, shared specs, task completion and commits.

---

## November 7, 2026: `.yml` deployment filename follow-up

The user requested changing deployment YAML filenames to `.yml` and asked about commit/push status. The changes below are complete; nothing was staged, committed or pushed. Earlier reports and other workers' changes were preserved.

### Files and behavior

- Renamed root `compose.yaml` to `compose.yml` and `compose.build.yaml` to `compose.build.yml`. Updated the read-only host/container mount, `SYSTEM_COMPOSE_FILE` value and local-build example.
- Updated `.env.docker.example`, `.cnb.yml` and `scripts/check-image.sh` comments, plus deployment instructions in `README.md`, `README.en.md` and `README.zh-TW.md`.
- Updated `scripts/prepare-release.mjs` bundle members and `scripts/ci-verify.sh` checks to require both `.yml` manifests.
- Updated `server/config.mjs` to prefer an existing `compose.yml`, falling back to an existing legacy `compose.yaml`. Explicit `SYSTEM_COMPOSE_FILE` remains authoritative, including when its target does not yet exist.
- Updated `tests/release.test.mjs` and `tests/ci-scripts.test.mjs`; added `tests/config.test.mjs` to cover discovery and explicit-path precedence.
- Added the filename/discovery contract to `.trellis/spec/backend/backup-lifecycle.md` and its index. Updated task `design.md` and `implement.md` to record the authorized scope extension.

Trellis's fixed `.trellis/config.yaml`, historical documents, serialized backup members (`deployment-compose.yaml`, new-api `config/compose.yaml`) and restore output `restored-compose.yaml` retain their existing names. Existing archive compatibility is preserved.

### Verification

| Check | Result |
| --- | --- |
| Release/CI/config tests | 24 passed, 0 failed. |
| Independent filename/reference review | Passed; no fixes required. |
| Node syntax checks and Git Bash `bash -n` for the two shell scripts | Passed. |
| Real checkout release bundle | Six declared members, renamed Compose contents and SHA-256 verified; temporary output removed. |
| `npm test` (final full rerun) | **201 tests: 198 passed, 0 failed, 3 skipped**. |
| `npm run check` | Passed. |
| `npm run build` | Passed. |
| Scoped `git diff --check` | Passed. |

The first full run had the same previously recorded executor timing failure at `tests/executor.test.mjs:300` (`only latest failed staging retained`): its wait helper can observe `cleanupStatus: 'retained'` before the following asynchronous cleanup sweep finishes. The isolated regression rerun passed, followed by the clean full run above. No executor test or cleanup implementation was modified. Logs: `.artifacts/compose-yml-test.log`, `.artifacts/compose-yml-executor-retest.log` and `.artifacts/compose-yml-test-rerun.log`.

No new integration limits were introduced by this rename. The backend dependencies and mapper findings recorded above still apply; real Docker deployment was not exercised in this follow-up. The shared task remains `in_progress` for the coordinating session.

---

## November 7, 2026: final `docker-compose` naming and authorized submission

The user clarified the intended filenames as `docker-compose.yml` and `docker-compose.build.yml`, then explicitly authorized standardized commits and submission. This supersedes both the shorter filenames and the earlier no-commit instruction for this assignment.

The two root manifests and all current deployment mounts, environment values, README references, release members and CI checks now use the requested names. Configuration discovers `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, then `compose.yaml`; explicit `SYSTEM_COMPOSE_FILE` remains authoritative. Backup/restore members and framework configuration retain their existing names. The final deployment and node-sync contracts are documented in the backend spec.

For independent submission, `tests/nodes.test.mjs` now injects an explicit input/rules/output mapping fixture and asserts calls for each node and dependent override paths. It retains real HTTP/SQLite, secret preservation and idempotence checks without requiring pi p7's uncommitted mapper. Production still calls the external module when available and uses its conservative missing-module fallback otherwise.

### Final validation of the exact submission

| Check | Result |
| --- | --- |
| Node HTTP/SQLite acceptance tests | 11 passed. |
| Final release/CI/config tests and independent filename review | 24 passed; no review fixes required. |
| Syntax checks and actual six-member release/checksum inspection | Passed. |
| Exact staged-tree `npm test`, excluding other lanes' WIP | **144 tests: 141 passed, 0 failed, 3 skipped**. |
| Exact staged-tree `npm run check` and `npm run build` | Passed. |
| Missing-mapper probe in the staged snapshot | One unresolved task skipped, summary persisted, zero outbound requests. |
| Scoped diff checks and index/preview blob comparison | Passed. |
| Working-file hashes before/after selective staging | All 41 captured paths unchanged. |

The isolated submission was exported under `.artifacts/owned-submission-ippuqhe7`; its full-suite log is `.artifacts/owned-submission-test.log`. The smaller test count reflects exclusion of uncommitted notification and mapper tests, rather than skipped acceptance cases. Earlier combined-worktree results remain recorded above.

Submission scope is the backend-owned service, schema and persistence hunks, backend tests/specs, deployment rename and task artifacts. Notification/frontend/path-mapper code, their shared-file hunks and their README feature sections remain in the working tree for their owners. The two Conventional Commit messages are `feat(nodes): add node API, storage and job synchronization` and `chore(docker): standardize docker-compose filenames`. The main session verifies the pushed branch and reports its actual commit hashes after execution. The shared task stays `in_progress`; no task archive is appropriate while other lanes remain outstanding.

Submission confirmed: `02ac84c` (`feat(nodes): add node API, storage and job synchronization`) and `8a8747d` (`chore(docker): standardize docker-compose filenames`) were pushed to `github/feat/nodes-and-notify`. `git ls-remote` returned `8a8747d124d7bc1b85e1d9d15190ce7ffc250eff` for that branch immediately afterward. Other lanes' uncommitted changes remain intact; the index was empty after the two work commits. This final task/journal record follows those work commits separately.
