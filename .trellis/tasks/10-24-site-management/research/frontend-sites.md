# Frontend research: site management

Inspected 2026-10-24 for the planning task `10-24-site-management`. Research only; no product files changed.

Decision update: the user subsequently explicitly confirmed both directions of many-to-many binding. Treat any earlier cardinality options/questions below as historical research rather than unresolved requirements. Final proposed record/page behavior is owned by the PRD/design.

## Current navigation and state boundaries

- `web/src/nav.ts:26` declares the actual `Page` union explicitly (`overview|jobs|files|runs|storage|settings`); `:28-35` registers sidebar rows. Add `sites` to both the union and the registry. The spec describes a derived type, but the current source is an explicit union, so do not assume a registry row alone will compile.
- `web/src/nav.ts:49-56` derives grouped navigation, hash validation, and the page title from the registry. A `sites` entry under `工作区` naturally gives the sidebar label and a single page heading.
- `web/src/App.vue:20-23` implements hash navigation. `:98-99` changes the hash and closes the mobile drawer. The registry already supplies `pageTitle` and the shell's h1; a SitesView must not repeat a page-level heading.
- `web/src/App.vue:42` owns jobs; `:137-150` refreshes overview/jobs/runs from real APIs and reconciles the selected job; `:154-191` owns job create/edit/run/toggle/delete operations. `:272` passes state and callbacks into JobsView through props/events.
- `web/src/components/JobsView.vue:14-31` has a deliberately presentational props/events contract. Site list and binding edits should follow that boundary so task state and reverse associations update together. App can own `sites`, `loadSites`, and site CRUD/binding mutations; SitesView emits user actions. Keep a site-load failure from erasing valid jobs/overview data or presenting an empty list as success.
- `web/src/App.vue:129-130` clears job/overview state on logout; clear site state and selections there too. `:143` reconciles an open job after refresh; mirror this for an open site that is renamed/deleted elsewhere.
- `web/src/App.vue:290-296` already provides a job detail modal and archive browsing. Site-linked job names can emit `openJob` and reuse it instead of creating a second task/detail implementation.
- `web/src/api.ts:8-30` provides authenticated JSON reads and CSRF writes; use it for all site endpoints. `web/src/types.ts:1-24` derives editable types from shared Zod contracts and augments server DTOs; introduce SiteInput/Site in the same manner rather than copying a second schema into Vue.

## Existing tags and task-list behavior to reuse

- `web/src/components/JobEditor.vue:20-34` has chip-style tag editing: Enter/comma add, Backspace removes, case-insensitive deduplication, 10 tags and 32 characters per tag. `:22` suggests existing tags; `:208` renders the input/datalist. Reuse the interaction and CSS for site tags; avoid silently mutating task tags when a site is classified.
- `web/src/components/JobsView.vue:40-53` already owns search, enabled status and tag filtering. `:43-45` derives current tags and removes a stale filter when its final tag disappears. Site filters need the same stale-selection behavior.
- `web/src/components/JobsView.vue:47-53` searches task name, description, source, tags, and destination. If sites appear as task badges or a task filter, include linked site names/domains only through a correctly updated relation; do not overload the existing free-text tags as foreign keys.
- `web/src/jobGroups.ts:4` restricts GroupMode to `none|tag|type|source`; `:51-63` chooses one bucket per task, with tag grouping based on its first tag. Do not add a site grouping mode accidentally if tasks can belong to several sites: the current grouping contract is exactly one bucket per matching task. A separate site filter/badge is compatible; site grouping needs its own deliberate multi-membership behavior.
- The task editor saves full validated JobInput (`JobEditor.vue:154-189`). A new site relation field on JobInput must be initialized for old DTOs and preserved by every edit, not lost through a schema parse. A separate site-to-job binding endpoint can avoid changing unrelated backup settings.

## Recommended coherent UX

1. Add `站点管理` under the workspace navigation. App's existing page header owns the sole h1; its action opens `新增站点`.
2. The site page has a panel-contained toolbar with name/domain/tag search and a site-tag filter. Distinguish no sites, no matching results, loading, and API failure with retry.
3. Each visible site entry shows its name, domain(s), site tags, and the actual linked backup task names with current states/count. This mapping must be visible in the page rather than discoverable only after opening several dialogs. The linked jobs can reuse current status labels, date formatting and open-job behavior.
4. A site editor handles name, domain(s), optional notes, tags and a searchable selection of existing tasks. Show task type and source beside duplicate-looking task names. Saving associations should not change a task's schedule, password, destination or enabled state.
5. An empty job association has an explicit `未关联备份任务` state and `关联任务` action. Existing tasks do not become associated merely because their names/tags look similar.
6. Show reverse site associations in the task detail (and optionally a compact task-list badge/filter) so the relationship remains understandable from both directions. Avoid adding another wide mandatory table column on narrow screens.
7. Deleting a site is presented as removing the site record and associations, never deleting the linked backup jobs or their archives. Unbinding a task is a separate safe action.
8. Domain links are display/navigation metadata, not automatic health monitoring, DNS control or backup-source discovery. If links are clickable, restrict generated hrefs to validated HTTP(S); do not automatically fetch sites or remote favicons as part of this scope.

