# p5 对 review-of-p5 的修复回应

- 作者:`w1H:p5`(newapi-data-backup)
- 复审:`w1H:p3`(ui-shell),报告见 `review-of-p5.md`
- 结论:**D1–D7 全部修复并各自提交 + 补测试。** 4 个缺陷全部确认为真实缺陷,无一条是误报。

---

## 修复清单

| 缺陷 | 严重度 | 修复提交 | 关键改动 |
|---|---|---|---|
| **D2** `WITHOUT ROWID` 摘要崩溃 + `null===null` 假通过 | 正确性 | `ecbdb51` | 新增 `digestOrderColumns()`;`tableDigest()` 优先按声明主键排序,普通表回退 `rowid`,`WITHOUT ROWID` 用**全列值排序**后哈希 → 永不返回 `null`。删除了 `sqliteTableDigests()` 里吞掉异常的 `catch` 降级分支。 |
| **D3** 往返测试从未创建/解包真实归档 | 正确性 | `3df0898` | 新增 `packArchive()`/`unpackArchive()`;往返测试改为:用 `backup.mjs` 的 `archiveArguments()` 打**真实加密 7z** → `7z x` 解包到**全新空目录** → 再逐表比对。并断言「无密码 `7z l` 必须失败」「错误密码解包必须失败且不产出 manifest」。 |
| **D1** SQLite 下 `includeLogTable=false` 被静默忽略且告警自相矛盾 | 正确性 | `8af9a2e` | `validateNewApiJob()` 在 `dbType==='sqlite'` 或 `logDbType==='sqlite'` 且 `includeLogTable===false` 时抛 `NEWAPI_LOG_TABLE_REQUIRED`(400);`newApiScopeWarnings()` 改为**互斥分支**,同一次 run 只会出现一条 logs 告警;`NewApiFields.vue` 对 SQLite 隐藏勾选并改显示说明文字。 |
| **D4** `sqlitePath` 未约束到 `dataDir` | 意图未校验 | `d3b0ee4` | 改为**硬约束**:越出 `dataDir` 抛 `NEWAPI_SQLITE_OUTSIDE_DATA_DIR`(400),并在 manifest 记录 `mainDatabase.dataDirRelativePath` 供还原方核对。选硬约束而非只告警,因为「库在数据目录外」会让归档不再自描述,而这类任务可以改选正确的数据目录来满足。 |
| **D5** RESTORE.md 对 PG/MySQL 输出空行数表 | 文档 | `8d794eb` | `main.tables.length===0` 时不再输出表头,改为明确说明「未包含逐表行数与内容哈希」并给出 `SELECT count(*)` 自查命令。 |
| **D6** 日志库命令留 `<db>`/`<restore-tool>` 占位符 | 文档 | `8d794eb` | 按 `log.type` 分别生成**具体**的 `pg_restore` / `mysql` 命令,只保留必须由操作者填的 `<user>` 并附说明。 |
| **D7** `recoveryPoint` 是第二次 `now()` | 准确性 | `8d794eb` | 在主库快照完成时采样 `mainDatabase.snapshotAt`,`recoveryPoint` 复用它;`generatedAt` 仍是 manifest 写入时间。 |

配套:`82dabd3` 更新 `.trellis/spec/backend/backup-lifecycle.md` 记录以上契约。
另:`e9e3900` 修正我自己写错的 `dataDirRelativePath` 断言(初值写成 `.`,实际是库文件相对路径 `one-api.db`)。

---

## 逐项验证证据

### D2 — 摘要不再可能为 null

```
✔ digest: WITHOUT ROWID tables still get a stable content hash
✔ digest: every sqlite table yields a non-null sha256
```

- `digestOrderColumns(db,'kv')` → `['k']`(WITHOUT ROWID 用主键)
- `digestOrderColumns(db,'plain')` → `['id']`
- `digestOrderColumns(db,'nokey')` → `['rowid']`
- 插入顺序打乱后摘要不变(证明不依赖存储序)
- `sqliteTableDigests()` 对**每张表**都断言 `sha256` 非空且匹配 `/^[\da-f]{64}$/`

往返测试里新增:

```js
assert.ok(expected.sha256, `${expected.name} must carry a content digest`);
assert.ok(actual.sha256, `${expected.name} must carry a content digest after restore`);
```

→ `null === null` 的假通过路径已彻底堵死。

### D3 — 真归档往返

测试流程与你的要求一致:

1. `prepareNewApi()` 生成 payload
2. `packArchive()` → **真实 7z**,参数来自 `backup.mjs` 的 `archiveArguments()`(与生产同一函数,`-mhe=on` 加密文件名)
3. 断言无密码 `7z l` 失败 → 证明**确实加密**
4. `unpackArchive()` → `7z x` 到 `path.join(root,'extracted')`(全新空目录)
5. 断言解包结果不含 `new-api-body-cache`、不含 `*.db-wal`/`*.db-shm`
6. 按 RESTORE.md:新 `data/` + 解包出的 `.env` + `data/` 内容
7. 逐表行数 + 内容 SHA-256 比对(每张表都断言非空)
8. 内容抽查:中文配置值、渠道 key、`sum(prompt_tokens)=1800`、`sum(completion_tokens)=1200`、`sum(quota)=3000`、中文 `trade_no`、`setups.version`
9. 错误密码解包必须失败,且不产出 `manifest.json`

> 说明:我原先还写了一个 tar.gz 往返用例,但 `validateNewApiJob()` 会以 `NEWAPI_ARCHIVE_REQUIRED` 拒绝非加密 7z——这是**有意的安全设计**(归档含 `CRYPTO_SECRET`),所以该用例与契约冲突,已删除而非放宽校验。

### D1 — 三者一致

```
✔ validateNewApiJob … (含 NEWAPI_LOG_TABLE_REQUIRED 断言 ×2)
✔ scope warnings never contradict the archived logs table
```

- sqlite + `includeLogTable=false` → `NEWAPI_LOG_TABLE_REQUIRED`
- `logDbType='sqlite'` + `includeLogTable=false` → 同上
- mysql + `includeLogTable=false` → 通过,且 logs 相关告警**恰好 1 条**(且是「已排除」语义)
- `logDbType='same'` + 包含 logs → logs 相关告警**恰好 1 条**(「随主库归档」语义),不再出现「已排除」字样
- 独立 server 日志库 + 包含 logs → **0 条** logs 告警
- UI:SQLite 时勾选隐藏,改显示「SQLite 快照是单个文件,无法只排除 logs 表,因此始终包含。」;切换类型时强制 `includeLogTable=true`

### D4 — 硬约束 + manifest 可核对

- `sqlitePath` 在 `sources/other-db/one-api.db`(源根内但在 dataDir 外)→ `NEWAPI_SQLITE_OUTSIDE_DATA_DIR`
- `dataDir/nested/one-api.db` → 通过
- manifest 记录 `dataDirRelativePath: 'one-api.db'`,测试断言该值

### D5/D6/D7

```
✔ RESTORE.md: no empty row-count table for server dumps, concrete log commands
✔ manifest recoveryPoint is the snapshot instant, not manifest write time
```

- 无行数时不出现 `| 表 | 行数 |` 表头,改为「未包含 postgresql 的逐表行数与内容哈希」+ 实际 SQL
- 不再出现 `<restore-tool>` / `<db>`;PG 日志库给出 `pg_restore -U <user> -d new-api-log`,MySQL 给出 ``CREATE DATABASE IF NOT EXISTS `new-api-log` ``
- `recoveryPoint === mainDatabase.snapshotAt`,且 `>= 开始时间`、`<= generatedAt`

---

## 全量验证

| 命令 | 结果 |
|---|---|
| `node --test tests/newapi.test.mjs` | 13 项:12 pass / 0 fail / 1 skip(Windows 符号链接) |
| `npm test` | **81 项:80 pass / 0 fail / 1 skip** |
| `npm run check` | 绿 |
| `npm run build` | 绿 |

> 注:`tests/newapi.test.mjs` 的 7z 用例按约定用 `skip: !liveSevenZip`,本机 `.artifacts/tools/7zip/x64/7za.exe` 存在,实际**执行**并通过。

---

## 提交清单

```
ecbdb51 fix(server): give WITHOUT ROWID tables a real content digest
3df0898 test(server): round trip through the real encrypted 7z archive
8af9a2e fix(server): reject sqlite snapshots that exclude the logs table
d3b0ee4 fix(server): require the newapi sqlite file to live inside the data dir
e9e3900 test(server): assert the recorded data dir relative database path
8d794eb fix(server): make newapi restore guide and recovery point accurate
82dabd3 docs(spec): record newapi digest, logs and restore guide contracts
```

全部路径限定提交,无 amend、无 push,提交前均 `git diff --cached --stat` 自查(其间两次发现并有 p3 的任务文件误入暂存区,已 `git restore --staged` 剔除)。

---

## 请 @p3 复核的落点

1. `server/newapi.mjs`:`digestOrderColumns` / `tableDigest` / `newApiScopeWarnings` / `validateNewApiJob` 的 sqlite 分支 / `buildRestoreDocument` 的 tables 分支与日志库分支 / `manifest.recoveryPoint`
2. `tests/newapi.test.mjs`:真实 7z 往返、摘要非空断言、告警互斥断言、RESTORE.md 断言
3. `web/src/components/NewApiFields.vue`:`canExcludeLogTable` 与类型切换时的强制行为
