# 通知聚合 (owner: codex p8)
## 目标
多个备份任务同一时段完成时,只发 **一封** 汇总邮件,列出每个任务成功/失败,而不是每个任务一封。
## 需求
- run 完成时不再立刻发信,进入待发批次(run.notificationStatus: pending→batched→sent)。
- 冲刷条件:当前无 queued/running 的 run,且距最后一个完成已过 `settings.notification.aggregateWindowSec`(默认 120,0=关闭聚合,保持旧行为);另设最长等待上限(默认 30 分钟)防饥饿。
- 汇总邮件含:总数/成功/警告/失败计数 + 每个任务一行(任务名、类型、状态、耗时、体积、错误摘要)。
- 渲染调用 `renderNotification(template, ctx)`(由 notify-template 任务提供,`server/notify-template.mjs`);该模块未就绪时用内置默认渲染兜底,接口见 notify-template/prd.md。
- 进程重启不丢批次:待发状态依据 store 里 run.notificationStatus 恢复。
- 设置项加入 shared/contracts.mjs 的 notification 配置并带默认值(向后兼容旧 settings)。
## 范围
仅改 server/backup.mjs 发信逻辑、server/scheduler.mjs/store.mjs 必要处、shared/contracts.mjs 的 aggregateWindowSec 字段;新增 server/notify-batch.mjs。不碰 web/。
## 验收
- tests/ 新增测试:3 个 run 同时完成→1 封邮件含 3 行;窗口=0→3 封;部分失败在邮件中标明;`npm test` 全绿。
