# new-api 数据清单(备份范围调研)

调研对象:`D:\My2KProjects\new-api`(Go + Gin + GORM 的 new-api),**只读**。
目的:确定「把整套数据拿到另一台机器还原后一模一样」所需备份的**全部**持久化状态,并逐项判定是否纳入备份。

图例:✅ 必须纳入 · ⚠️ 条件纳入 / 需部署期确认 · ❌ 不纳入(可再生或不应备份) · 🔒 含敏感信息(必须加密归档)

---

## 1. 数据库形态

new-api 有**两个逻辑数据库**:主库(main DB)与日志库(log DB),由两个环境变量独立选择。

| 项 | 环境变量 | 可选引擎 | 证据 |
|---|---|---|---|
| 主库 | `SQL_DSN` | SQLite(空值或以 `local` 开头)、MySQL、PostgreSQL | `model/main.go:chooseDB` |
| 主库 SQLite 路径 | `SQLITE_PATH` | 默认 `one-api.db`(相对进程工作目录) | `common/database.go:64`、`common/init.go:72` |
| 日志库 | `LOG_SQL_DSN` | 同上 + ClickHouse(仅日志库允许) | `model/main.go:InitLogDB`、`chooseDB(..., isLog=true)` 的 `isClickHouseDSN` 分支 |
| 日志库为空时 | — | `LOG_DB = DB`,即与主库同一库/同一 DSN | `model/main.go:InitLogDB` 首段 |

### 1.1 关键事实

1. **主库不支持 ClickHouse**。`chooseDB` 在 `isLog == false` 时对 ClickHouse DSN 直接报错:`"%s does not support ClickHouse; use SQLite, MySQL, or PostgreSQL for the primary database and LOG_SQL_DSN for ClickHouse logs"`(`model/main.go`)。
2. **SQLite 使用 WAL 模式**:
   `common/database.go:64` 的默认 DSN 是
   `one-api.db?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_txlock=immediate`。
   → 运行中的 SQLite 存在 `one-api.db`、`one-api.db-wal`、`one-api.db-shm` 三个文件;`.gitignore` 也明确忽略 `*.db-wal`、`*.db-shm`、`*.db-journal`。
   → **绝不能**直接 `cp one-api.db`:会丢失 WAL 中未 checkpoint 的事务,得到**不一致**快照。
3. **SQLite 由纯 Go 驱动**(`github.com/glebarez/sqlite`,即 `modernc.org/sqlite`),因此 `sqlite3` CLI **不一定**存在于部署镜像内 —— 备份方案不能假设容器里有 `sqlite3` 可执行文件(见 `newapi-backup-rules.md` 的方案对比)。
4. **只有 master 节点执行迁移**:`if !common.IsMasterNode { ... return nil }`(`model/main.go:InitDB`)。`NODE_TYPE=master` 决定。还原后首次启动,新版本会执行 `AutoMigrate` 改写表结构 —— 这是「版本一致性」风险的来源。
5. **日志库迁移**:`migrateLOGDB()` → `MigrateAuditLogs()` + (`ClickHouse` ? `migrateClickHouseLogDB()` : `LOG_DB.AutoMigrate(&Log{})`)。

---

## 2. 逐表清单

权威来源 = `model/main.go` 的 `migrateDB()` 中 `DB.AutoMigrate(...)` 的参数列表(35 个),加上 `migrateDB()` 尾部条件迁移的 `SubscriptionPlan`,加上 `migrateLOGDB()` 的 `Log`。
> 结论:**表清单必须以 `AutoMigrate` 列表为准**,不要手写臆测。

