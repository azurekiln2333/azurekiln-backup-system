# new-api 备份与还原规则

配套文档:`newapi-data-inventory.md`(数据清单与覆盖矩阵)。本文定义 **纳入 / 排除 / 一致性 / 还原 / 校验** 五条规则,目标:把归档拿到**另一台机器**解压后,数据与源环境**一模一样**;归档内**不含**程序源码与 Docker 镜像。

---

## 0. 一句话规则

> **一库(主库) + 一库(日志库,若独立) + 一个配置目录(`.env`/compose/systemd/反代) + (可选)插件脚本与 `logs/`;全部装进一个 AES-256 加密的 7z,并附 `manifest.json` 与 `RESTORE.md`。**

---

## 1. 纳入清单 ✅

| 组 | 具体内容 | 归档内路径(建议) | 说明 |
|---|---|---|---|
| 主库快照 | SQLite:一致性快照文件;MySQL:`--single-transaction` 导出;PG:`pg_dump -Fc` | `db/main.{sqlite3/sql/dump}` | **不能裸拷正在写的 db** |
| 日志库快照 | 仅当 `LOG_SQL_DSN` 非空 | `db/log.{sqlite3/sql/dump}` | `logs` + 审计表的真相源 |
| ClickHouse 日志库 | 仅当日志库是 ClickHouse | `db/log.clickhouse.txt`(本系统不自动执行) | 见 §3.5 |
| 部署环境 | `.env`(**原值**,含所有密钥) | `config/env` | 还原后**禁止修改** |
| 编排 | `docker-compose.yml` / `new-api.service` | `config/compose.yaml` / `config/service.unit` | 保证拓扑一致:`./data:/data`、`./logs:/app/logs`、启动参数 `--log-dir` |
| 反代 | Nginx/Caddy/Traefik 站点配置(若提供) | `config/proxy/…` | 影响 `TRUSTED_PROXIES`、`SESSION_COOKIE_TRUSTED_URL` |
| 数据目录 | `data/`(排除缓存,见 §2) | `data/` | SQLite 已替换为一致性快照,不重复放原 db 文件 |
| 插件脚本(⚠️条件) | `pkg/jsplugin` 在宿主机挂载的脚本目录 | `plugins/` | 存在才纳入,见 inventory §5.1 |
| 进程日志(⚠️可选) | `logs/*.log` | `logs/` | 默认**不纳入**;开启「含日志」时才打包 |

---

## 2. 排除清单 ❌

| 排除项 | 理由 |
|---|---|
| new-api 程序源码(`*.go`、`web/src`、`go.mod` …) | 用户明确要求;且 `main.go` 用 `//go:embed web/dist` 把前端打进二进制 |
| Docker 镜像 / `docker save` 产物 | 用户明确要求;镜像可由 `docker pull calciumion/new-api:<tag>` 复现 |
| `web/dist`、`bin/`、`makefile` 构建产物 | 构建产物,镜像内已有 |
| `tiktoken_cache/` | 可重新下载 |
| `data/new-api-body-cache/`(磁盘缓存) | `common/disk_cache.go`,启动时 `CleanupOldCacheFiles()` 清理,可再生 |
| `node_modules/`、`.git/`、`.gocache*`、`.gomodcache` | 依赖缓存 |
| `logs/`(默认) | 进程日志,非还原必需;开启选项才纳入 |
| SQLite 的 `-wal` / `-shm` 原文件 | 一致性由在线快照保证;拷 WAL 反而可能造成「快照 + 过期 WAL」不一致 |
| Redis RDB/AOF | 缓存与批次队列,权威数据在 SQL;见 inventory §3 风险条目 |

> **排除后仍能一模一样还原的原因**:唯一真相源是「两个数据库 + `.env` + 挂载目录里的数据」。其余全部是「由源码/镜像/网络再生」的派生物。

---

## 3. 一致性规则(最关键)

### 3.1 SQLite:必须在线快照,禁止裸拷

**问题**:`one-api.db` 处于 WAL 模式(`common/database.go:64`),`cp one-api.db` 会漏掉 `-wal` 中已提交但未 checkpoint 的事务,得到**逻辑不一致**的库(可能触发 `database disk image is malformed` 或静默丢数据)。

