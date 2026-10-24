# Site management and shared backup-task associations

## Goal

Provide a dedicated site page where the administrator can see each site's domains, tags, and exact associated backup jobs at a glance. Site metadata organizes existing jobs rather than duplicating them or changing their execution.

User request: “添加站点，然后关联绑定任务……清晰可见哪个站点对应哪个域名对应哪些备份任务……站点还能打标签分类。” The user approved a separate planning task on 2026-10-24 and explicitly confirmed both directions of the relationship: one site can have several jobs (database, configuration, other files), and one shared job can serve several sites.

## Background and confirmed evidence

- No site entity/routes/foreign keys exist in `shared/`, `server/`, or `web/src/`. Existing job tags, filtering, and job types remain independent of the new inventory.
- `server/store.mjs:43` already uses additive SQLite table creation and foreign-key enforcement. `server/backup.mjs:242-286` snapshots the whole state database; startup applies imported state before opening the store (`server/app.mjs:73-85`). Site state in that database can therefore participate in normal system backup/restore without a separate export format.
- `web/src/nav.ts:26-35` contains an explicit Page union plus the navigation registry; both require a sites entry. `App.vue` owns data and mutations; views communicate through props/events. Existing job detail can show reverse associations.
- The frontend contract requires panel-contained content, a single page h1, <=8px container radii, and real desktop/mobile/light/dark checks. The current six-page layout matrix must include the new seventh page.
- Repository evidence and compatibility anchors are in `research/backend-sites.md` and `research/frontend-sites.md`; the user's confirmed many-to-many decision supersedes their earlier provisional cardinality options.

## Requirements

- R1: Add `站点管理` to the workspace navigation and implement site create/edit/delete using real authenticated APIs.
- R2: A site has a required name, a list of domains/HTTP(S) access addresses, tags, and associated backup-job IDs. Proposed first-release behavior: multiple addresses are supported; addresses and jobs can initially be empty so sites can be set up gradually. Show missing associations explicitly. No separate category hierarchy or notes field is needed for this request.
- R3: Implement the user-confirmed many-to-many relationship. Selecting a job for another site never transfers it away from the first site or creates a duplicate job. All existing job types can be associated as metadata; display their actual type/name so a global system-config job is not mistaken for site-file coverage.
- R4: Site rows display their name, domains, tags, actual linked job names/types and available current run states. A mere job count hidden behind a modal does not satisfy the at-a-glance mapping requirement. Selecting a linked job opens its existing detail/version UI; task detail shows its associated sites.
- R5: Site tags use the familiar chip interaction, suggestions, and tag filtering, with search covering site name/domain/tag. Site tags and job tags have independent values; association changes never copy or mutate either set.
- R6: Existing jobs are usable without sites. Site metadata and associations survive restart and normal system-configuration backup/restore, including import of older archives that contain no site tables.
- R7: Unbinding or deleting a site only removes the record/associations. Jobs, schedules, enabled/watch settings, credentials, runs, local/remote archives, and other sites' links remain intact. Deleting a job removes its links from all sites while preserving the existing job-delete protections and historical data policy.
- R8: Follow existing shell/design conventions and provide loading, error/retry, empty, no-match, and unassociated states. Failed saves preserve editor values; async refreshes must not overwrite newer state or turn a failed load into an empty-success view.

## Acceptance criteria

- [x] AC1 (R1, R8): Sites is reachable from desktop and mobile navigation, renders one h1 and existing panel primitives, and has working real CRUD and failure handling.
- [x] AC2 (R2, R4): Several addresses and linked tasks are readable on the page; create/edit/reload preserve exact saved values. Only validated HTTP(S) links can be opened, and addresses trigger no server-side network probe.
- [x] AC3 (R3): Two sites can share one job, one site can bind several different jobs, and unlinking/relinking preserves the other site's links and all original job settings. Duplicate/unknown IDs cannot cause partial writes.
- [x] AC4 (R4, R5): Name/domain/tag search, reusable site-tag chips, tag filtering, job-detail navigation, and reverse site names work with authoritative saved data.
- [x] AC5 (R6, R7): Migration/restart/restore retain identities and links; old databases/archives load with an empty site list. Deleting a site preserves its jobs/runs/archives, deleting a job removes all dangling site links, and relational integrity holds.
- [x] AC6 (R1-R8): Auth/CSRF/shared-schema/API/store tests and real browser checks exercise lifecycle, many-to-many links, error preservation, filtering, deletion safety, persistence and restore. The seven-page layout matrix covers 4 widths x 2 themes (56 renders), including populated sites and visible site/domain/job labels, while retaining every existing layout guard.

## Scope boundaries and dependencies

This is one independently verifiable site-management deliverable across storage/API/UI, so a parent/child task tree is unnecessary. Internal dependency: establish the shared site API contract first, then backend/frontend can proceed in parallel, then integrated verification must pass.

Excluded: DNS/certificate/hosting management, uptime monitoring, domain discovery, a separate category taxonomy, new backup executors, arbitrary host-script execution, PostgreSQL adapter fixes, Docker networking changes, image workflows, and remote pushes. These are not prerequisites for inventory association.

The image-pipeline task remains separate and unapproved for implementation/push. Its research now records the user's PostgreSQL 15.18 and network `new-api_new-api-network`, along with the existing new-api export defects. Do not lose those deployment follow-ups or silently mix their fixes into this task.

## Planning status and operational limits

Repository research is complete; `design.md`, `implement.md`, and curated implement/check manifests accompany this consolidated PRD. On 2026-10-24 the user explicitly approved the final plan: “批准，按方案开始实施”, including multiple addresses, tag filters, many-to-many associations, safe deletion and persistence/restore verification. This authorizes activation and implementation of the reviewed scope.

Actual reachability of the user's database and any deployed-server state remain unverified. Site associations are administrator-maintained inventory and cannot assert that a linked job is a complete disaster-recovery backup of that site.
