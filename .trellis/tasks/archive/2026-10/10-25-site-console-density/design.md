# Design: compact site inventory and repository navigation

Approved implementation design, 2026-10-25. Product decisions and the later file/clone scope amendment are in PRD; implementation is active.

## Data and compatibility

Extend the existing shared SiteInput with `repositoryUrls: string[] = []` and `notes: string = ''`. Keep site metadata in `sites.data` JSON, `site_jobs` as the single association authority, existing authenticated/CSRF CRUD, SQLite engine and system archive version. Shared TypeScript types still derive from the Zod contract.

Repositories: at most 20 entries of at most 2048 raw/canonical characters; trim, canonicalize, deduplicate identical hrefs retaining first order. Omit blank editor rows before parsing. Browser HTTP(S) links default to HTTPS for bare provider addresses. Exact recognized hosts: github.com, cnb.cool, gitee.com, gitcode.com and hub.gitcode.com. Preserve submitted GitCode host/label. Reject unsafe schemes/credentials/control whitespace/backslashes, deceptive hosts and nondefault repository ports. Require owner/group plus repository path; allow nested/deep paths, preserve case-sensitive path/query/fragment and .git suffix. Never probe existence, fetch icons, authorize accounts or guess roots by cutting paths.

One shared repository normalizer/provider/link projection owns href, provider and distinguishable label. It drives API/editor validation and rendering; no component substring heuristics. Notes are trimmed plain text <=500 characters, preserving internal newlines and rendered as text.

The store explicitly constructs public site DTOs and saved metadata: update both, plus schema/editor payload. Read defaults are required independently of schema defaults. Preserve merge-before-parse and atomic metadata/association writes. Omitted arrays/text retain previous values; supplied arrays replace; [] and '' clear independently; null/wrong types reject. Rejected writes do not change timestamps/relations. Domain-only display never truncates stored domains or navigation targets.

No new SQL table/endpoint/archive file/version. Whole-SQLite snapshot carries new metadata. Add legacy fixtures where site tables exist but new fields are absent, alongside old pre-site-table and current encrypted round trips. Preserve many-to-many IDs, foreign-key integrity and safe deletion.

## Shared site presentation and editor

Extract/reuse a compact site-row/list presentation between SitesView and overview; App remains API/mutation/request-epoch owner. Row components emit navigation/edit events rather than writing data.

- Identity: title and first saved address's hostname share one line on desktop/mobile. The complete canonical HTTP(S) URL is the href, including port/path/query/fragment. Preserve all addresses/order in editing. Add shared siteDomainHostname for the list's hostname-only label while retaining existing siteDomainLink/siteDomainLabel full-address projection for editor previews; invalid legacy values render as readable nonlinks.
- Long name/hostname may visually ellipsize within meaningful nonzero widths, retaining complete accessible values/tooltip. A hostname-only label is intentional; never shorten the actual href. Transparent address link with hover/focus affordance is distinct from filled tag-filter chips.
- Repository links use bundled small provider icons plus short repository labels and complete accessible names; multiple same-provider links remain distinguishable. Safe new-tab attributes and focus styling remain. Icons never require remote requests.
- Use horizontal columns/flex distribution and compact secondary lines for tags, repositories, actual job names/type/latest states and optional one-line note preview. Full notes open in the editor through keyboard/touch. Empty notes reserve no row. Avoid four tall stacked blocks and large nested job boxes.
- Mobile keeps one identity line, with compact wrapping secondary content and usable controls. Standard-fixture heights are bounded, not fixed-height clipping; long/many-link rows grow naturally. Actual task names/statuses remain readable.
- Editor adds repeatable repository fields and multiline notes, keeps all addresses and searchable/shared job associations, concise first-address help, field errors, stale-selected-ID handling and failed-save/polling draft preservation. Remove redundant preview/helper spacing when appropriate.
- Extend existing search to repository URLs and notes; site tags remain independent of task tags.

## Compact rhythm across the console

Preserve palette, readable fonts, <=8px container radii, 208/44px sidebar, 48px header, <=900px drawer, 1600px main maximum and one h1. Use actual local newapi sources; its table rows are 60px, not a claim that all rows should be 32px.

Proposed compact ranges: page title 18-20px, main insets 12-16px, panel headings 40-48px, desktop toolbar controls 32-36px and table vertical padding 8-10px. The frontend owner picks coherent values within these ranges against density/readability/overflow acceptance; preserve comfortable mobile hit areas and natural form content. Apply shared primitives consistently across sites/jobs/runs/files/storage/settings/overview.

Update obsolete exact-spacing assertions explicitly. Retain contained tables/toolbars/forms, sticky headings, scroll checks, shell geometry, single h1 and themes. A screenshot count without useful-row measurements does not establish density.

## Overview: task-preview replacement only

Keep title/navigation `备份概览`, four existing metric meanings, active execution, runtime environment and recent runs. Replace only its six-job panel with `站点列表`, up to six sites in persisted order, total count, `全部站点` link and create-site empty-state action. Keep normal new/all-job operations. Rows reuse compact presentation; associated tasks open existing details/versions and site editing uses the existing App-owned editor.