| 方案 | 命令 | 评价 |
|---|---|---|
| A. `VACUUM INTO` | `VACUUM INTO '/backup/one-api.snapshot.db'` | 单语句、原子、生成紧凑文件;需要能连上该库的 SQL 客户端 |
| B. `.backup`(backup API) | `sqlite3 one-api.db ".backup '/backup/one-api.snapshot.db'"` | 页级在线备份,适合大库;需要 `sqlite3` CLI |
| C. 停写 + 拷 db + `-wal` | `systemctl stop new-api && cp one-api.db* …` | 需要停机,最稳但不可在线 |

**本项目实现选择**:
- 宿主机能连库时,**优先 A(`VACUUM INTO`)**,因为它不依赖 `sqlite3` CLI 的交互模式,且结果天然是「单一自洽文件」。快照完成后 `PRAGMA journal_mode=DELETE`(使还原文件无需 WAL 伴随),再 `PRAGMA integrity_check` 必须返回 `ok`。
- 为什么不用 `cp`:见上。
- **注意**:new-api 官方 SQLite 驱动是纯 Go(`glebarez/sqlite`),容器内**可能没有 `sqlite3` CLI**。因此本系统**不假设**能执行 CLI:提供两种模式 —— 「命令模板模式」(生成 `VACUUM INTO` 命令,由用户在有 sqlite3 的宿主机执行,或指定 `SQLITE_BIN`)与「文件模式」(源库路径可读时用本系统的 Node 原生 SQLite 在线备份 API 直接生成快照,与 Vaultwarden 适配器同一套代码路径)。
- 若走「文件模式」,路径必须落在 `SOURCE_ROOTS` 沙箱内,且源库以 `readOnly` 打开、带 `timeout`。

### 3.2 MySQL / MariaDB

```
mariadb-dump --defaults-extra-file=<600临时文件> \
  --single-transaction --quick --skip-lock-tables \
  --routines --events --triggers --databases <db>
```
- `--single-transaction`:InnoDB 下提供一致性快照,不锁表。
- `--quick`:逐行流式导出,避免把大表 `logs` 读进内存。
- `--skip-lock-tables` 与 `--single-transaction` 搭配,避免 `LOCK TABLES` 权限问题。
- **绝不**把口令拼进命令行(会出现在 `ps`);用 `--defaults-extra-file`(权限 600),导出后立即删除。
- 数据库名用 `--databases -- <db>`,`--` 防止库名被当作参数。
- 主库与日志库是**两个库**(可能同实例)。同实例可合并为一次两次调用,分别命名 `main.sql` / `log.sql`。

### 3.3 PostgreSQL

```
PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… PGDATABASE=<db> \
pg_dump --format=custom --no-password --file main.dump
```
- 口令走 `PGPASSWORD` 环境变量(不落在 argv);TLS 用 `PGSSLMODE`/`PGSSLROOTCERT`/`PGSSLCERT`/`PGSSLKEY`。
- 还原用 `pg_restore --clean --if-exists --no-owner --dbname <db> main.dump`。

### 3.4 主库 + 独立日志库

`LOG_SQL_DSN` 为空 → `LOG_DB = DB`,**只导出主库**;非空 → 导出两份,manifest 里分别记录引擎/库名/表清单/行数。
两者的引擎可以不同(主 PG + 日志 ClickHouse),由各自的配置块决定。

### 3.5 ClickHouse 日志库(仅「生成命令 + 明确告知」)

ClickHouse 不是关系型,`AutoMigrate` 建的是 `MergeTree` 表(`model/main.go:clickHouseLogCreateTableSQL`)。MVP **不自动执行**,只生成并写进 `RESTORE.md` 的命令:

```sql
-- 导出
SELECT * FROM logs FORMAT Native > logs.native
-- 或(服务端备份)
BACKUP TABLE logs TO Disk('backups', 'logs.zip')
```
并在 manifest 中标注 `logDatabase: { type: 'clickhouse', exported: false, reason: 'manual export required' }`。**其数据缺失会明确告警**,不静默。

### 3.6 大表 `logs` 的体积与耗时

