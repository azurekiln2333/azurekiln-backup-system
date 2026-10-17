# newapi-data-backup:newapi 全量数据备份

负责 pane:**w1H:p5**。父任务:`10-18-ui-revamp-newapi-backup`(先读它的 prd.md 全局规则)。

## 用户原话

「顺带给我读一下 newapi 哪些数据重要。我要加一项 newapi 的数据备份。要求就是把系统配置、各种配置、模型配置、密钥配置、审计、还有记录的消耗额度 tokens 数各种,看看数据库都有没有覆盖到,看看外部有没有关联的文件,如果有的话就制定好备份规则。我要整个数据拿到另一台机器还原能一模一样,但整个主程序源码或 docker 镜像之类的不要备份进去。」

## 阶段 1:调研(必做,产出文档)

源码在 `D:\My2KProjects\new-api`(**只读**,不要修改它)。产出到 `research/`:

1. `newapi-data-inventory.md`:
   - 支持的数据库(SQLite / MySQL / PostgreSQL),是否有**独立日志库**(`LOG_SQL_DSN`)。
   - 逐表清单(`model/` 下所有 AutoMigrate 的表),按类别标注:**用户与鉴权**(用户、令牌、2FA、Passkey、OAuth 绑定…)、**渠道与密钥**(channels/abilities…)、**系统/模型配置**(options、模型倍率/价格、供应商、分组、预填…)、**消耗与计费**(额度、tokens 数、logs、充值、兑换码、签到…)、**审计/日志**、**任务类**(Midjourney/Task…)、**纯缓存/可再生**。
   - 数据库之外的外部状态:`data/`、`logs/`、上传/静态文件、`.env`、`docker-compose.yml`、反代配置、Redis(仅缓存?还是承载关键状态?)等。**逐项判定是否必须备份**。
   - 与环境变量绑定的密钥:`SESSION_SECRET`、`CRYPTO_SECRET` 等 —— 丢失或更换会导致什么后果(已加密数据能否解密、会话是否失效),因此还原时必须一并保留。
   - 覆盖矩阵:每个数据项 -> 存放位置 -> 是否纳入备份 -> 原因。
2. `newapi-backup-rules.md`:
   - **纳入**:数据库(一致性快照)、数据目录、环境/compose 配置、必要的密钥与外部文件。
   - **排除**:程序源码、docker 镜像、构建产物、可再生缓存、`node_modules` 等。
   - **一致性**:SQLite 用在线备份(`VACUUM INTO` / backup API,不能直接拷贝正在写的 db 文件);MySQL 用 `--single-transaction` 等;PG 用 `pg_dump`;主库与日志库都要。大表(logs)的处理与耗时说明。
   - **还原步骤**:另一台机器上如何一步步还原并启动,逐步写清楚。
   - **完整性校验**:归档内含 `manifest.json`(newapi 版本/DB 类型/表清单+行数/文件清单+哈希/生成时间),并提供还原后的校验方法。

## 阶段 2:实现

仿照本系统已有的 Vaultwarden / system 适配器(读 `server/backup.mjs`、`server/system-restore.mjs`、`shared/contracts.mjs`、`server/store.mjs` 的相应部分),新增 **`newapi` 任务类型**:

- 在 contracts 里加 `type: 'newapi'` 及 `newapi` 配置块(数据库类型与连接/文件位置、数据目录、环境/compose 文件路径、是否包含日志表/日志库等);沿用 `/sources/**` 路径沙箱与既有机密字段的加密存储方式,**密钥不进日志**。
- 后端适配器(新文件优先,如 `server/newapi.mjs`):按 backup-rules 生成**一致性**归档,含 `manifest.json` 和还原说明 `RESTORE.md`;密钥类文件进入归档时遵循本系统的归档加密策略(建议强制/强提示启用 AES-256 加密)。
- 提供还原能力或至少一个可执行的还原脚本/命令,并做**往返测试**:造一份 SQLite 版 newapi 风格测试库(多张表、含消耗/日志/配置/密钥表)+ 数据目录 -> 备份 -> 在另一个空目录还原 -> 逐表行数与内容哈希一致。MySQL/PG 路径至少有命令构造与参数转义的单测。
- 测试:路径沙箱、密钥不泄露、排除规则、manifest 正确、往返一致。
- 前端:`JobEditor.vue` 增加「newapi」类型表单;**新建独立组件**(如 `NewApiFields.vue`)承载表单,避免大范围改 JobEditor。接入 JobEditor / 导航处等 board 的 `BASELINE-DONE`(JobEditor 的主人是 jobs-batch-grouping)与 `SHELL-DONE` 后再做最小接线并立刻提交。

## 验收标准

- [ ] 两份调研文档完整,覆盖矩阵里没有「未知」项;每个遗漏风险点都有结论。
- [ ] 新增 `newapi` 类型可创建/编辑/执行;归档不含源码与镜像。
- [ ] 往返测试证明:另一台机器(空目录)还原后与源数据逐表一致(行数+内容哈希),配置/密钥/消耗/审计/日志均在。
- [ ] 无密钥泄露(日志、API 响应、错误信息)。
- [ ] `npm run check`、`npm test`、`npm run build`、`npm run check:browser` 全绿;分批提交且已立刻提交。
- [ ] 更新 `.trellis/spec/backend/backup-lifecycle.md`、`README*`。