After this initial research, the user explicitly confirmed many-to-many in both directions: one site may link several jobs, and one shared job may link several sites. The final plan now records that confirmed decision. Supporting several display domains for one site is a proposed first-release detail for the final review, rather than an inferred user approval.

## Layout contracts

- `web/src/style.css:199-225` defines the existing page and panel primitives. Every page content block remains inside `.panel`, `.panel-heading`, `.panel-body`; do not introduce bare toolbars/forms below `.main-content`.
- `web/src/style.css:239-240` defines desktop `content-grid` and its minimum-width rules; `:268-280` contains horizontal table scrolling. `:315-322` supplies tag chip/input styles; `:372` and `:419-422` supply form/property grids.
- `web/src/style.css:360-366` defines modal geometry/sticky action footer; `web/src/components/Modal.vue:6-28` already handles Escape, focus trapping/restoration and body scroll. Reuse this modal component.
- Site-specific styling should use the current palette and radius tokens; containers must stay <=8px. Keep the shell's 901px desktop/900px drawer split and support 360px mobile without hidden names, clipped controls or document overflow.
- Use readable wrapping/ellipsis for long domains and site names. Showing only a count of associated tasks does not satisfy the requested at-a-glance site-to-task mapping.

## Verification changes

- `scripts/check-layout.mjs:31-38` hardcodes six pages. Add `{id:'sites',h1:'站点管理'}` and update the coverage comment at `:6`. The existing matrix at `:210-224` covers widths 1440/768/390/360 in both themes; with a seventh page it covers 56 page renders, plus the existing supplemental screenshots.
- `scripts/check-layout.mjs:244-266` asserts one h1, panel structure, no overflow, no legacy classes and valid radii. Keep all existing assertions and add meaningful visibility checks for site/domain/task labels, including long content; do not let an always-empty page be the only sites layout evidence.
- The layout fixture currently creates an administrator and only the built-in system task (`check-layout.mjs:190-209`). Add isolated real site/job fixtures through the store/API for the populated site page while preserving the required built-in overview task row.
- `scripts/check-browser.mjs:375-430` creates and executes a real Directory A task. Site CRUD/binding tests can reuse that isolated job (plus a second site/job as needed) without changing the user's installation.
- Browser assertions should cover site creation/edit/reload persistence, domain visibility, tags/search filtering, task association/unbinding, reverse job association, rejection of invalid/unknown references, deletion leaving tasks/archives intact, failure preserving editor input, and the chosen shared-job cardinality. Add mobile/light/dark screenshots in the existing responsive section (`check-browser.mjs:495-518`).
- Run `npm run check`, `npm run build`, `npm run check:browser`, `npm run check:layout` and the radius audit. Browser/layout suites should run sequentially; the spec warns concurrent real backup checks can starve rclone detection.

## Expected frontend paths

- Modify `web/src/nav.ts`, `web/src/App.vue`, `web/src/types.ts` for navigation, authoritative state/API wiring and shared-schema DTOs.
- Add `web/src/components/SitesView.vue` and `web/src/components/SiteEditor.vue` (or a similarly scoped editor) for presentation/form behavior.
- Modify `web/src/components/JobsView.vue` / `JobEditor.vue` only if reverse binding display/edit is included in the approved UX. App's existing job detail is another targeted place for reverse association.
- Add minimal site styles to the existing style organization; avoid a shell refactor.
- Extend `scripts/check-browser.mjs`, `scripts/check-layout.mjs`, and frontend contract documentation after implementation. Backend/API/store and shared schemas are owned by the separate backend research stream.

## Confirmed decisions and remaining final-review details

- Confirmed by the user after initial research: the same backup task may be linked to multiple sites and a site may link multiple tasks. No ownership transfer or task duplication should occur.
- Whether a site has one domain or several aliases. A list supports the requested mapping without requiring duplicate site records.
- Which site fields beyond name/domain/tags are in the first release (notes are useful; uptime/DNS/server management is outside the stated request).
- Whether classification means tags only or an additional mutually exclusive category field. Existing task tags provide a familiar tags-only interaction; do not introduce a second taxonomy without confirmation.

## Focused final-plan review

Reviewed the current `prd.md`, `design.md`, `implement.md`, and both context manifests after the user's many-to-many confirmation. No frontend blocking contradiction was found. The plan requires actual linked job names/types/status at a glance, reverse task-detail associations, independent tags, safe unlink/delete behavior, failure-preserving forms, and populated seven-page/four-width/two-theme checks (56 page renders) without removing prior shell guards.

Implementation cautions:

- `web/src/App.vue:81` currently implements `typeLabel` as system/Vaultwarden/otherwise-directory, so it mislabels new-api as directory. A site view/detail promising actual task types must not reuse that helper unchanged. Add the new-api branch in the relevant task-owned type display; no general type-label refactor is required.
- Reconcile saved site selections and server state after refresh, but do not push refreshed props into a mounted editor's unsaved form. Clone the initial DTO and preserve user input after API failure.
- The existing layout harness waits for h1 and then a fixed delay. Site-specific assertions must explicitly await loaded populated site/domain/job labels so a pending load cannot produce weak empty-only evidence.
- Domain caps and normalization are technical details still to be settled consistently in the shared schema before backend/frontend implementation diverge. In particular, preserve case-sensitive URL paths and do not interpret a bare host-and-port as an unsupported URI scheme accidentally.

This review changed research only. Product code and task activation were untouched.
