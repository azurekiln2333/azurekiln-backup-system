# Site repositories, compact console and overview site list

## Goal

Let an operator identify a site, open its access address/source repositories and see its associated backup jobs with more useful information per screen. Replace the overview's current task preview with sites while preserving its other operational information.

## Background and confirmed facts

- On 2026-10-25 the user requested GitHub, CNB, Gitee and GitCode repository binding with a small provider icon and one-click navigation.
- The user reports that the UI still has insufficient information density despite the earlier newapi-inspired work, and that access addresses currently resemble tags too closely.
- The user chose to replace only the current overview task list with a site list, rather than rebuilding the whole dashboard. Keep its page title, global metrics, active execution, runtime environment and recent runs.
- The existing site-management feature is committed and pushed on `feat/site-management`; it supports multiple addresses, independent tags and bidirectional many-to-many links to backup jobs. Preserve that behavior and its stored data.
- Task creation and planning were explicitly approved. The later immediate-implementation message authorizes the consolidated plan plus file/clone additions, as recorded in the approval amendment below. Work was assigned to the four existing right-side Pi panes.
- Source inspection found that site rows stack four blocks with 18px vertical padding and 12px gaps (`web/src/style.css:329`, `web/src/components/SitesView.vue:100`). Address links have a filled/padded rounded shape resembling the tag chips (`web/src/style.css:316`, `web/src/style.css:338`). Raising density must fix structure and spacing rather than shrink already small text or hide job names.
- The current overview contains global statistics, active execution, the first six jobs beside runtime environment, and recent execution (`web/src/App.vue:377`). Existing site/job/run data can support a site list and latest-attempt states, but cannot establish an exact per-site last successful recovery point from the limited global run list alone.
- Repository fields require changes at both the shared validation and explicit store projection/write boundaries; schema-only changes would be lost. Provider detection and icon/link rendering must share one normalized contract.
- The user explicitly chose multiple repositories per site and requested optional site remarks. The earlier site feature's exclusion of a description is superseded for this task.
- The user explicitly requested that the site title and one access address share a row. With several saved addresses, show only the first address's domain. Show hostname only, without scheme/port/path/query/fragment, while clicking still opens the complete saved URL. Preserve all saved addresses in the editor.
- The backup application's own state uses SQLite at `DATA_DIR/state.sqlite` (`server/store.mjs:31`), with sites and site-job relations in database tables (`server/store.mjs:55`). Local default is `.data/` (`server/config.mjs:20`); the Docker image sets `DATA_DIR=/data` (`Dockerfile:20`) and Compose mounts `backup-data:/data` (`compose.yaml:14`). Actual backup archives, the master key and private rclone configuration are files outside the database. No database-engine change is requested.

## Requirements

- R1: Allow an ordered optional list of up to 20 source repository browser URLs, each <=2048 characters, including mirrors or separate frontend/backend projects. Identify GitHub/CNB/Gitee/GitCode with local small provider icons and accessible, distinguishable direct links, including several repositories on the same provider. Infer providers from validated hosts. Canonical duplicates deduplicate in first order; omitted PATCH preserves, [] clears; legacy default is [].
- R2: Apply a coherent compact rhythm to shared page headings, panel/toolbars, controls and table spacing across the console, with structural site-row changes as the priority. Use the actual local newapi reference, preserve readable font sizes/mobile interaction areas and existing shell geometry/palette. Density targets are in AC2; long/many-link content may grow naturally.
- R3: Put the site title and first address on the same row. Render only that address's hostname as a transparent navigable link, retaining its complete URL as the navigation target. Retain every saved address in the editor and keep tags as visually distinct classification/filter chips.
- R4: Keep the overview title and current statistics/current execution/environment/recent runs. Replace only its six-job preview with a compact six-site preview in persisted order, total count, an explicit all-sites link and create-site empty-state action. Reuse site-row identity/repository/remarks/tag/linked-job presentation. Preserve actual job detail/version/run and all-job entry points; no site run-all action is implied. Keep independent sites/jobs/overview error/retry states and truthful latest-attempt/paused/activity states, without claiming whole-site recoverability.
- R5: Preserve existing site/job associations, archive/history data, authentication, backup/restore compatibility and unsaved editor drafts.
- R6: Allow optional trimmed plain-text site remarks up to 500 characters with multiline editing and a compact nonempty preview. Full text is accessible through the editor; reserve no empty preview row and never render HTML. Existing sites default to ''; omitted PATCH preserves and '' clears independently; failed saves preserve drafts. Include repository URLs and remarks in site search alongside existing name/domain/tag fields.

## Acceptance Criteria