### 2.1 用户与鉴权

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 | 类别 |
|---|---|---|---|---|---|
| `users` | `User` | `model/user.go:79` | 账号、bcrypt/argon2id 口令哈希、额度 `quota`/`used_quota`/`aff_quota`/`aff_history`、角色、分组、`access_token`、状态 | 全部用户与余额消失,需重建 root | 用户与鉴权 🔒 |
| `tokens` | `Token` | `model/token.go:14` | 用户 API Key(`key`)、额度、模型限制、分组、过期时间 | 所有下游调用凭证失效 | 渠道与密钥 🔒 |
| `user_sessions` | `UserSession` | `model/user_session.go:61` | 登录会话(refresh/access)、`revoked` 审计、活跃上限统计 | 全部用户被登出 | 会话/流程临时 |
| `auth_flows` | `AuthFlow` | `model/auth_flow.go:59` | OAuth/OIDC 登录流程中间态(带过期) | 进行中的登录失败,可重试 | 会话/流程临时 |
| `external_identity_claims` | `ExternalIdentityClaim` | `model/external_identity_claim.go:29` | 外部身份 → 本地用户的唯一性声明(防重复绑定) | 已绑定用户可能被重复占用,需人工修 | 用户与鉴权 |
| `passkey_credentials` | `PasskeyCredential` | `model/passkey.go:22` | WebAuthn/Passkey 凭据公钥、计数器 | 用户无法再用 Passkey 登录 | 用户与鉴权 |
| `two_fas` | `TwoFA` | `model/twofa.go:14` | TOTP 秘钥与启用状态 | 2FA 用户无法登录 | 用户与鉴权 🔒 |
| `two_fa_backup_codes` | `TwoFABackupCode` | `model/twofa.go:28` | 2FA 备份码(哈希) | 无法用备份码恢复 | 用户与鉴权 🔒 |
| `user_oauth_bindings` | `UserOAuthBinding` | `model/user_oauth_binding.go:19` | 用户与 GitHub/LinuxDO/OIDC 等外部账号绑定 | 第三方登录断链 | 用户与鉴权 |
| `user_access_tokens` | `UserAccessToken` | `model/user_access_token.go:54` | 新版个人访问令牌(替代 `users.access_token`) | 个人令牌失效 | 用户与鉴权 🔒 |
| `custom_oauth_providers` | `CustomOAuthProvider` | `model/custom_oauth_provider.go:69` | 管理员自定义的 OAuth 提供方(含 client secret) | 自定义 SSO 配置丢失 | 系统配置 🔒 |
| `casbin_rule` | `CasbinRule` | `model/casbin_rule.go:14` | 授权策略(policy 行) | 权限模型回退到默认 | 系统配置 |
| `authz_roles` | `AuthzRole` | `model/authz_role.go:15` | 角色定义 | 自定义角色丢失 | 系统配置 |
| `login_encryption_keys` | `LoginEncryptionKey` | `model/password_crypto.go:17` | 登录密码 RSA-OAEP 信封加密的密钥对(`PASSWORD_LOGIN_ENCRYPTION_ENABLED`) | 已发布的公钥/前端加密握手失效,可能需重新初始化 | 系统配置 🔒 |
| `setups` | `Setup` | `model/setup.go:3` | 初始化标记(版本 + 初始化时间),`CheckSetup()` 以此为「已安装」判据 | 系统被判定为未初始化,可能重建 root | 系统配置 |

### 2.2 渠道与密钥

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 |
|---|---|---|---|---|
| `channels` | `Channel` | `model/channel.go:23` | 上游渠道配置:`key`(可多 key)、`base_url`、`model_mapping`、`status_code_mapping`、`param_override`、`settings`、分组、权重、优先级、多 key 轮询状态 | **核心资产**:所有上游凭据与模型映射消失,余额/路由全废 🔒 |
| `abilities` | `Ability` | `model/ability.go:18` | 渠道 × 模型 × 分组 的可路由能力矩阵(由渠道派生但持久化) | 无法路由到任何渠道(可由 `FixAbility()` 重建,但需先有 channels) |

