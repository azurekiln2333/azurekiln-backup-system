# 服务器节点与任务同步
## 分工
- **后端 API/存储/同步 (codex p9)**:store 增加 nodes;CRUD 与 `POST /api/nodes/:id/sync`;接收端 `PUT /api/sync/jobs`;shared/contracts.mjs 增加 node schema。
- **路径映射纯模块 (pi p7)**:新增 `server/node-paths.mjs` + tests,契约见下;完成后再补 README 三份文档。
- **节点页 UI (pi p4)**:web/ 新增"服务器节点"页:列表(状态/最后同步)、添加/编辑/删除、测试连接、立即同步、路径规则编辑、同步结果(逐任务:已同步/需映射/失败)。
## 设计要点
- 主控→节点 **推送**:节点是另一个本实例,凭其 API token(见 api-tokens 任务)鉴权;任务以稳定 `syncKey`(= 主控 job.id)幂等 upsert。
- 节点:`{ id, name, baseUrl, token(加密存储,响应中脱敏), enabled, pathRules:[{from,to}], jobOverrides:{[jobId]:{sources:[...]}}, lastSyncAt, lastStatus }`。
- 路径映射 `mapPath(path, rules, overrides?) -> {path, mapped:boolean}`:最长前缀优先;大小写/分隔符按 from 的风格(Windows `\` vs POSIX `/`)归一后匹配;无匹配且路径为绝对路径→标记"需映射"并 **跳过该任务**,不推送错误路径;job 级 override 优先于规则。
- 仅同步任务定义(来源、目标、计划、保留策略),不同步运行记录、密钥类设置;目标存储若含本地路径同样走映射。
- token 不落日志;baseUrl 校验 http(s),防 SSRF 的内网限制按现有约定(先看代码里已有处理)。
## 验收
- 添加 2 个节点、同一任务按各自规则映射成不同路径;未映射任务报"需映射";重复同步不产生重复任务;`npm test` 全绿。