- [x] AC1: Several same/different-provider links, local small icons and remarks persist through edits/reads/clears/reloads. Links have distinguishable accessible names and exact safe targets; invalid input rejects atomically; omitted old-client fields preserve data and failed saves preserve drafts. Remarks remain literal text. Searching a repository URL fragment or a word present only in notes finds its site, and clearing search restores the full list without changing tag/association behavior.
- [x] AC2: Compare the same eight sites and existing title/address/tag/job values before/after. Each final standard row has a 4-8-character title, two saved addresses, two tags, two jobs including a shared job, two repositories and a short note; record that repositories/notes were unavailable in the pre-feature UI rather than claiming identical full rendered content. On #sites at 1440x900 show >=6 complete standard rows with row height <=104px; at 390x844 and 360x780 show >=3 with height <=156px. Keep readable names/statuses and do not meet targets through fixed clipping/hidden useful content. Long/many-link exceptions may grow naturally; inspect all seven pages after shared spacing changes.
- [x] AC3: The title and first hostname share one identity row in light/dark themes at desktop/mobile widths. Additional saved addresses are not rendered as extra list links; the first link still includes any saved port/path/query/fragment in its href. Address links and tag filters remain visually distinct.
- [x] AC4: Overview replaces only its task preview with up to six sites, total/all-sites/create-site navigation, real associated job states and working details/versions. Existing metric meanings/current execution/environment/history remain. Populated/empty/unlinked/stale/error/retry cases work; /overview failure does not hide successfully loaded sites/jobs and /jobs failure does not erase saved relations.
- [x] AC5: Existing sites remain editable; repository links, full address arrays and remarks survive restart and system backup/restore; prior site/job behavior and relevant browser/layout checks continue to pass.
- [x] AC6: Type check/build/tests, real browser lifecycle, seven-page/four-width/two-theme assertion-based layout matrix and radius audit pass. Current/legacy snapshot and real encrypted export/download/staged import/restore preserve exact metadata/order/relations. Replace obsolete spacing/overview guards with selected-hostname/repository/job visibility and density guards, prove they fail with deliberate defects, inspect screenshots and obtain independent review.

## Out of Scope

- Repository cloning, source backup execution, OAuth/token access, repository synchronization, CI status checks and deployment automation. Repository binding is navigation metadata unless the user expands scope.
- The separate GHCR workflow and known new-api/PostgreSQL adapter follow-ups.
- Whole-dashboard replacement, historical site recovery/success-rate aggregates, site-wide run-all actions, database-engine/archive-format changes and shell topology/palette changes.

## Decisions and deferred items

Requested product decisions are recorded above. The cross-page compact scope, metadata limits and preview presentation are approved in the design. No blocking repository question remains. Provider icons are bundled locally without a runtime network dependency. Live production deployment is outside acceptance.

## Planning State

One integrated site-console deliverable: metadata, site-row presentation and the preview share the same contract and need integrated acceptance. `design.md`, `implement.md` and curated implement/check JSONL define implementation, four-Pi ownership and verification. Preserve unrelated auth/task/journal/agent-directory/ZIP changes. Planning concluded with the subsequent explicit implementation approval recorded below; the task is active on its feature branch.

## Implementation approval and added backup workflows (2026-10-25)

The user's subsequent message, “还有一个 为什么不支持单文件备份 然后就是备份任务的克隆功能 快点实施啊”, authorizes immediate implementation of the reviewed site/UI plan and explicitly adds these two workflows. Task activation succeeded on `feat/site-console-density`; no repeated approval is required.

- R7: Add a `file` job type using existing `sourcePath`, with a regular-file picker and file-manager create-job action. Manual and scheduled runs package exactly that file under its basename, preserving bytes and metadata without including siblings. Reuse compression/encryption, verification, destinations, retention, cancellation and cleanup. Enforce allowed roots, no source symlinks or special files, and source/state isolation at save and execution. Watching/incremental and exclusions remain directory features.
- R8: Add authenticated/CSRF-protected server-side cloning for ordinary jobs. Retain configuration, sealed archive/database secrets and site associations, give the copy a fresh ID/name and timestamps, default it to paused, and retain schedule/watch configuration without activating either. Never copy run history, queue state, next execution, watch baseline or remote ownership. The fixed system-config job cannot be cloned. The public response never exposes secret values. Successful UI cloning opens the new paused job for editing.
- [x] AC7: API tests reject directories supplied to file jobs, files supplied to directory jobs, forbidden/symlink/special/missing file sources as applicable; an actual encrypted backup/extraction round trip proves exact filename/bytes and absence of sibling files. File selection, editor and manual execution work in the real browser; manual/scheduled files use the shared lifecycle.
- [x] AC8: Clone tests prove fresh identity, paused state, private secret preservation/public redaction, retained site associations, empty history/baseline and no scheduling/watching activation, source independence after editing/deleting either job, system-job rejection, and existing auth/CSRF boundaries. The browser clone action works without requiring secret re-entry and failed requests do not create phantom rows.

The change boundary is the existing shared job schema → API validation/store → backup executor → job editor/list/file manager. Source browsing already lists regular files; extend selection rather than add unrestricted host commands or Docker socket access. No database engine, archive format, deployment or general script-execution change is included. Backend owner p4, frontend p8, tests/guards p6, documentation/review p7.

## Acceptance result (2026-10-25)

AC1–AC8 are complete. Both independent reviewers signed PASS after the final browser exit 0, serial real-tool suite and final layout matrix. See `evidence.md` and the two signed research reports for controlling results and historical failures. Scoped commit/publication use the existing user authorization; production deployment is separate.
