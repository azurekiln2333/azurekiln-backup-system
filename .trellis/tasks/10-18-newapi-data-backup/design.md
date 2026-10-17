# 技术设计:newapi 数据备份(newapi 任务类型)

调研依据:`research/newapi-data-inventory.md`、`research/newapi-backup-rules.md`。
父任务规则:`.trellis/tasks/10-18-ui-revamp-newapi-backup/prd.md`。

---

## 1. 目标与非目标

### 目标
1. 新增第 4 种任务类型 `newapi`,与 `directory` / `vaultwarden` / `system` 并列。
2. 按 backup-rules 生成**一致性**归档:主库快照 + 日志库快照 + 数据目录 + 部署配置,附 `manifest.json` 与 `RESTORE.md`。
3. 可在另一台机器按 `RESTORE.md` 还原出与源环境一致的数据(不含源码/镜像)。
4. 密钥不出现在日志、API 响应、错误信息。
5. 往返测试证明逐表行数 + 内容哈希一致。

### 非目标
- 不做「一键远程还原」(本系统只生成归档与还原说明;还原是人工在目标机执行)。
- 不自动导出 ClickHouse 日志库(只生成命令 + 明确告警)。
- 不备份 Redis、进程日志(默认)、源码、镜像。
- 不改动 jobs 相关的共享结构(分组/批量由 jobs-batch-grouping 拥有)。仅**最小新增** `type` 枚举值、`newapi` 配置块、`jobSecrets` 一条。

---

## 2. 边界与文件归属

| 文件 | 归属 | 本任务动作 |
|---|---|---|
| `shared/contracts.mjs` | jobs-batch-grouping(全部)/ 本任务只在 `type` 枚举 + 新增 `newapi` 块 | ⚠️ 最小新增(`'newapi'` 到枚举;新增 `newapi: {...}` schema;`newSecrets` 无关) |
| `server/store.mjs` | jobs-batch-grouping(jobs 相关)/ 本任务只在 `jobSecrets` 数组加一条 | ⚠️ 最小新增一行 |
| `server/app.mjs` | 共享;`validateJob` 的 `else` 分支需要 newapi 分支 | ⚠️ 最小新增(新函数从 `server/newapi.mjs` 导入并调用) |
| **`server/newapi.mjs`** | 本任务 | ✅ 新建,承载全部 newapi 逻辑 |
| **`web/src/components/NewApiFields.vue`** | 本任务 | ✅ 新建,承载 newapi 表单字段 |
| `web/src/components/JobEditor.vue` | jobs-batch-grouping | ⚠️ SHELL-DONE 后最小接线(引入 NewApiFields + 类型按钮 + 1 个校验分支) |
| `web/src/types.ts` | 共享,只增 | ⚠️ `Run.type` 加 `'newapi'` |
| `server/backup.mjs` | 共享 | ✅ 最小新增:`prepareNewApi` 调用点(1 个 `else if`)+ 分支准备 |
| `tests/*` | 各任务自己的新文件 | ✅ 新建 `tests/newapi.test.mjs` |
| `README*`、`.trellis/spec/backend/backup-lifecycle.md` | 共享文档 | ✅ 追加章节 |

**冲突策略**:优先新建文件;对共享文件的改动全部控制在「加一行 / 加一个分支」级别,改完立即路径限定提交(参考全局规则 1、2)。

---

## 3. 契约(contracts)

### 3.1 `jobSchema.type` 枚举

```js
type: z.enum(['directory', 'vaultwarden', 'system', 'newapi']).default('directory')
```

### 3.2 新增 `newapi` 配置块

