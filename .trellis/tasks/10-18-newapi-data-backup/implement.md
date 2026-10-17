# 执行计划:newapi 数据备份

前置:`research/newapi-data-inventory.md`、`research/newapi-backup-rules.md`、`design.md` 已就绪。
共享文件规则:改共享文件只做「加一行 / 加一个分支」,改完立刻路径限定提交。

---

## 阶段 A:契约与存储(最小改动,先提交)

- [ ] A1 `shared/contracts.mjs`
  - `jobSchema.type` 枚举追加 `'newapi'`
  - 新增 `newapi` 配置块(见 design §3.2),`database`/`logDatabase` 复用与 Vaultwarden 同形的子 schema
  - 保持 `newJob(type)` 对 `newapi` 可用(`jobSchema.omit(...).parse({ type: 'newapi' })` 应产出默认 `newapi` 对象)
- [ ] A2 `server/store.mjs`
  - `jobSecrets` 追加 `['newapi','database','password']`、`['newapi','logDatabase','password']`(仅两行)
- [ ] 提交:`feat(contracts): add newapi job type and config block`
- [ ] 验证:`node -e "import('./shared/contracts.mjs').then(m=>console.log(m.newJob('newapi').newapi))"`

## 阶段 B:后端适配器(核心,独立文件)

- [ ] B1 新建 `server/newapi.mjs`,导出:
  - `validateNewApiJob(job, config, { allowMissing })` —— design §3.4 的 10 条规则
  - `newApiSecrets(job)` —— 返回需要 redact 的字符串数组
  - `prepareNewApi({ job, payload, stamp, signal, secrets, runId, config, sevenZipBinary, ...deps })`:
    1. 主库快照:sqlite(`node:sqlite` `backup()`) / mysql(`mariadb-dump --single-transaction --quick --skip-lock-tables --routines --events --triggers --databases -- <db>`,走 `--defaults-extra-file`) / pgsql(`pg_dump -Fc --no-password`,口令走 `PGPASSWORD`)
    2. 日志库快照(`logDbType` same→跳过 / sqlite / mysql / pgsql / clickhouse→不导出 + warning)
    3. SQLite 快照后 `PRAGMA journal_mode=DELETE` + `PRAGMA integrity_check === 'ok'`
    4. `config/env`(必,0600)、`config/compose.yaml`、`config/service.unit`、`config/proxy/`
    5. `tar` 打包 `dataDir` → `data/`,`--exclude` 掉 `dataDirExcludes`
    6. 可选 `logs/`、`plugins/`
    7. 统计表清单 + 行数 + 内容摘要 → `manifest.json`(design §5.1 字段)
    8. 生成 `RESTORE.md`(从 `newapi-backup-rules.md` §4 抽出的可执行步骤)
  - `collectTableStats(dbHandle, type)` —— 实际查询表清单(SQLite `sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'` / MySQL `information_schema.tables` / PG `information_schema.tables`)
  - `buildRestoreDocument(manifest)` —— 纯函数,便于单测
- [ ] B2 `server/app.mjs` `validateJob`:在 `else if (job.type === 'directory')` 之后插入 `else if (job.type === 'newapi') validateNewApiJob(job, config, { allowMissing })`
  - 同时确认 `catch` 里 `job.newapi` 存在(契约 default 保证)
- [ ] B3 `server/backup.mjs`:在 `execute()` 的 `else if (job.type === 'vaultwarden')` 之后加一个 `else if (job.type === 'newapi') await prepareNewApi(...)`;`secretsFor(job)` 追加 newapi 的两个口令
- [ ] 提交:`feat(server): add newapi data backup adapter`
- [ ] 验证:`npm test` 不回归;手动 `node --input-type=module -e "import('./server/newapi.mjs')"`

## 阶段 C:测试

- [ ] C1 新建 `tests/newapi.test.mjs`:
  - **契约**:`jobSchema` 接受 `type:'newapi'`;`newJob('newapi')` 默认块正确;未知字段被忽略
  - **路径沙箱**:`dataDir` 越出 `SOURCE_ROOTS` → 403;符号链接 → 403;缺 `.env` 路径 → 400/404
  - **加密强制**:`format:'tar.gz'` 或 `encrypted:false` → 400 `NEWAPI_ARCHIVE_REQUIRED`
  - **密钥不泄露**:构造 job → `store.getJob()` 无 `password` 只有 `passwordSet`;`manifest.json` 文本不含口令字符串;`run.logs` 不含口令
  - **排除规则**:`data/` 打包不含 `new-api-body-cache/**`、`*.db-wal`、`*.db-shm`
  - **manifest 正确**:`kind`、`mainDatabase.type`、`tables` 行数与真实库一致、`files[].sha256` 与实际文件一致
  - **命令构造**:MySQL/PG 的 argv 不含口令;库名走 `--`;PG 走 `PGPASSWORD`
  - **往返测试**(核心):
    1. 用 `node:sqlite` 建一个 newapi 风格测试库:至少 `users`、`tokens`、`channels`、`options`、`logs`、`topups`、`redemptions`、`setups` 8 张表,各塞 2-3 行含中文与特殊字符的数据
    2. 造一个 `dataDir`,内含测试库 + `new-api-body-cache/`(应被排除)+ 一个 `.env`
    3. 调用 `prepareNewApi` 生成 payload
    4. 把 payload 的 `db/main.sqlite3` + `config/env` 复制到**另一个空目录**
    5. 打开还原后的库:逐表 `count(*)` 与内容摘要 sha256 必须与 manifest 完全相等;`PRAGMA integrity_check` = ok
    6. 断言 `new-api-body-cache` 未被还原(即不在 `data/` 里)
