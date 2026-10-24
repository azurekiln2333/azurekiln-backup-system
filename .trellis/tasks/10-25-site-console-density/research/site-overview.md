# Research: a site-centered backup overview

Date: 2026-10-25. Planning-only source inspection. No product edits, tests, builds, or Git mutations. The only written file is this research note.

## Current overview and operational entry points

The overview is inline in `web/src/App.vue`, not a separate dashboard component:

| Surface | Current content | Source anchors |
| --- | --- | --- |
| Page toolbar | Refresh and create-backup-job buttons; page title comes from the navigation registry | `web/src/App.vue:373`; `web/src/nav.ts:26-31` |
| Initial loading gate | Overview/jobs/runs wait on `loaded`, which becomes true only after the overview/runs promise succeeds | `web/src/App.vue:196-197`, `:375-376` |
| Four statistics | Total/enabled backup jobs; queued/running jobs; global most recent successful run time; temporary storage usage/limit | `web/src/App.vue:377` |
| Current executions | Conditional global queue/running panel, job name, execution phase and available live progress; opens actual run detail | `web/src/App.vue:378`; data derived at `:91-92` and `:104-109` |
| Main left panel | First six jobs in store order, including the built-in system task; name/type icon/source/optional description, last-run status, individual immediate-backup button | `web/src/App.vue:379` |
| Main right panel | Real tool availability for rclone, 7-Zip, tar, SQLite, PostgreSQL and MariaDB; storage shortcut | `web/src/App.vue:93-98`, `:379` |
| Recent executions | First six of the overview's eight most recent global runs; job name, status, creation time, archive bytes and duration; run-detail and all-history shortcuts | `web/src/App.vue:90`, `:380`; `server/app.mjs:306-312` |

Important existing actions:

- `openJob` (`web/src/App.vue:328`) opens the existing task summary/version modal and loads real archive data. The template at `:402-406` offers job metadata, reverse site links, recent run, verified archive/download information.
- `selectedRun` opens RunDetail; keep current-running and history rows connected to real run IDs.
- The current individual `runJob` action uses the existing busy/active checks. `canRunJob` at `web/src/App.vue:103` protects unconfigured system backups. A site layout must not bypass these conditions.
- `openSite` at `web/src/App.vue:304` currently navigates to `#sites` and opens the editor; there is no separate read-only site detail route. A link using this action should say it edits/manages the site, not imply an unimplemented site-details page.
- Global task/history/storage navigation must stay reachable, especially for unassociated tasks and the built-in system task, which are legitimate even when no sites exist.

## Available site data and honest derived fields

`Site` is currently `{id,name,domains,tags,backupJobIds,createdAt,updatedAt}` through shared `siteSchema` and `web/src/types.ts:24-36`. Saved sites load independently through `/sites`; jobs load through `/jobs`. `server/store.mjs:124-129` projects the single authoritative relation, so frontend joins do not require a new site persistence model.

The existing `SitesView` demonstrates usable joins, saved-ID counts, unresolved links, name/domain/tag search and independent loading states (`web/src/components/SitesView.vue:35-75`, `:94-168`). It also shows actual linked job names/types/latest-run status. Do not render that full tall editor-oriented page unchanged inside the overview; its present `.site-row` has 18px/20px padding and separate identity/domain/tag/job rows (`web/src/style.css:329-338`), which would repeat the current density issue.

Fields available without new backend aggregates:

- Site name; canonical navigable HTTP(S) addresses via the existing shared `siteDomainLink`; independent classification tags.
- Exact saved association count, linked task names and types, enabled/paused flags, next scheduled time, and each task's latest recorded execution status/phase/time.
- Active linked job count, newest linked execution attempt, latest failed/interrupted attempt, tasks never run, and tasks with no active schedule. Use the precise label that matches the predicate, rather than treating all of these as the same failure condition.
- Global site count, sites with/without any linked jobs, sites affected by active jobs, and unassociated-job count. Repository/provider links can be added when this task's shared repository metadata contract is implemented; the current Site DTO has no repository field.