```js
newapi: z.object({
  // 数据目录(= docker-compose 里的 ./data:/data)。SQLite 相对路径以此目录为基准。
  dataDir: z.string().default(''),
  // 主库
  dbType: z.enum(['sqlite', 'mysql', 'postgresql']).default('sqlite'),
  sqlitePath: z.string().default(''),          // 空 => <dataDir>/one-api.db
  // 日志库:same = 与主库同库(LOG_SQL_DSN 为空);否则独立
  logDbType: z.enum(['same', 'sqlite', 'mysql', 'postgresql', 'clickhouse']).default('same'),
  logSqlitePath: z.string().default(''),
  // 连接参数(主库与日志库各一套,各自独立 host/port/db)
  database: databaseSchema.default({}),         // 主库
  logDatabase: databaseSchema.default({}),      // 日志库(logDbType 非 same 时使用)
  // 外部状态
  envFilePath: z.string().default(''),          // 必填:.env 原值
  composeFilePath: z.string().default(''),      // 可选:docker-compose.yml
  serviceFilePath: z.string().default(''),      // 可选:new-api.service
  proxyConfigPath: z.string().default(''),      // 可选:反代配置文件或目录
  pluginsPath: z.string().default(''),           // 可选:插件脚本目录
  includeLogs: z.boolean().default(false),       // 是否包含 logs/ 进程日志
  logsPath: z.string().default(''),              // logs/ 目录
  includeLogTable: z.boolean().default(true),    // 是否包含 logs 表(大表开关)
  appVersion: z.string().default(''),            // 记录用:new-api 镜像 tag/版本
}).default({}),
```

`databaseSchema` 与 Vaultwarden 的 `database` 子结构一致(`host/port/name/username/password/sslMode/sslCa/sslCert/sslKey`),**复用同一形状**以共享命令构造与 TLS 处理逻辑。

### 3.3 机密字段

`server/store.mjs`:

```js
const jobSecrets = [
  ['archive', 'password'],
  ['vaultwarden', 'database', 'password'],
  ['newapi', 'database', 'password'],       // 新增
  ['newapi', 'logDatabase', 'password'],    // 新增
];
```

- 公开读取时自动变成 `passwordSet: true` 并删除明文(既有 `decode` 逻辑)。
- `.env` 文件本身**从不**通过 API 返回内容;只返回 `envFileSet: boolean` 之类的派生标记(在 `GET /api/jobs/:id` 的 `validateJob` 之后由前端按 `envFilePath` 是否为空判断,无需新增响应字段)。

### 3.4 校验(`validateNewApiJob`)

在 `server/newapi.mjs` 导出:

```js
export function validateNewApiJob(job, config, { allowMissing = false } = {})
```

规则:
1. `dataDir` 必填 → `resolveSourcePath(config, dataDir, { directory: true, allowMissing })`,回写 `job.newapi.dataDir` 与 `job.sourcePath`(与 vaultwarden 一致的「sourcePath = dataDir」约定)。
2. `sqlitePath` 为空时视为 `<dataDir>/one-api.db`(不强制存在:库文件可能尚未创建 → `allowMissing`)。
3. `dbType !== 'sqlite'` 时 `database.host/name/username` 必填且不得含 `\r\n\0`。
4. `logDbType !== 'same'` 时 `logDatabase` 同样校验;`clickhouse` 时额外要求 `logDatabase.name` 且给出「本系统不会自动导出」的 warning(写入 run `warnings`)。
5. `envFilePath` **必填**(没有 `.env` 归档不满足「一模一样还原」)→ `resolveSourcePath(config, envFilePath, { allowMissing })`。
6. `composeFilePath` / `serviceFilePath` / `proxyConfigPath` / `pluginsPath` / `logsPath` 可选;非空时 `resolveSourcePath`(目录型字段用 `{ directory: true }`)。
7. TLS 文件 `sslCa/sslCert/sslKey` 两个 DB 块都走 `resolveSourcePath`。
8. **加密强制**:`archive.format === '7z' && archive.encrypted === true`,否则
   `throw new AppError('newapi backups contain credentials and must use an encrypted 7z archive.', 400, 'NEWAPI_ARCHIVE_REQUIRED')`。
   (与 system 任务的强制策略同构,但理由不同:这里是机密面更大。)
9. `watch` 必须为 false(非 directory 已由 `validateJob` 全局拦下,这里只补类型守卫)。
10. `includeLogs === true` 时 `logsPath` 必填。

---

## 4. 归档内容布局

