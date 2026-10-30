# api-tokens:多令牌 API Key 管理

负责 pane:**w1H:p4**。父任务:`10-18-ui-revamp-newapi-backup`(先读它的 prd.md 全局规则)。

## 用户原话

「研究一下能不能创建多个令牌 key 啊,能的话开一个页进行令牌管理?」

## 阶段 1:调研(必做,先出结论)

产出 `research/token-feasibility.md`:
1. 现状:读 `server/auth.mjs`、`server/app.mjs`、`server/config.mjs`、`server/store.mjs`,弄清本系统现在如何认证(会话 cookie / OIDC / 管理员口令 / 是否已有 API Key 或 Bearer)、CSRF 处理、审计日志有无。
2. 参考 newapi 的「令牌管理」页(`D:\My2KProjects\new-api` 前端)的字段与交互:名称、脱敏 Key、状态、创建/过期时间、复制、启停、删除。
3. 本系统有没有合理的使用场景:脚本/CI/外部监控以 Bearer 令牌调用「触发备份、查询状态、读取运行记录」等 API。
4. 结论:**可行/不可行,以及最小范围**。不可行或没有价值就明确写出理由,在 board 写 `DONE`(结论为不实施),不要硬做。

## 阶段 2:实现(仅当结论为可行)

### 后端(新文件优先,如 `server/tokens.mjs`)
- 多个命名令牌;创建时**只显示一次**明文(`akb_` 之类前缀 + 高熵随机),库里只存**哈希**(SHA-256 即可,高熵令牌无需慢哈希)和前缀/末四位用于脱敏展示。
- 字段:id、名称、前缀、创建时间、最后使用时间、过期时间(可选)、状态(启用/停用)、作用域(至少 `read` / `run`;具体最小集你定并写入 design.md)。
- 路由:`GET/POST /api/tokens`、`PATCH /api/tokens/:id`(改名/启停/过期)、`DELETE /api/tokens/:id`(吊销)。这些管理路由**只允许管理员会话访问,令牌自身不能管理令牌**(防提权)。
- `Authorization: Bearer <token>` 中间件:恒定时间比较,检查状态/过期/作用域,更新最后使用时间;Bearer 请求不需要 CSRF,但不得绕过现有对会话请求的 CSRF 保护。
- 日志与错误里**绝不出现**令牌明文;失败响应不泄露令牌是否存在。
- 若系统已有审计/事件日志,创建/吊销/使用失败要记录。
- 测试:创建只显示一次、哈希存储、过期/停用/作用域拒绝、令牌不能管理令牌、Bearer 可触发允许的接口、不带 CSRF 的会话请求仍被拒。

### 前端
- 新页面 `web/src/components/TokensView.vue`(+ `types.ts`/`api.ts` 补充)。列表+新建弹窗(创建后一次性展示并提供复制)+启停/改名/删除,样式沿用现有 token(新 UI 的圆角规则:≤8px;不要重复标题)。
- 接入导航:**等 board 出现 `SHELL-DONE` 后**,按 ui-shell 给出的导航注册表加一行并最小接线,立刻提交。在此之前不要改 App.vue / style.css;可先把组件做完、用单测/类型检查验证。

## 验收标准

- [ ] `research/token-feasibility.md` 存在且结论明确。
- [ ] 若实施:后端、测试、前端页面、导航接入齐全,安全点逐条满足(一次性明文、哈希存储、恒定时间比较、令牌不可管理令牌、日志无明文)。
- [ ] `npm run check`、`npm test`、`npm run build`、`npm run check:browser` 全绿;分批提交且已立刻提交。
- [ ] 更新 `.trellis/spec/backend/*` 与 `.trellis/spec/frontend/ui-api.md`、README 中的认证与 API 说明。