- `logs` 是唯一会「无界增长」的表(每条请求一行,含 `other` JSON)。
- 估算:`SELECT count(*) FROM logs` × 平均行宽(`avg_row_length` 或抽样 `length(other)+…`)。
- 建议:
  1. 归档发布 `includeLogTable` 选项(默认 **true**),关掉时执行 `--ignore-table=<db>.logs`(MySQL)或 `pg_dump -T logs`(PG),manifest 标记 `logs: excluded` 并**在还原说明里明确写「消耗历史缺失」**。
  2. 耗时说明写进 `RESTORE.md`:导出约 `X MB/min`,压缩后通常为原大小的 15%–30%。
  3. 使用 `--quick` / `-Fc` 保持流式,避免内存峰值。

### 3.7 备份窗口与 Redis

启用 `BATCH_UPDATE_ENABLED` 时,Redis 中有尚未落库的批量计数。规则:
- 备份在低峰期执行;
- 或在导出前等待 ≥ `BATCH_UPDATE_INTERVAL`(默认 5s,见 `.env.example`)使批次落盘;
- 归档 manifest 记录 `recoveryPoint: <导出开始 ISO 时间>`,便于对账。

---

## 4. 还原步骤(在另一台机器上)

> 前置:新机器已装 Docker(或 Go 直接跑二进制),已 `docker pull calciumion/new-api:<manifest.version>` —— **必须是 manifest 记录的版本**。

### 4.1 通用步骤

1. **解归档**(输入归档密码):
   ```
   7z x newapi-<stamp>.7z -o ./restore
   ```
2. **读 `manifest.json` 与 `RESTORE.md`**:确认 `version`(镜像 tag)、`mainDatabase.type`、`logDatabase`(是否存在)、`logsIncluded`、表清单与行数。
3. **放回配置**:
   ```
   cp restore/config/env            ./new-api/.env
   cp restore/config/compose.yaml   ./new-api/docker-compose.yml
   ```
   ⚠️ `.env` **原值使用**,不要改 `CRYPTO_SECRET` / `SESSION_SECRET`(见 inventory §4)。
4. **创建数据目录并恢复库**:
   ```
   mkdir -p ./new-api/data
   ```
   - **SQLite 路径**:
     ```
     cp restore/db/main.sqlite3 ./new-api/data/one-api.db
     ```
     (若 `SQLITE_PATH` 指向别处,按 `.env` 放。**不要**放 `-wal`/`-shm`。)
     若日志库在同一 SQLite 文件里(即未设 `LOG_SQL_DSN`),**到此为止,无需第二步**。
   - **MySQL / PG 路径**:先起数据库容器(`docker compose up -d postgres` / `mysql`),等健康,再:
     ```
     docker compose exec -T postgres psql -U root -d postgres -c 'CREATE DATABASE "new-api";'
     docker compose exec -T postgres pg_restore -U root -d new-api --clean --if-exists --no-owner - < restore/db/main.dump
     # 日志库同理 -> new-api-log
     ```
   - **SQLite 但日志库独立**(少见:SQLite 主 + 另一 SQLite 日志):把 `restore/db/log.sqlite3` 放到 `.env` 里 `LOG_SQL_DSN` 指向的路径。
5. **恢复可选目录**:
   ```
   cp -r restore/logs/*      ./new-api/logs/      # 仅当归档含 logs
   cp -r restore/plugins/*   ./plugins/           # 仅当归档含插件脚本
   ```
6. **启动**:
   ```
   docker compose up -d
   docker compose logs -f new-api
   ```
   首次启动会以 `NODE_TYPE=master` 执行 `AutoMigrate`(版本相同时应为 no-op)。
7. **验证**:见 §5。

### 4.2 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即 `FatalLog` 提到 `SESSION_SECRET` | `.env` 里是默认 `random_string` | 用归档里的原值(不要用模板值) |
| 渠道 key 全部空白/解密失败 | `CRYPTO_SECRET` 与原环境不同 | 恢复原始 `.env`,重新导入 |
| `database disk image is malformed` | 直接拷了运行中的 db | 用一致性快照重做备份 |
| 启动后用户被登出 | 未恢复 `user_sessions` 或换了 `SESSION_SECRET` | 检查日志库/主库是否都还原 |
| 「消耗额度/tokens」为空 | 日志库未还原,`logs` 表缺失 | 还原 `log.sqlite3`/`log.dump` |
| 审计页空白 | 审计表在日志库侧,未还原 | 同上一行 |
| 看板历史缺失 | `quota_data` 未恢复 | 检查主库是否完整 |