```
<payload>/
├── manifest.json
├── RESTORE.md
├── db/
│   ├── main.sqlite3 | main.sql | main.dump
│   └── log.sqlite3  | log.sql  | log.dump        (logDbType !== 'same' 时)
├── config/
│   ├── env                                        (.env 原值, mode 0600)
│   ├── compose.yaml                               (可选)
│   ├── service.unit                               (可选)
│   └── proxy/...                                  (可选, 目录整体 tar 后放入)
├── data/                                            (dataDir 内容, 排除缓存与 db 文件)
│   └── ...                                          (排除 new-api-body-cache)
├── logs/                                            (includeLogs 时才出现)
└── plugins/                                         (pluginsPath 存在时才出现)
```

**`data/` 的排除规则**(`server/newapi.mjs` 内常量):
```js
const dataDirExcludes = [
  'new-api-body-cache', 'new-api-body-cache/**',
  '*.db-journal', '*.db-wal', '*.db-shm',
];
```
理由:磁盘缓存可再生(`common/disk_cache.go`);WAL/SHM 已由一致性快照覆盖,重复拷入会让还原者误用。

---

## 5. 数据流

```
POST /api/jobs (type=newapi)
  → validateJob() → validateNewApiJob()   [路径沙箱 + 加密强制 + DB 参数]
  → store.saveJob()  (password 字段 seal)
  → job.newapi.dataDir 落盘

POST /api/jobs/:id/run
  → backupService.enqueue()
  → execute() → phase('preparing')
     → else if (job.type === 'newapi') prepareNewApi(job, payload, stamp, signal, secrets, runId)
          1. resolveSourcePath 全部输入
          2. 主库快照
             sqlite  → node:sqlite backup API(readOnly) 或 sqlite3 CLI VACUUM INTO
             mysql   → mariadb-dump --single-transaction ...
             pgsql   → pg_dump -Fc
          3. 日志库快照(同上, 或 clickhouse → 写命令 + warning)
          4. 副本 config/*(env 必, 其余可选)
          5. tar data/ (排除 dataDirExcludes)
          6. 可选: logs/、plugins/
          7. 统计每表行数 + 快照 sha256 → manifest.json
          8. 生成 RESTORE.md
  → phase('archiving') → 7z AES-256(既有逻辑)
  → verify → upload → verifyRemote → complete.json(既有逻辑)
```

**为什么在 `prepareNewApi` 里做 manifest,而不是在 `archiving` 之后**:manifest 需要「库表行数」与「各文件哈希」,必须在 payload 定型时计算;归档后的 `complete.json`(远端完成记录)是另一层(既有逻辑不变)。

---

## 6. 关键实现决策与取舍

| 决策点 | 选择 | 理由 / 备选 |
|---|---|---|
| SQLite 快照方式 | **优先 `node:sqlite` 的 `backup()` API(与 Vaultwarden/system 适配器同一代码路径)**,可选降级到 `sqlite3 <path> "VACUUM INTO '<out>'"` | new-api 镜像内**可能无 `sqlite3` CLI**(纯 Go 驱动);而源库文件通常在宿主 `data/` 可读 → Node 原生 backup 最可靠。备选:`VACUUM INTO` 需 CLI,仅当 `SQLITE_BINARY` 可用且文件不可读时使用 |
| 快照后处理 | `PRAGMA journal_mode=DELETE` + `PRAGMA integrity_check` | 与既有 Vaultwarden 路径一致;还原方无需 `-wal` 伴随文件 |
| MySQL 口令传递 | 临时 `--defaults-extra-file`(0600,用完即删) | 口令绝不进 argv;复用 `backup.mjs` 现有写法 |
| PG 口令传递 | `PGPASSWORD` 环境变量 | 同上 |
| 加密强制 | 硬性要求 `encrypted === true` 且 `format === '7z'` | 归档含 `CRYPTO_SECRET` 与 DB 口令;与 system 任务同构 |
| ClickHouse | 不自动导出,写 `warnings` + `RESTORE.md` 命令 | 不同版本 CLI/权限差异大,静默失败风险高于显式告知 |
| `logs` 大表 | `includeLogTable` 开关(默认 true) | 用户明确要求备份「消耗额度/tokens 数」,默认必须含;关掉时 manifest 标记 |
| Redis | 不备份 | 权威数据在 SQL(见 inventory §3) |
| 进程日志 | `includeLogs` 默认 false | 非还原必需;需要时可选 |
| 归档目录布局 | `db/ config/ data/ logs/ plugins/` 顶层分区 | 还原步骤可一一对应,避免「散落文件」 |
| 版本一致性 | manifest 记录 `appVersion`,`RESTORE.md` 要求同版本镜像 | `AutoMigrate` 在版本更高时会改表 |
| 表清单来源 | **实际查询**(`sqlite_master` / `information_schema`),不硬编码 | 不同版本表集合不同;硬编码必然过期 |

