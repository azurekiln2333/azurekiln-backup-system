# jobs-batch-grouping:批量创建基线提交 + 任务列表分组折叠

负责 pane:**w1H:p2**。父任务:`10-18-ui-revamp-newapi-backup`(先读它的 prd.md 全局规则)。

## 背景

工作区里已有未提交的改动(约 13 个文件):`POST /api/jobs/batch`、`batchJobSchema`、任务 `tags` 字段、JobEditor 批量创建界面、tests、README、spec、`check-browser.mjs`。用户反馈「批量创建似乎还是没有」,需要先验证它是否真的可用、前端是否可见(注意 `dist/` 可能是旧构建)。其他三个 pi 要改同一批文件,所以**你必须最先把这批 WIP 变成干净的基线提交**。

## 阶段 0(最先做,阻塞他人):基线提交

1. `git status` / `git diff` 通读现有 WIP,确认它是自洽的、没有半成品。
2. 跑 `npm run check`、`npm test`、`npm run build`。有小问题就修。
3. 按逻辑拆成 2~4 个标准化提交(例如:contracts+store+app 的后端、JobEditor+App+style 的前端、tests+check-browser、docs+spec)。只提交这批 WIP 涉及的文件,**不要**提交 `.trellis/workspace/`、zip、各类 agent 配置目录。
4. 提交完成后在 board.md 追加 `BASELINE-DONE`。**在此之前其他子任务不会改共享文件**,请尽快完成(目标 10 分钟内)。

## 需求

### R1 批量创建(核对 + 补齐)
场景:源父目录 `/sources/backups/database/mysql/crontab_backup/` 下有子目录 a、b、c…
- 每个子目录各自成为**独立**的 directory 任务(不得压成一个包)。
- 每个任务的远端目标 = 目标根 + `/` + 子目录名,例如 `openlist:Storage/CloudflareR2/ServerBackups/mysqlbackups/a`。
- 其余设置(计划、压缩、加密、保留、监听、通知、标签…)全部来自同一份模板。
- 界面必须**明显可发现**:新建任务入口处能选择「批量(按子目录)」,可浏览选择父目录、列出子目录、全选/反选/按关键字过滤、预览「源路径 -> 远端路径」、任务名模板(含 `{folder}`)。
- 已存在同源路径的任务给出清晰的冲突提示;全部校验通过才落库(已实现,保持)。
- 用真实数据流验证:用临时目录造 a/b/c,经 API 和浏览器各走一遍,断言生成 3 个任务且路径正确。写成自动测试。

### R2 任务列表分组 / 折叠
数据库任务一多整个列表都是数据库。
- 任务列表支持**按分组展示且可折叠/展开**。分组依据由你定:推荐 `标签` 优先,其次 `源父目录`,其次 `类型`;提供「分组方式」切换(不分组 / 按标签 / 按类型 / 按源父目录)。
- 分组头显示:名称、任务数量、失败数量(如有)、全部展开/全部折叠。
- 折叠状态用 `localStorage` 记忆(try/catch 包裹,读写失败不影响渲染)。
- 搜索、启用状态筛选、标签筛选与分组共存;搜索命中时对应分组自动展开。
- 批量创建出来的任务默认自动打上一个以父目录名命名的标签,使其天然聚在一组(可在批量创建表单里取消/修改)。
- **不要重复元素**:不要在分组头、表格表头、页面标题里重复出现同样的标题。

### R3 实现落点(减少冲突)
- 分组逻辑写成独立 composable(如 `web/src/jobGroups.ts`)与独立组件(如 `web/src/components/JobsView.vue`),把 App.vue 里「任务列表」那一大段模板搬进去。
- **App.vue / style.css 在 SHELL-DONE 之前不要动**(ui-shell 正在重做外壳)。流程:先在新文件里把组件做完并通过单测/类型检查 -> 等 board 出现 `SHELL-DONE` -> 再对 App.vue 做最小接线(把列表段替换成 `<JobsView>`)并立刻提交。等待期间可做 R1 的补强与测试。

## 验收标准

- [ ] 基线 WIP 已拆分提交,`BASELINE-DONE` 已写入 board。
- [ ] 批量创建在 API 与浏览器中都能完成 a/b/c 场景,有自动测试覆盖。
- [ ] 任务列表可分组、可折叠、状态可记忆,与搜索/筛选协同,100+ 任务下仍清晰。
- [ ] 不出现重复标题/重复元素;未改崩任何已有页面(`npm run check:browser` 通过)。
- [ ] `npm run check`、`npm test`、`npm run build` 全绿;所有提交为标准化 commit 且已立刻提交。
- [ ] 更新 `.trellis/spec/frontend/ui-api.md` 与 `README*` 中相关说明。