---

## 5. 完整性校验

### 5.1 归档内 `manifest.json`(字段固定)

```json
{
  "kind": "azurekiln-newapi-backup",
  "manifestVersion": 1,
  "generatedAt": "2026-10-18T04:30:00.000Z",
  "recoveryPoint": "2026-10-18T04:29:58.000Z",
  "restoreInstructions": "RESTORE.md",
  "mainDatabase": {
    "type": "sqlite|mysql|postgres|postgresql",
    "database": "<库名, 不含口令>",
    "exportFile": "db/main.sqlite3",
    "exportBytes": 12345678,
    "exportSha256": "…",
    "tables": [{ "name": "users", "rows": 12 }, { "name": "logs", "rows": 987654 }],
    "logsIncluded": true,
    "integrity": "ok"
  },
  "logDatabase": {
    "type": "same|sqlite|mysql|postgres|clickhouse",
    "database": "<库名>",
    "exportFile": "db/log.sqlite3",
    "tables": [{ "name": "logs", "rows": 987654 }]
  },
  "files": [
    { "path": "config/env", "bytes": 1234, "sha256": "…" },
    { "path": "config/compose.yaml", "bytes": 4321, "sha256": "…" }
  ],
  "appVersion": { "image": "calciumion/new-api:latest", "versionFile": "v0.x.y" },
  "excluded": ["source", "docker-image", "tiktoken_cache", "new-api-body-cache"],
  "warnings": []
}
```

要点:
- **不含任何口令/密钥明文**:`database` 字段只放库名,DSN 结构与口令一律不写入 manifest(口令在加密归档内的 `.env` 里)。
- `tables` 从数据库**实际**查出(`sqlite_master` / `information_schema`),不是硬编码,保证「表清单靠实际库」而非猜测。
- `exportSha256` 让还原方能验证「解压出来的库就是备份时的库」。
- `warnings` 记录降级项(如 ClickHouse 未自动导出、`logs` 被排除、可选文件缺失)。

### 5.2 归档后的校验方法(还原方执行)

1. **归档完整性**:`7z t archive.7z`(本系统在上传前也会做一次,与 Vaultwarden 适配器一致)。
2. **文件哈希**:逐个比对 `manifest.files[].sha256`。
3. **库完整性**:
   - SQLite:`PRAGMA integrity_check` → `ok`。
   - MySQL:`mariadb-check` / `CHECK TABLE`。
   - PG:`pg_restore --list` 无错 + 启动后 `SELECT 1`。
4. **逐表行数比对**(最关键,证明「一模一样」):
   - SQLite:对 manifest 里每个 `tables[].name` 执行 `SELECT count(*) FROM "<name>"`,与 manifest 比对。
   - MySQL/PG:同 SQL,`count(*)`。
   - 行数全部相等 → 数据量与备份时一致。
5. **内容哈希比对**(防「行数相同内容不同」):对每表取稳定摘要,例如
   ```sql
   SELECT count(*), sum(length(CAST(t AS TEXT))) FROM <table> t;
   ```
   本系统的往返测试对每表计算 `sha256(按主键排序后逐行序列化)`,备份前后必须一致。
6. **应用层校验**:登录管理员账号 → 渠道列表有 key、`options` 生效、`/api/status` 正常、消耗页有历史。

---

## 6. 安全要求

1. **归档必须 AES-256 加密**:`.env` 内含 `CRYPTO_SECRET`(解密渠道 key 的唯一钥匙)、DB 口令、支付密钥。7z 用 `-mhe=on` 加密文件名列表。
2. **口令不落日志**:所有外部命令的命令行口令(sudo `-p<pwd>`)必须进 `secrets` 列表被 redact;数据库口令走 `--defaults-extra-file` / 环境变量,绝不进 argv。
3. **临时明文必须清理**:导出的 `main.sqlite3` / `main.sql` / `env` 副本在归档校验通过后立即删除;失败时按本系统既有 `failedRetentionHours` 策略。
4. **`.env` 不进任何 API 响应**;接口只返回「是否已配置文件」布尔标记,与既有 `passwordSet` 约定一致。
5. **路径限定**:所有源路径(数据目录、`.env`、compose、插件目录)必须落在 `SOURCE_ROOTS` 沙箱内且不得含符号链接。
