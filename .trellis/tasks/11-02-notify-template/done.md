# 设置页 UI 完成记录（pi p6）

## 范围
按 `prd.md` 分工中的「设置页 UI (pi p6)」一栏完成，只改动 `web/` 与对应的验证脚本。
后端渲染引擎（`server/notify-template.mjs`）、`shared/contracts.mjs` 模板字段、预览 API 由 pi p5 提供，本支路只消费，不重复实现。

## 交付

### 新增 `web/src/components/NotificationTemplateEditor.vue`
设置页「通知模板」面板：

- **主题 / 正文编辑**：受控草稿（`draft`），与已保存值解耦，保存失败时用户输入不丢失。
  输入上限 8192，对应 `TEMPLATE_MAX_LENGTH`。
- **变量说明**：变量清单由预览 API 响应的 `variables`（`scalars` / `items`）驱动，
  说明文案来自父组件的 `labels` 映射。UI 不硬编码变量名，服务端新增变量后自动出现在列表里。
- **实时预览**：`POST /api/settings/notification-template/preview`，展示主题与正文；
  错误走 `friendlyError` + `rawError` 双层（提示 + `title` 详情），与现有页面一致。
- **恢复默认**：写入空串（空串语义 = 使用内置默认），不把占位文案塞进已存配置。
- **状态徽标**：`自定义模板` / `内置默认模板`，由草稿推导。

模板 token（`{{ }}`、`{{#items}}…{{/items}}`）用字符串拼接构造，因为 SFC 模板编译器会把字面
`{{ … }}` 当作插值，直接写无法渲染。

### 改动 `web/src/components/SettingsView.vue`
- 侧栏新增 `template` 分区（`FileText` 图标），置于「邮件通知」之后。
- `saveTemplate()` 只 PATCH `{ notification: { template } }`，不与其他设置分区合并——
  空串是有意义的值，不能与默认值做 merge。
- 保存成功后把接口返回的 template 显式交给子组件 `syncFromSettings(template)`，
  而不是依赖 `v-show` 重挂载时的 prop 传播时序（实测该时序会导致徽标停在旧状态）。
- 老库没有 template 字段时用 `??=` 补空串。

### 其他
- `web/src/types.ts`：新增 `NotificationTemplate`，`Settings.notification.template?` 可选。
- `web/src/style.css`：`.settings-column` 改为 grid 容器；新增 `.template-*` 变量列表 / 预览 / 错误样式；
  移动端变量列表降为单列。移除已不再使用的 `.settings-form { min-height }`。
- `scripts/check-browser.mjs`：新增通知模板区断言（默认徽标 → 填写 → 预览 → 变量列表 → 保存回读 →
  草稿漂移后恢复默认 → 空串落库 → 徽标回到内置默认）。
- `scripts/check-layout.mjs`：允许 `.settings-column` 下存在单个 `.settings-form` 包裹层
  （面板共享一个 submit 处理），改为校验其直接子元素；已用注入 `div.stray` 的负向用例确认断言仍然会失败。

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm run check`（vue-tsc） | 通过 |
| `npm run build` | 通过（342.71 kB） |
| `npm run check:layout` | 通过（7 页 × 4 视口 × 2 主题，56 个页面断言） |
| `npm test` | 198 个测试，195 通过，0 失败，3 跳过 |
| `node scripts/ui-radius-audit.mjs` | 通过 |
| `npm run check:browser` | 通知模板区全部断言通过；脚本在其后的既有步骤 `directory run completed`（check-browser.mjs:472）超时退出 |

### 关于 `check:browser` 的失败
`directory run completed` 与本改动无关：已用 `git stash` 把我的全部改动移除、在干净的 HEAD 上重跑
`check:browser`，同一断言以同样方式超时（`Timed out: directory run completed`）。恢复改动后复现位置一致。

## 未做 / 交给主会话
- 未 `git commit`（按分工由主会话统一提交）。
- `done.md` 之外未新增任务级文档。