---

## 7. 安全设计

1. **secrets 列表**:`prepareNewApi` 内所有 `runTool` 调用传入 `secrets = [newapi.database.password, newapi.logDatabase.password, archive.password, ...]`,`onLine` 一律经 `log(..., secrets)` redact。
2. **manifest 不含口令**:`mainDatabase.database` 只写库名;DSN 结构/口令一律不落 manifest。
3. **API 响应**:`store.decode` 已把 `newapi.database.password` / `newapi.logDatabase.password` 替换成 `passwordSet`。
4. **临时明文**:`payload/` 在归档校验通过后由既有逻辑 `rm -rf`;失败路径由既有 `finally` 清理。
5. **路径**:全部经 `resolveSourcePath`,禁止符号链接与越出 `SOURCE_ROOTS`。
6. **`.env` 权限**:解出到 payload 时 `chmod 0600`;归档内是 7z 加密,文件名也加密(`-mhe=on`,既有 `archiveArguments`)。
7. **错误信息**:`AppError` 消息不含口令;子进程 stderr 经 `redact`。

---

## 8. 兼容性

| 维度 | 影响 | 处理 |
|---|---|---|
| 旧任务数据 | 既有 job 的 JSON 里没有 `newapi` 键 | `jobSchema` 的 `.default({})` 补齐;`oldJob` 读取时 `newapi` 为默认对象 |
| `jobSecrets` 新增两条 | 旧任务这两个字段为 `undefined` → `encode` 写成 `''` | `decode` 时 `passwordSet: false`,无副作用 |
| `type` 枚举新增 | 旧代码的 `switch(type)` | `backup.mjs` 用 `else if` 链,新增分支不影响旧分支 |
| 前端旧组件 | `Run.type` union 加 `'newapi'` | 仅类型,运行时无影响 |
| 数据库 schema | **无**新表/新列 | 只用既有 `jobs.data` JSON |
| 迁移 | 无需迁移 | 契约 `.default()`,读旧数据零改动 |

**回滚**:删掉 `type` 枚举值 + `newapi` 块 + `server/newapi.mjs` + 前端组件即可;已保存的 `newapi` 任务在回滚后会因枚举校验失败而被跳过(需在回滚前手动导出/删除这类任务)。风险低且可逆。

---

## 9. 发布形态

单次提交批次(按全局规则「立刻提交」):
1. `docs(task): add newapi backup research`
2. `feat(contracts): add newapi job type and config block`(+ store `jobSecrets`)
3. `feat(server): add newapi data backup adapter`(`server/newapi.mjs` + `backup.mjs`/`app.mjs` 接线)
4. `test(server): cover newapi snapshot, manifest and round-trip restore`
5. `feat(web): add newapi job editor fields`(SHELL-DONE 之后)
6. `docs: document newapi backup type in README and spec`

---

## 10. 验收对应

| prd 验收项 | 本设计的落实 |
|---|---|
| 两份调研完整、无「未知」 | 已完成(仅 2 项「需部署期确认」并给出命令) |
| 新增类型可创建/编辑/执行 | §3 契约 + §5 数据流 |
| 归档不含源码与镜像 | §4 布局 + §1 非目标 |
| 往返测试逐表一致 | §5 步 2-7 + `tests/newapi.test.mjs`(见 implement.md) |
| 无密钥泄露 | §7 |
| `check/test/build/check:browser` 全绿 | implement.md 验证命令 |
| 更新 spec/README | 提交批次 6 |
