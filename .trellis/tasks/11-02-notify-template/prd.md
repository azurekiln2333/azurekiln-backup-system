# 通知模板自定义
## 分工
- **后端渲染 (pi p5)**:新增 `server/notify-template.mjs` + shared/contracts.mjs 的模板字段 + 预览 API + 测试。
- **设置页 UI (pi p6)**:web/ 设置页新增"通知模板"区:主题/正文编辑、变量说明、恢复默认、实时预览(调用预览 API)。
## 契约(两端与 notify-aggregate 共同遵守)
- 设置字段:`settings.notification.template = { subject: string, body: string }`,空串=使用内置默认。
- `export function renderNotification(template, ctx) -> { subject, text, html }`,纯函数,HTML 输出需转义变量。
- ctx: `{ total, successCount, warningCount, failedCount, startedAt, finishedAt, hostName, items: [{ jobName, type, status, durationSec, archiveBytes, error, nodeName }] }`
- 语法:`{{变量}}` 标量替换;`{{#items}}一行模板,可用 {{jobName}} {{status}} {{durationSec}} {{archiveBytes}} {{error}}{{/items}}` 循环;未知变量输出空串,不得抛错/执行代码。
- API:`POST /api/settings/notification-template/preview` body `{template, ctx?}`→渲染结果(ctx 缺省用样例数据),需登录鉴权,沿用现有 settings 路由风格。
## 验收
- 默认模板输出与聚合邮件格式一致;注入 `<script>` 的任务名在 html 中被转义;`npm test` 与前端构建通过。