Render sites from independent site/job loaders even if /overview fails. Operational summaries show their own unavailable/stale state instead of invented zero values. Distinguish unloaded/error/empty/unlinked and unresolved IDs after successful reads; preserve request-epoch guards and editor isolation.

Per-job latest-attempt/activity/paused states stay precise. Do not infer per-site recovery points or full coverage from bounded recentRuns or one successful shared job. No new health/history/run-all API; avoid double counting shared tasks.

## Verification and rollout

Shared schema/provider/address-label tests; store/API atomic PATCH/legacy cases; current and legacy SQLite plus real encrypted export/download/staged import/restore with exact metadata/order/association comparisons. Browser coverage includes same/different-provider links, exact href and hostname, full editor arrays, literal multiline notes, search by repository-only and notes-only terms plus existing filter/reverse navigation/shared jobs, failed-save drafts, safe deletion and independent overview/sites/jobs failures.

Use the same eight sites and common name/address/tag/job data before/after. Disclose that the baseline UI has no repository/note fields; the final absolute density targets apply with both additions present. On #sites assert >=6 complete standard rows at 1440x900 (<=104px) and >=3 at 390x844/360x780 (<=156px). These are project acceptance targets, not existing measurements/newapi original values. Exceptional long content may grow. Keep seven pages/four widths/two themes, with actual overview site/address/job/repository labels. Prove production guards fail when key content is hidden or standard-row padding grows too tall, then pass after restoration.

Parent schedules full tests/type/build/browser/layout/radius/diff gates and screenshot inspection sequentially; independent reviewer checks all AC. No live production prerequisite or deployment. New metadata defaults empty on legacy records; no bulk startup rewrite. Scope larger provider/aggregate requirements back to planning. Preserve unrelated auth/task/journal/agent files and avoid broad staging.

## Precedence over the current spec after approval

The existing frontend spec describes the currently shipped implementation. For this task only, the approved PRD/design supersede these particular old presentation contracts; workers must implement their replacements rather than preserve contradictory old guards. Parent updates the executable spec with verified final values before completion.

| Current spec/guard | Selected replacement |
| --- | --- |
| ui-api.md requires overview .overview-job rows and built-in 系统配置 in each viewport | Actual overview site rows with visible title/first hostname/repositories/linked jobs, total/all-sites navigation and retained normal task access; production negative controls still required. |
| Current site guard expects every saved domain as a list link | Exactly the first saved hostname in the list identity row, complete href and all saved addresses verified in the editor/restore. |
| Exact wide main/stat/panel spacing in ui-api.md and check-layout | Compact approved ranges plus complete-row/height checks; metric meanings and shell/palette/containment remain. |
| Prior site description exclusion | Optional notes, including persistence/clear/search/plain-text/draft/restore assertions. |

All other current runtime and UI contracts remain in force. This is a planned, user-reviewed contract change, not a claim that existing spec/code already implement it.

## Added single-file and clone contracts

The latest user instruction authorizes these additions while core site implementation proceeds. `file` extends the existing job enum and `sourcePath`, not a script execution mechanism. `resolveSourcePath(...,{file:true})` must require a regular file after the existing root/component-symlink/realpath/state-overlap checks. Both save validation and execution choose explicit file branches. A file is valid at zero bytes; its archive payload contains only the selected basename (using existing internal tar conventions to retain metadata), never siblings. Revalidate immediately before preparation, keep subprocess cancellation and temporary quota/cleanup, and leave directory watchers/incremental/exclusions unchanged. Source listing already returns regular files; the picker adds file selection while directories remain navigation targets. Update every exhaustive job-type consumer.

`POST /api/jobs/:id/clone` accepts only an optional `name`. The route reads private source configuration, strips runtime/identity via shared schema parsing, generates a bounded default name and sets `enabled:false`. `store.cloneJob(sourceId, validatedInput)` transactionally saves a fresh job and copies its `site_jobs` relations; preserve site timestamps and reject atomically if a site's association limit would be exceeded. Destination IDs may be retained because retention ownership checks job ID before destination ID and verifies remote manifest job/run IDs. Never copy runs, lastRun, nextRunAt, baselines or queued state. Preserve schedule/watch configuration under the disabled job. Unknown source is 404, fixed system job is 409 `SYSTEM_JOB_CLONE_FORBIDDEN`, invalid body/name is 400, success is 201 with public redaction. A paused clone may retain a temporarily missing allowed source (`allowMissing:true`), while extant wrong-type/forbidden sources still reject.

Do not refresh the scheduler or watcher on clone: the new job is disabled, and scheduler refresh would unnecessarily update existing jobs' runtime timestamps. The frontend refreshes jobs/sites and opens the returned paused job editor. Guard duplicate submission, retain useful request errors and hide the fixed-system clone action. Existing source identity/configuration/history remain independent when either job is edited or deleted. No archive-format version or datastore migration is required.