### 2.3 系统 / 模型配置

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 |
|---|---|---|---|---|
| `options` | `Option` | `model/option.go:21` | **K-V 配置总表**:站点名/公告/注册开关/支付配置/倍率与价格/限流/主题/… | 全部后台设置回默认 🔒 |
| `models` | `Model` | `model_meta.go:35` | 模型元数据(名称、定价、所属分组/供应商、可见性等,配合 `model_pricing_config.go`) | 模型价格与展示配置丢失 |
| `vendors` | `Vendor` | `model/vendor_meta.go:15` | 供应商元数据 | 供应商信息丢失 |
| `prefill_groups` | `PrefillGroup` | `model/prefill_group.go:78` | 分组预设(可复用分组定义) | 分组预设丢失 |
| `task_plugins` | `TaskPlugin` | `model/task_plugin.go:78` | 任务插件(JS 插件)注册与配置 | 插件配置丢失 |
| `subscription_plans` | `SubscriptionPlan` | `model/subscription.go:146` | 订阅套餐(价格、周期、额度重置、Stripe/Creem/Waffo 商品 ID) | 套餐全部消失 🔒(含支付商品 ID) |

### 2.4 消耗与计费

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 |
|---|---|---|---|---|
| `users.quota` / `used_quota` / `aff_quota` / `aff_history` | 列 | `model/user.go:79` | 用户余额、累计消耗、邀请额度与历史 | 账务错乱 |
| `logs` | `Log` | `model/log.go:57` | **逐条消费记录**:用户、token、model、`quota`、`prompt_tokens`、`completion_tokens`、`use_time`、`is_stream`、`channel_id`、`group`、`ip`、`request_id`、`other` | 消耗/tokens 统计与审计全部丢失 🔒(含 IP) |
| `topups` | `TopUp` | `model/topup.go:15` | 充值订单(支付网关流水、金额、状态) | 充值记录与对账丢失 🔒 |
| `redemptions` | `Redemption` | `model/redemption.go:13` | 兑换码批次与使用状态 | 未用兑换码全部失效 |
| `checkins` | `Checkin` | `model/checkin.go:27` | 签到记录与额度发放 | 签到统计丢失 |
| `quota_data` | `QuotaData` | `model/usedata.go:13` | 数据看板聚合(按时间桶的用量) | 看板历史曲线丢失 |
| `subscription_orders` | `SubscriptionOrder` | `model/subscription.go:214` | 订阅购买订单 | 订阅对账丢失 🔒 |
| `user_subscriptions` | `UserSubscription` | `model/subscription.go:253` | 用户当前订阅、剩余额度、重置周期 | 付费用户权益丢失 |
| `subscription_pre_consume_records` | `SubscriptionPreConsumeRecord` | `model/subscription.go:1244` | 订阅预扣/结算流水 | 额度结算不一致 |
| `perf_metrics` | `PerfMetric` | `model/perf_metric.go:25` | 性能指标(可用性/延迟统计) | 可重建,但丢历史 |

### 2.5 审计

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 |
|---|---|---|---|---|
| 审计日志(表名见 `model/audit_log.go` 的 `MigrateAuditLogs`) | — | `model/audit_log.go` | 管理员操作审计(谁在何时改了什么),按 `MigrateAuditLogs()` 迁移 | 审计链断裂(合规风险)🔒 |

> 审计日志在 `migrateLOGDB()` 与 `InitLogDB()` 中都会先执行 `MigrateAuditLogs()` —— 即**审计表在两库都需要存在**;备份时主库与日志库都要导出,避免只备份其一导致审计表缺失。

### 2.6 任务类

| 表 | Go 类型 | 定义 | 内容 | 丢失后果 |
|---|---|---|---|---|
| `midjourneys` | `Midjourney` | `model/midjourney.go:3` | MJ 异步任务(含中间图片 URL) | 进行中任务丢失,已付额度难追回 |
| `tasks` | `Task` | `model/task.go:50` | 通用异步任务(Suno/视频/…),含状态、进度、结果 URL、`quota` | 同上 |
| `system_tasks` | `SystemTask` | `model/system_task.go:28` | 周期性系统任务注册与运行历史 | 调度历史丢失(会重新注册) |
| `system_task_locks` | `SystemTaskLock` | `model/system_task.go:43` | 多 master 的 DB 租约锁 | 短暂重新选举,可接受 |

