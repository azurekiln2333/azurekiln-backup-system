# 父任务:UI 重构(参照 newapi) + 令牌管理 + newapi 数据备份 + 批量/分组任务

## 来源需求(用户原话要点,忠实转录)

### A. UI(参照 newapi,色调保持本系统原样)
- 参考 `D:\My2KProjects\new-api`(newapi 前端)。成功案例 `D:\My2KProjects\codebuddy2api-ui_template`(照着 newapi 改的),但它有以下问题,**本项目必须避免**:
  1. 面板圆角太大。newapi 有一档 0.5(rem)的圆角,**参照那一档**;或参考 MD3 标准圆角。
  2. 凭证管理里,账号卡片上下各有一条多余的线。
  3. 「全部账号」卡片出现两条额度条(重复)。
  4. 存储管理页显示 "not found"。
  5. 侧边栏「管理工作区 / 管理员」卡片太丑,移除。
  6. 侧边栏展开/收起没有动画,参考 newapi 的侧边栏动画。
  7. 侧边栏底部的「管理员会话」删除。
  8. 主体内容底部的「AzureKiln · 管理控制台」删除。
- 三条硬约束:
  1. 圆角照 newapi 0.5 档 / MD3 标准圆角。
  2. **不要改崩原来的所有界面**。
  3. **不要出现重复元素、重复标题**。布局参考 newapi:头像、账号、退出挪到**右上角**。
- 研究能否创建**多个令牌 Key**;能的话开一个页面做令牌管理。

### B. newapi 数据备份
- 读 newapi,弄清哪些数据重要。新增一项「newapi 数据备份」。
- 必须覆盖:系统配置、各种配置、模型配置、密钥配置、审计、记录的消耗额度 / tokens 数等。
- 检查数据库是否都覆盖到;检查数据库之外是否还有关联的外部文件;有就制定备份规则。
- 目标:把整套数据拿到另一台机器还原后**一模一样**。**不备份**主程序源码、docker 镜像。

### C. 数据库任务与批量创建
- 数据库备份任务列表要能**展开/折叠**或**分类**(数据库一多,整个列表全是数据库)。
- 批量创建任务似乎仍然没有,要检查。场景:`/sources/backups/database/mysql/crontab_backup/` 下每个子目录(a、b、c…)**各自独立**成一个任务(不要一股脑压成一个包),远端目标目录随之对应:
  - `.../crontab_backup/a` -> `openlist:Storage/CloudflareR2/ServerBackups/mysqlbackups/a`
  - `.../crontab_backup/b` -> `openlist:Storage/CloudflareR2/ServerBackups/mysqlbackups/b`
  - 其他设置项全部一致,不想一个个手动加。

## 子任务地图(各自可独立验证)

| 子任务 | 目录 | 负责 pane | 关键依赖 |
|---|---|---|---|
| jobs-batch-grouping | `10-18-jobs-batch-grouping` | w1H:p2 | 最先提交「基线」,发 BASELINE-DONE |
| ui-shell-newapi | `10-18-ui-shell-newapi` | w1H:p3 | 等 BASELINE-DONE 才能改 App.vue / style.css |
| api-tokens | `10-18-api-tokens` | w1H:p4 | 调研结论决定是否落地;前端接线等 SHELL-DONE |
| newapi-data-backup | `10-18-newapi-data-backup` | w1H:p5 | 后端独立;前端接线等 SHELL-DONE |

> 父子关系不是依赖系统。依赖顺序写在各子任务 prd/implement 里,也写在 `board.md`。

## 全局规则(所有子任务必须遵守)

1. **同一个工作区、同一个 git 工作树,4 个 pi 并行**。因此:
   - 每个提交只用路径限定:`git add <明确文件>`,`git commit -m "<msg>" -- <明确文件>`。**禁止** `git add .` / `git add -A` / `git commit -a`。
   - 提交前 `git diff --cached --stat` 自查,若混入不属于自己的改动,先 `git restore --staged` 取消,稍等再试。**不得**回滚、覆盖他人未提交的改动。
   - `index.lock` 被占用就等几秒重试。
2. **立刻提交**:每完成一个可独立验证的修改就提交一次(用户明确要求,此授权覆盖 workflow.md 3.4 的逐次确认)。**不 push、不 amend**。
3. **标准化 commit**:沿用仓库风格 `type(scope): subject`,英文,祈使句,≤72 字符。type 取 `feat|fix|refactor|style|docs|test|chore`。示例见 `git log --oneline`。
4. **绝不提交**:`.env`、`*.zip`、`.agent/ .claude/ .codebuddy/ .codex/ .cursor/ .dsh/ .kimi-code/ .opencode/ .pi/ .trae/ .zcode/`、`.data/`、`dist/`、`node_modules/`、`.trellis/workspace/`。不要在输出里回显 `.env` 里的密钥值。
5. **文件归属**(共享文件只能按规则改):
   - `web/src/App.vue`、`web/src/style.css`:ui-shell 为主人。其他子任务在 SHELL-DONE 之前**不得**修改;之后只能做最小接线并立即提交。
   - `web/src/components/JobEditor.vue`、`server/store.mjs` 的 jobs 相关、`shared/contracts.mjs` 的 job/batch 部分:jobs-batch-grouping 为主人;newapi-backup 如需加类型字段,等 BASELINE-DONE 后再改并立刻提交。
   - 新功能请优先**新建文件**(新模块、新组件),降低冲突面。
6. **公共看板**:`.trellis/tasks/10-18-ui-revamp-newapi-backup/board.md`。每个 pi 在里面**追加**一行状态(只追加,不改他人行):`[时间] [pane] [状态] 描述`。状态词:`START | PROGRESS | BLOCKED | BASELINE-DONE | SHELL-DONE | REVIEW | DONE`。遇到需要用户决定的事写 `BLOCKED` 并附带你选的默认方案,**先按默认方案继续做**,不要停下等待。
7. **验证**:改动后必须通过 `npm run check`、`npm test`、`npm run build`;涉及界面的要跑 `npm run check:browser` 并真实看一眼页面(改前先截图留底)。开发服务端口不要与他人冲突(各 pi 用不同端口,例如 p2=16401,p3=16402,p4=16403,p5=16404),临时数据放各自的临时目录,不要碰 `.data/`。
8. **走 Trellis 流程**:每个子任务由其负责 pi 自己执行 Phase 1(prd 已给 -> 补 `design.md` + `implement.md` -> 配 `implement.jsonl/check.jsonl` -> `task.py start`)、Phase 2(implement -> check)、Phase 3(spec 更新 + 提交)。需要的 spec 在 `.trellis/spec/`。
9. **收尾互审**:全部 `DONE` 后,每个 pi 审查**下一个 pane** 的提交(p2->p3->p4->p5->p2),把发现写入自己任务目录 `review-of-<被审>.md`,原作者负责修复并提交,再发 `DONE`。最终由 p3(ui-shell)做整体回归(check:browser + 全部页面巡检)并在 board 写 `ALL-DONE`。

## 验收标准(父任务)

- [ ] 4 个子任务均 `DONE`,互审问题全部关闭,`ALL-DONE` 已写入 board。
- [ ] `npm run check`、`npm test`、`npm run build`、`npm run check:browser` 全绿。
- [ ] 所有改动已按规则分批提交;`git status` 里不再有本次任务相关的未提交文件(用户自己的无关文件除外)。
- [ ] 未 push、未 amend、未提交任何被禁止的文件。
- [ ] 各子任务验收标准全部满足(见各自 prd.md)。