- [ ] 提交:`test(server): cover newapi snapshot, manifest and round-trip restore`
- [ ] 验证:`npm test`

## 阶段 D:前端(SHELL-DONE 之后才动 JobEditor)

- [ ] D0 检查 board 是否有 `SHELL-DONE`;没有则**先做 E1/E2(文档与 spec)**,D 阶段插空
- [ ] D1 新建 `web/src/components/NewApiFields.vue`
  - props: `modelValue`(job 的 `newapi` 块)+ `passwordSet` 标记 + `sourcePicker` 事件
  - 字段:数据目录(带 PathPicker)、主库类型、SQLite 路径、DB host/port/name/user/password/sslMode/CA/cert/key、日志库类型(+ 独立连接)、`.env` 路径(带 PathPicker,标记「必填」)、compose/service/反代/插件目录、`includeLogs`+logsPath、`includeLogTable`、appVersion
  - 样式只复用既有 class(`field`/`form-grid`/`input-action`/`check-row`),**不新增全局样式**,不改 `style.css`
- [ ] D2 `web/src/components/JobEditor.vue` 最小接线:
  - `import NewApiFields from './NewApiFields.vue'`
  - 类型分段按钮加一个「new-api」
  - `<template v-else-if="form.type === 'newapi'"><NewApiFields ... /></template>`
  - `save()` 加一条校验:`form.type === 'newapi' && !form.newapi.dataDir` → 提示;`!form.newapi.envFilePath` → 提示
  - `initialType` prop 联合类型加 `'newapi'`
- [ ] D3 `web/src/types.ts`:`Run.type` 加 `'newapi'`;`Job` 加 `newapi: { database: { passwordSet?: boolean }, logDatabase: { passwordSet?: boolean } }` 交叉类型
- [ ] 提交:`feat(web): add newapi job editor fields`
- [ ] 验证:`npm run check`、`npm run build`、`npm run check:browser`(端口 16404,真实看图)

## 阶段 E:文档与 spec

- [ ] E1 `README.md` / `README.en.md` / `README.zh-TW.md`:在「任务类型」处追加 newapi 说明(一段 + 表格行)
- [ ] E2 `.trellis/spec/backend/backup-lifecycle.md`:在 §3 Contracts 追加 newapi 契约条目(一致性快照/强制加密/manifest 字段/ClickHouse 手导/`includeLogTable` 开关/排除规则),§6 Tests Required 补 `tests/newapi.test.mjs`
- [ ] 提交:`docs: document newapi backup type`

## 阶段 F:收尾

- [ ] F1 全量验证:`npm run check` && `npm test` && `npm run build` && `npm run check:browser`
- [ ] F2 `git diff --cached --stat` 自查 → 路径限定提交
- [ ] F3 board 追加 `DONE`;按全局规则 9 审查**下一个 pane**(p5 → p2 = jobs-batch-grouping),写 `review-of-jobs-batch-grouping.md`

---

## 验证命令

```powershell
cd D:\MyNewWebProjects\azurekiln-backup-system
npm run check
npm test
npm run build
# 界面(开发端口 16404,临时数据放 .tmp-p5)
$env:BACKUP_PORT='16404'; $env:DATA_DIR='.tmp-p5/data'; $env:SOURCE_ROOTS='.tmp-p5/sources'; npm run dev:server
npm run check:browser
```

## 评审门

| 门 | 条件 |
|---|---|
| G1 | 阶段 A 提交后 `node -e` 契约自检通过 |
| G2 | 阶段 B 后 `npm test` 无回归(既有 4 个测试文件全绿) |
| G3 | 阶段 C 往返测试通过(逐表行数 + 内容哈希) |
| G4 | 阶段 D 前 board 有 `SHELL-DONE`;若没有则先做 E,再做 D |
| G5 | 最终 `check/test/build/check:browser` 全绿 |
| G6 | 提交前 `git diff --cached --stat` 只含本任务文件 |

## 回滚点

| 回滚点 | 操作 |
|---|---|
| R1 阶段 A 后 | `git revert`(不 amend):移除枚举值 + 配置块 + jobSecrets 两行 |
| R2 阶段 B 后 | 删除 `server/newapi.mjs`,移除 app/backup 的 3 处分支 |
| R3 阶段 D 后 | 删除 `NewApiFields.vue`,还原 JobEditor 的类型按钮与 v-else-if |
| 已存在的 newapi 任务 | 回滚前需先导出/删除(否则枚举校验失败) |