### 2.7 纯缓存 / 可再生(仍建议随库备份,因为它们在库里,无需额外动作)

| 表 | Go 类型 | 说明 |
|---|---|---|
| `system_instances` | `SystemInstance` | 存活节点心跳(定期写入,`service.StartSystemInstanceReporter`) |
| `abilities` | `Ability` | 可由 `channels` 重建(`FixAbility()`),但随库备份最省事 |
| `perf_metrics` | `PerfMetric` | 统计型 |

---

## 3. 数据库之外的外部状态

| 数据项 | 位置 / 证据 | 是否必须 | 判定理由 |
|---|---|---|---|
| SQLite 主库文件 + `-wal` + `-shm` | `SQLITE_PATH`,默认 `one-api.db`;compose 挂载 `./data:/data` → 实际在 `data/one-api.db` | ✅ | 见 §1.1-2,必须**一致性快照**,不可裸拷 |
| 日志库(独立 DSN) | `LOG_SQL_DSN`(可为 MySQL/PG/ClickHouse) | ✅ | `logs` + 审计表,是「消耗额度/tokens 数」的唯一真相源 |
| `.env` | 进程工作目录 `.env`,`InitResources()` 里 `godotenv.Load(".env")` | ✅🔒 | 承载 `SQL_DSN`/`LOG_SQL_DSN`/`REDIS_CONN_STRING`/`SESSION_SECRET`/`CRYPTO_SECRET` 等;丢失则无法连接原库、会话与加密数据全废 |
| `docker-compose.yml` | 仓库根 | ✅ | 定义挂载(`./data:/data`、`./logs:/app/logs`)、`--log-dir`、DB/Redis/ClickHouse 拓扑;还原拓扑必须一致 |
| `new-api.service`(systemd) | 仓库根 | ✅(若用 systemd 部署) | 启动参数与环境文件路径 |
| 反向代理配置(Nginx/Caddy/Traefik) | 部署机器 | ✅(若存在) | 影响 `TRUSTED_PROXIES`、`SESSION_COOKIE_TRUSTED_URL`、HTTPS 终止;不含则域名/SSL 行为不一致 |
| Redis(`REDIS_CONN_STRING`) | `common/redis.go` | ⚠️ 结论:**不纳入** | Redis 在 new-api 中承担**缓存 + 同步/限流/队列**用途(`MEMORY_CACHE_ENABLED`、`SYNC_FREQUENCY`、`BATCH_UPDATE_ENABLED`、`CHANNEL_UPDATE_FREQUENCY`,见 `.env.example`);权威数据仍在 SQL。会话在 `user_sessions` 表而非 Redis。**风险**:若启用了 `BATCH_UPDATE_ENABLED`,Redis 中可能有尚未落库的批量更新计数 —— 备份应在低峰期进行,或在备份前等待 `BATCH_UPDATE_INTERVAL`(默认 5s)让批次落库 |
| `logs/`(`--log-dir`,compose `./logs:/app/logs`) | `logger/*.go` 的 `setupLog` 写 `oneapi-<YYYYMMDDhhmmss>.log` | ⚠️ 默认**排除** | 进程日志,非权威数据;若需要排障证据可单独按需纳入。还原不需要它 |
| `data/` 下的磁盘缓存 `new-api-body-cache` | `common/disk_cache.go`(`GetDiskCacheDir()` = `GetDiskCachePath()` 或 `os.TempDir()`,再拼 `new-api-body-cache`);`CleanupOldCacheFiles()` 启动清理 | ❌ | 请求体临时缓存,可再生 |
| `tiktoken_cache` | `.gitignore` 明确列出 | ❌ | 分词器缓存,可重新下载 |
| `web/dist` | `.gitignore`;`main.go` 用 `//go:embed web/dist` 打进二进制 | ❌ | 构建产物,已在镜像内 |
| 程序源码 / Docker 镜像 | 仓库 & registry | ❌ | 用户明确要求不备份 |
| 用户上传文件 | 全仓搜索 `upload` / `os.WriteFile` / `os.MkdirAll` 未发现用户文件落盘目录;`.gitignore` 的 `upload` 条目为历史遗留 | ❌ | **结论:new-api 无用户上传持久化目录**。图片/文件上传能力(`FileUploadPermission`、`ImageUploadPermission`)是**转发到上游**,不落本地盘。若部署方自制了上传目录,需部署期确认 |
| 任务插件 JS 文件(`pkg/jsplugin`) | `TaskPlugin` 表存注册与配置;插件脚本文件本身 | ⚠️ 需部署期确认 | 表已随库备份;若插件脚本存放于宿主机目录(非镜像内),该目录必须一并纳入。确认命令:`grep -rn "PLUGIN_DIR\|jsplugin" .env docker-compose.yml` |
| Pyroscope / pprof / Umami / GA 配置 | `.env.example`(`PYROSCOPE_*`、`ENABLE_PPROF`、`UMAMI_*`、`GOOGLE_ANALYTICS_ID`) | ❌ | 外部观测,非业务数据 |