Truthful status semantics:

1. Prefer a small status breakdown beside actual task names, for example `执行中 1 / 最近失败 1 / 尚未执行 1`, over a single unexplained green/red site badge. If one summary badge is chosen, document its precedence and still expose contradictory constituent states.
2. A site's newest linked execution attempt can be derived by comparing linked jobs' `lastRun.createdAt`, with the originating task name and exact attempt result. Call it `关联任务最近执行`, not `站点最后备份` or a restore-point time.
3. A task can be paused while its last attempt succeeded. Show paused/enabled as a separate configuration state; do not let the last-run badge imply its scheduler is active. No schedule is also not proof of a problem: a task may intentionally run manually or watch a directory.
4. An empty association set means `未关联备份任务`. A failed/unattempted job read means `任务信息待加载/刷新失败`, preserving the saved IDs/count. An unresolved ID after a successful read is a synchronization issue, not permission to silently remove the link.
5. A shared job may affect several site rows. Count global active tasks by unique job ID, and affected sites by unique site ID; label the units explicitly. Do not sum per-site job counts into a global task count, and do not run a shared task repeatedly merely because several rows reference it.
6. A linked job's `succeeded` status is an execution result, not proof that the whole site can be recovered. Shared jobs may cover only part of a site; domains are inventory metadata. In addition, a successful no-change incremental run can have no new archive or targets (`server/backup.mjs:521-525`). Do not label a site `可恢复`, `已完整备份`, or `恢复验证通过` from `lastRun`.
7. Public `Job.lastRun` is intentionally only a summary (`web/src/types.ts:15`; `server/store.mjs:121`). It omits target verification/retention, warnings, backup kind, notification state and restore-test evidence. Keep existing task-version/run-detail surfaces as the source of those details.

### History limitation

The current global `recentRuns` contains only eight records, of which the overview shows six (`server/app.mjs:308`; `web/src/App.vue:90`). App's history array is a 30-row, user-filtered/paginated page (`web/src/App.vue:151-154`). Neither is complete per-site history.

`Job.lastRun` contains only the latest attempt. If the latest attempt failed, a prior successful attempt is absent from that summary. Consequently, accurate per-site `lastSuccessAt`, per-job last-success time, success rate, retained backup size, or recovery-point age cannot be inferred by filtering these currently available lists. A UI-only first release should omit those claims. If the user specifically wants such historical metrics, add a dedicated server aggregate over the related job IDs and define whether a site's timestamp means any task succeeded or all required tasks have successful artifacts. Do not create N per-job history requests on every poll to hide that contract decision.

The current runs endpoint accepts one optional `jobId`, not a set of site jobs (`server/app.mjs:229-234`). A site-wide history filter would therefore be a distinct API/UI extension; linking each displayed task to existing detail/history is immediately feasible.

## Two concrete scope options

### Option A: replace the main task list with a compact site list

Replace only the `备份任务` panel at `App.vue:379` with `站点概览`: site name, clearly linked address text, small repository-provider actions once available, lightweight tag labels, and actual linked task names/latest statuses. Offer `全部站点` and a create-site empty-state shortcut. The main toolbar can retain new-task access, with site management as a clear adjacent link/action.

Keep current-execution visibility, global job statistics, tool/storage information, and recent execution history. Preserve `全部任务` or an explicit `未关联站点的任务 N` shortcut so no site association is required to operate a backup task. This has the smallest data/API impact and preserves existing real operational controls, while making the overview's main information unit the site. It does not make the whole page a site dashboard: the top metrics and lower history remain job-oriented.

If the preview is limited, display the total and an explicit all-sites link. Do not quietly replace the current arbitrary six-job cap with an equally hidden six-site cap. Fix the preview count/order as part of the density acceptance criteria.

### Option B: rebuild the entire overview around sites

Replace headline statistics as well as the primary list with site inventory metrics, for example total sites, sites with no associations, sites affected by current execution, and sites with a latest failed/interrupted linked task. Use precise labels and counts; do not imply complete backup coverage or infer historical success rates.