---

## 4. 密钥类环境变量:丢失/更换的后果

| 变量 | 作用(证据) | 丢失/更换后果 | 结论 |
|---|---|---|---|
| `CRYPTO_SECRET` | `common/init.go:62-63` → `common.CryptoSecret`;用于对称加密(如渠道 key 等敏感列的加解密) | **已用旧密钥加密的列无法解密** → 渠道 key、支付密钥等全部读不出。属于「不可逆数据损坏」 | ✅🔒 必须原样随归档保存,还原时一字不改 |
| `SESSION_SECRET` | `common/init.go:53-57`;非空且等于默认 `random_string` 时**直接 `log.Fatal` 拒绝启动** | 更换 → 基于它的会话/签名状态失效(用户需重新登录);多节点部署下各节点必须一致 | ✅🔒 必须保存 |
| `SQL_DSN` / `LOG_SQL_DSN` | 连接串(含库口令) | 丢失则无法连接原库 → 还原无从下手 | ✅🔒 |
| `REDIS_CONN_STRING` | Redis 口令 | 缓存不可用(会退化/报错) | ✅🔒(随 `.env` 备份即可) |
| `PASSWORD_LOGIN_ENCRYPTION_ENABLED` + `login_encryption_keys` 表 | `model/password_crypto.go:17`、`model.InitPasswordEncryption()` | 表与配置必须成对;只备其一 → 登录加密握手失败 | ✅ 一起备份 |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_TRUSTED_URL` | `.env.example` 说明:启用 Secure Cookie 与严格 OriginGuard | 不还原 → 刷新令牌/登出被 OriginGuard 拒绝 | ✅ 随 `.env` |
| `TRUSTED_PROXIES` | 反代信任列表 | 不一致 → 审计日志 IP 错误或安全策略变化 | ✅ 随 `.env` |
| `NODE_TYPE` | `master` 才做迁移 | 误设非 master → 表结构不迁移,新版本启动异常 | ✅ 随 `.env` |

---

## 5. 覆盖矩阵(无「未知」项)

| # | 数据项 | 存放位置 | 纳入备份 | 原因 |
|---|---|---|---|---|
| 1 | 用户与余额 | 主库 `users` | ✅ | 账号与账务真相源 |
| 2 | API Key / 令牌 | 主库 `tokens`、`user_access_tokens` | ✅ | 下游调用凭证 |
| 3 | 渠道与上游密钥 | 主库 `channels` | ✅🔒 | 核心资产,`CRYPTO_SECRET` 决定能否解密 |
| 4 | 路由能力矩阵 | 主库 `abilities` | ✅ | 可再生但成本高,随库备份 |
| 5 | 后台全部设置 | 主库 `options` | ✅🔒 | 站点行为、倍率、支付 |
| 6 | 模型/供应商/分组配置 | 主库 `models`、`vendors`、`prefill_groups` | ✅ | 价格与展示 |
| 7 | 任务插件配置 | 主库 `task_plugins` + 插件脚本目录(⚠️部署期确认) | ✅ | 表随库;脚本按部署确认 |
| 8 | 消耗记录 / tokens 数 | 日志库(或主库)`logs` | ✅🔒 | 「消耗额度、tokens 数」的唯一真相 |
| 9 | 充值/订阅/兑换/签到 | 主库 `topups`、`redemptions`、`checkins`、`subscription_*` | ✅🔒 | 计费与对账 |
| 10 | 审计日志 | 审计表(`model/audit_log.go`) | ✅🔒 | 合规与追责 |
| 11 | 异步任务 | 主库 `midjourneys`、`tasks` | ✅ | 已扣额度的在途任务 |
| 12 | 系统任务 | 主库 `system_tasks`、`system_task_locks` | ✅ | 运行历史;锁可重新选举 |
| 13 | 登录会话 | 主库 `user_sessions`、`auth_flows` | ✅ | 还原后无需全员重登;过期数据无害 |
| 14 | 鉴权扩展 | `passkey_credentials`、`two_fas`、`two_fa_backup_codes`、`user_oauth_bindings`、`external_identity_claims`、`custom_oauth_providers`、`casbin_rule`、`authz_roles`、`login_encryption_keys`、`setups` | ✅ | 少一个都能造成某类登录/授权不可用 |
| 15 | 看板/性能统计 | `quota_data`、`perf_metrics`、`system_instances` | ✅ | 随库,无额外成本 |
| 16 | SQLite 文件本体 | `data/one-api.db`(含 `-wal`/`-shm`) | ✅ | 一致性快照(非裸拷) |
| 17 | 环境变量 / 部署配置 | `.env`、`docker-compose.yml`、`new-api.service`、反代配置 | ✅🔒 | 还原拓扑与密钥 |
| 18 | Redis | 外部 | ❌ | 缓存/同步/限流,权威数据在 SQL;低峰期备份即可 |
| 19 | 进程日志 `logs/` | 卷 `./logs` | ❌ | 排障用,非还原必需 |
| 20 | 磁盘缓存 `new-api-body-cache` | `GetDiskCachePath()`/`os.TempDir()` | ❌ | 可再生 |
| 21 | `tiktoken_cache` | 工作目录 | ❌ | 可重新下载 |
| 22 | `web/dist`、Go 构建产物 | 仓库 | ❌ | 构建产物 |
| 23 | 程序源码 / Docker 镜像 | 仓库 / registry | ❌ | 用户明确排除 |
| 24 | 用户上传文件 | — | ❌ | 源码确认无本地上传持久化;如部署方另设目录需部署期确认 |

### 5.1 「需部署期确认」的两项

1. **任务插件脚本目录**:`grep -rn "PLUGIN_DIR\|jsplugin" .env docker-compose.yml` 确认脚本是镜像内置还是宿主挂载。
2. **是否有自定义上传/静态资源目录**:`docker-compose.yml` 中除 `./data`、`./logs` 外是否还有别的 bind mount。

这两项都**不影响 MVP 实现**(表数据与规定目录已覆盖),按「存在则一并纳入归档」处理即可。

---

## 6. 还原一致性风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| new-api 版本漂移 | 还原时若镜像版本更高,首次启动会 `AutoMigrate` 改表 | 归档 manifest 记录 `new-api` 版本(镜像 tag / `VERSION` 文件);还原时用**同版本**镜像启动 |
| SQLite 裸拷贝 | 直接复制 `one-api.db` 丢掉 WAL 事务 | 用在线备份接口(见 backup-rules) |
| 只备主库漏日志库 | `LOG_SQL_DSN` 独立时,`logs` 与审计在主库之外 | 主库与日志库**都**导出,manifest 分别记录 |
| 换 `CRYPTO_SECRET` | 已加密列不可解密 | 归档内保留 `.env` 原值,还原后不得改 |
| 换 `SESSION_SECRET` 且为默认值 | 启动即 `FatalLog` | 原样保留 |
| 表清单靠猜 | 不同版本表集合不同 | manifest 记录**实际**表清单 + 行数(从库里查出来) |