Use a dense site table/rows as the main body, with domains, repository links, classification tags, linked task names and the documented status breakdown. Add a compact global operations section for actual active runs, unassociated tasks, storage/tool failures, and recent real attempts. Recent attempts can show their associated site names, including multiple names for a shared job and an explicit unassociated label, but must still open the same run detail.

This option better satisfies a request to change the whole overview and allows density changes to remove the large existing stats/grid rhythm. It changes more layout acceptance contracts and needs a clear approved design for headline metrics, section order, preview/sorting and mobile folding. Historical site-success/recovery metrics remain additional backend scope unless explicitly chosen.

## The key user-owned ambiguity

Does `备份概览能不能换成显示站点信息` mean replacing the central task preview only (Option A), or replacing the headline statistics and whole dashboard structure (Option B)? That choice controls whether global runtime/storage/history stays prominent, becomes a compact subsection, or is only reachable through navigation. It should be decided alongside whether the title remains `备份概览` or becomes `站点概览`; implementation should not silently remove operational information or invent an aggregate site-health definition.

Secondary details can be handled in the final concrete proposal: which site fields are visible at first glance, list ordering/preview cap, whether any summary status uses breakdowns or precedence, and whether the user expects site-wide history/actions. No site-wide `一键备份全部` action is implied by the current request.

## Loading/error and regression requirements

- Existing independent loaders are at `App.vue:162-235`. A site-centered overview must consume `sitesLoaded/sitesLoading/sitesError` and `jobsLoaded` directly. The current `!loaded` gate at `:375` blocks the entire overview after an initial `/overview` failure even if `/sites` and `/jobs` succeeded; change that gate with the approved view so site information is independently useful.
- Preserve stale-response protection, draft isolation, saved association IDs, and source-specific error/retry states. A failed `/sites` request must not say `尚无站点`; `/jobs` failure must not say saved sites are unlinked; `/overview` failure must not hide successfully loaded site inventory. Global operational summaries should show their own unavailable/stale state instead of fallback zero-as-fact.
- `scripts/check-browser.mjs:581-800` has real site lifecycle, shared associations, navigation, filtering, polling draft/error preservation and unlink/delete tests. Its independent resource-failure cases are currently on `#sites` (`:712-769`), so add equivalent `#overview` cases when sites are displayed there. Preserve actual backup/run/download controls and existing task operations.
- `scripts/check-layout.mjs:31-39` walks seven pages x four widths x two themes. Its overview-specific guard at `:325-340` requires visible `.overview-job` name/icon/source rows including `系统配置`. An intentional site-preview replacement requires an explicit updated contract, not retaining invisible legacy rows or skipping the guard when zero task rows render.
- Replace obsolete overview-row assertions with populated site name/address/linked-job/repository visibility assertions at every width/theme. Existing `assertSiteVisibility` at `scripts/check-layout.mjs:211-223` proves many-to-many names are visible; negative controls at `:428-448` reuse the same production guard and hide each field independently. Adapt/reuse that mechanism for the overview instead of creating screenshot-only verification.
- Existing dashboard geometry is asserted at `scripts/check-layout.mjs:351-375` and `:450-475`: desktop main padding, two-panel grid/1.6:1 ratio, 20px mobile gap, exactly four transparent stats and their 18px/20px padding. Option A can retain most of it. Option B and the density task may intentionally change these specific constants after approval; replace them with measurable new density/readability targets while preserving panel containment, accessible names, no control/document overflow, real visible labels, local assets, radius scale, and light/dark/mobile coverage.
- Inspect current CSS at `web/src/style.css:231-242` and `:329-338`: merely copying `.site-row` into the dashboard will not demonstrate improved density. Acceptance should compare a fixed populated fixture and viewport, such as visible site/linked-job labels within a 1440x900 first viewport, with readable/wrapping content at 360px. Do not improve density by hiding labels or clipping the primary information.

No tests/builds were run for this source-only planning research.
