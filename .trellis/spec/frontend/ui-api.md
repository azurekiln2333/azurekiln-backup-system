# Console and API Contracts

## 1. Scope / Trigger

Apply to `web/`, shared task schemas, and API changes that affect user workflows. This is a working single-administrator console with real API data and empty/error states.

## 2. Signatures

- `api<T>(path)` reads `/api` and parses the standard JSON/error response.
- `write<T>(path,body?,method?)` attaches the current CSRF token.
- `JobEditor` accepts `{job?,initialType?,initialSourcePath?}` and emits `saved(job)` or `close`. Only new jobs use the initial source path.
- `FileManagerView` emits `createJob(path,type)` from the current directory or a directory/file row; App opens the corresponding directory/file JobEditor with that source prefilled.
- `PathPicker` accepts `{kind,remote?,initialPath?,initialFile?,select?}`; `select` is `directory` by default or `file`. `initialPath` is the browsing directory; `initialFile` is the optional current filename, preselected only once after a listing confirms it is a regular file. Directories navigate in either mode; only a regular file is confirmable in file mode. It emits an absolute source or relative remote path.
- `RunDetail` accepts `{id}` and polls until execution, cleanup, and notification settle.
- `nav.ts` exports `navItems` (the page registry), the explicit `Page` union, `isPage(value)`, and `pageTitle(page)`. Extend both the union and registry when adding a page.
- `errors.ts` exports `friendlyError(cause, fallback?)` and `rawError(cause)` for user-facing error copy.
- `AccountMenu` accepts `{username?, theme}` and emits `toggle-theme` / `logout`; it owns the only sign-out entry point.
- `JobsView` accepts `{jobs,overview?,busyId,activeJob,canRunJob}` and emits `create|open|run|edit|remove|toggle|toggleWatch|clone`. It owns the list's search, enable filter, tag filter, grouping mode and collapse state; it never calls the API itself, so App stays the sole owner of data and mutations.
- `web/src/jobGroups.ts` exports `groupJobs(jobs,{mode,match})`, `readCollapsed/writeCollapsed(storage,mode)`, `readGroupMode/writeGroupMode(storage)`, `dirname` and `groupModeLabels`. `mode` is `none|tag|type|source`.

## 3. Contracts

- Schemas/defaults come from `shared/contracts.mjs`; `web/src/types.ts` extends DTOs with timestamps, configured flags, and runtime results.
- CRUD uses server responses as authoritative state. Never seed example jobs in the application.
- Navigation is hash-based: overview/jobs/sites/files/runs/storage/settings. Theme persists in `backup-theme`.
- `web/src/nav.ts` is the page registry: its rows supply sidebar entries, the hash validator, the `<h1>` title, and the optional task-count badge (`badge: 'jobs'`). Adding a page also requires extending the explicit `Page` union and an `App.vue` body branch.
- Each page renders its title exactly once, as `.main-content h1`. The topbar shows only the fixed `管理控制台` label and must not repeat the page name. No page-eyebrow/English sub-heading above `h1`.
- Sidebar collapse persists in `backup-sidebar-collapsed` (`'1'`/`'0'`, try/catch — storage may throw). Collapse only applies at `min-width: 901px` (desktop); at `max-width: 900px` the sidebar becomes a `transform` drawer keyed off `.sidebar.open` and all collapse rules are neutralised.
- Collapse animates through `--sidebar-motion` (200ms) on `width`, `margin-left`, and label `opacity`+`max-width`. Never toggle `display` on labels mid-transition, and keep `overflow-x: hidden` on the rail so the transition never widens the document. The collapsed rail keeps icons plus `title` tooltips.
- Border radius comes only from `--radius-sm|md|lg|pill` in `style.css`. `--radius` is `0.5rem` (8px), matching new-api's 0.5 tier; containers never exceed `--radius-lg`, and only badges, switches, avatars, and dots use `--radius-pill`. `node scripts/ui-radius-audit.mjs` fails the build on any raw corner value.
- Account identity and sign-out live in the topbar `AccountMenu`, not in the sidebar. The sidebar has no workspace label, no administrator card, and no session footer; the content area has no footer. Overview's `运行环境` panel carries no `管理员会话` line.
- User-facing errors go through `friendlyError()`: low-level text (rclone `specify an existing rclone configuration file`, HTTP `not found`) is classified into actionable Chinese copy, and the original string is exposed only as a `title` tooltip via `rawError()`. An error panel and an empty-state block are mutually exclusive — never render both for the same failure.
- File management is a read-only view of allowed source roots. A single root opens automatically on initial load; explicit navigation back to mounted roots must stay there. Search is case-insensitive within the entire current directory, with 100-entry pages. Source visibility comes from container mounts and SOURCE_ROOTS, not host filesystem discovery.
- File navigation tracks the requested directory separately from successful results so retry replays the failed request. Search changes invalidate older requests before the debounce delay; stale responses cannot change the displayed directory. Refresh clamps pages when directory contents shrink. Breadcrumb containment handles trailing root separators and chooses the nearest configured root.
- Initialize an editor draft from a reactive task using `structuredClone(toRaw(job))`. Creating an actual cloned task uses the server clone endpoint so private secrets survive; public DTOs never return archive/database/SMTP/OIDC passwords.
- Every task editor exposes an optional description. Lists use it as searchable secondary text, and the detail view shows the full saved value.
- The built-in system task uses the same editor and version view, but its format remains encrypted 7z. The import dialog uploads a local archive and password, then reports that restart is required.
- Settings storage view persists immediate/manual cleanup for successful local archives, shows actual temporary usage and retained archive size, and supports individual/bulk cleanup through authenticated APIs.
- The task editor exposes 7z algorithm, thread count, and dictionary size alongside the compression level. Older task DTOs may omit these fields, so initialize them from the shared schema's defaults before editing. Keep 7z-only controls hidden for ZIP and tar.gz.
- Directory task editors expose the optional file-change watcher and its debounce interval. Older task DTOs may omit `watch`; initialize its defaults before editing. Task details show the authenticated overview's live watcher state or error. The editor also picks the watch mode (whole directory vs. only new/modified files). The task list has a per-directory-task watch switch that PATCHes only `{watch:{enabled}}`, keeping mode and debounce; turning it off is allowed while the source is missing, like pausing.
- Task tags are edited as chips (Enter or comma adds, Backspace removes, suggestions come from existing tags). The task list shows tag chips, filters by a tag select or by clicking a chip, and includes tags in search. New directory tasks can switch to batch mode: the source becomes a parent folder, its subfolders are listed with checkboxes (folders already covered by a task are disabled), and saving posts to `/api/jobs/batch`.
- Batch mode seeds the tag list with the parent folder's name so the created tasks land in one group. The suggestion is only filled when the tag list is empty, and is replaced (never duplicated) when the user edits the parent path; a tag the user typed is never overwritten.
- The task list groups rows by `标签` / `类型` / `源父目录`, or stays flat. Filtering (`match`) runs before bucketing, so group counts follow the filtered set. Tag mode buckets by a job's first tag and collects untagged jobs in a trailing `未分组` group (the built-in system task is untagged, so tag grouping always shows that bucket); type mode keeps directory → file → vaultwarden → newapi → system order, and `typeLabels`/`typeOrder` must be extended whenever `jobSchema.type` gains a member or `Record<Job['type'], string>` fails to compile; source mode groups by the source's parent directory. Group headers show the label, count and failure count — never the page title or a repeat of the column headers.
- A non-empty search forces every group open, because a hit inside a collapsed group would otherwise be invisible; the persisted collapse state is left untouched and reapplies when the search clears. Collapse state and the chosen mode live in `backup-job-groups:<mode>` and `backup-jobs-group-mode`; every `localStorage` access is wrapped in `try/catch` and a throwing or corrupt store degrades to "nothing collapsed" rather than breaking rendering.
- "Collapse all" is disabled only when every group is already collapsed, and "Expand all" only when nothing is collapsed (`allCollapsed` vs `anyCollapsed`). Inverting these makes the everyday action unreachable — an earlier revision wired `!allCollapsed` onto collapse-all and the button shipped disabled. Cover both buttons in a browser check, not just in unit tests.
- Empty password fields preserve credentials. Task editor validates with shared schema and selects the relevant tab for missing fields. Hidden tabs must not block native form submission.
- Runs filtering passes `jobId`, `status`, `limit`, and `offset` to the server. Counts and pages reflect the same filters; reject stale responses.
- All Vaultwarden database modes remain available: SQLite, PostgreSQL, MySQL/MariaDB. Switching mode sets its normal port and exposes connection/TLS fields.
- Tool and connection failures are visible; unavailable integrations never display fake success/progress.
- Assets/fonts are local. Lucide icons are named by button labels/tooltips. Table overflow stays inside `.table-wrap`; modal content scrolls without losing commands.
- `JobsView` intentionally re-declares the two one-line `sourcePath(job)` / `typeLabel(type)` helpers instead of importing them from `App.vue`: exporting them would force a `<script>` restructure in a file another workstream owns. Keep this duplication limited to genuinely trivial pure helpers.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Setup passwords differ | Show error and keep setup form |
| API session expires | Clear CSRF/authentication and show login |
| Missing source/name/remote/password | Show validation message and relevant editor tab |
| rclone config/tools unavailable | Display actual error/status and retry/import controls |
| rclone rejects the config or remote path | Show localized copy via `friendlyError()`; keep the raw message in a `title`; offer a retry or an import shortcut |
| A directory read fails in PathPicker | Show exactly one error panel; do not also render a "no subdirectories" state |
| Topbar account menu actions collide with existing button names | Use distinct labels (empty-state shortcut is `前往导入配置`, not `导入 rclone 配置`) so role-based strict locators stay unambiguous |
| Save fails | Preserve editor values and display the API error |
| SMTP fails after backup succeeds | Show successful backup and failed notification separately |
| Source directory becomes unavailable | Show error and retry the requested directory; keep parent/root navigation usable |
| Search has no matches / directory has no entries | Show distinct no-match / empty-directory states |
| Last page disappears on refresh | Reload the last valid page, with counts and controls updated |

## 5. Good / Base / Bad Cases

- Good: task creation, secret-preserving edit, execution, verified version download, and login all work using real APIs.
- Base: a new installation has setup and meaningful empty task/history/storage states.
- Bad: a Vue proxy causes clone failure, hidden required controls prevent Save, or terminal polling stops before email/cleanup status updates.

## 6. Tests Required

Run `npm run check`, `npm run build`, `npm run check:layout`, and `npm run check:browser`. The browser scripts require installed Chromium and real rclone/7-Zip tools. They use isolated temporary state and local alias destinations, checks setup/config import/pickers/editor/execution/download/settings/login, and writes desktop/mobile/light/dark screenshots under `.artifacts/screenshots/` and `.artifacts/layout/`. File-browser assertions cover search before pagination, empty states, page shrink, missing-directory retry, stale directory/root responses, search responses arriving during the debounce delay, and both source-prefill actions. Freeze the browser clock for debounce race checks so assertions do not depend on network speed. Do not populate the user's real installation with fixtures.

`npm run check:layout` is the assertion-based acceptance gate: seven pages × four widths (1440/768/390/360) × two themes. Preserve one h1, fixed shell context, sticky 48px header outside the workspace, 208/44px desktop rail, 216/56px workspace inset, 8px radius scale, 1600px centred main, contained structures/controls/scrollers, no document overflow or legacy layout classes, accessible brand/navigation, borderless transparent stats with 24px icons, top-aligned 1.6fr:1fr desktop content columns, narrow stacking, sticky table headers and a genuinely scrolled settings page. Compact presentation replaces obsolete wide spacing assertions: main title 18–20px, main inset 12–16px at tested content widths, panel headings 40–48px and desktop controls 32–36px. Inspect actual screenshots and measure useful complete rows; screenshot counts alone cannot pass the gate.

Every overview viewport/theme must render a nonzero site preview with visible title, first hostname, repository labels and real linked task labels, plus all-sites navigation. Use the same eight sites' preexisting name/domain/tag/job values before/after; the old UI had no repositories/notes. Each final standard row adds two repositories and a short note. At 1440×900 require at least six complete rows with maximum standard height 104px; at 390×844 and 360×780 require at least three with maximum height 156px. Long/many-link exceptions may grow. Production guards must throw when site names/hostnames/repositories/job labels are hidden or row padding is increased, then pass after faults are removed. Never skip guards for zero rows or replace assertions with diagnostic prints.

Also run `node scripts/ui-radius-audit.mjs`; it scans `web/src/**/*.{vue,css}` and must report zero violations.

The sign-out assertion opens the account menu first (`getByRole('button', {name: '账号菜单 admin'})`) because sign-out now lives inside it. Menu entries must keep the native `button` role: adding `role="menuitem"` makes `getByRole('button', …)` stop matching and breaks the flow.

Running several console checks concurrently on one machine starves rclone detection and surfaces as a false "import button stays disabled" timeout. Confirm node/Chrome process counts have dropped before treating that failure as a regression.

## 7. Wrong vs Correct

Wrong: a page that renders a toolbar, table or form block as a direct child of `.main-content` instead of inside a `.panel`.

Correct: every content block is `<section class="panel">` with `panel-heading` and `panel-body`; only the page `<h1>`, the stats band, notices, pagination, the settings tab rail and the `content-grid` wrapper sit outside a panel.

Wrong: `.panel { overflow: hidden }` to clip the rounded corners, which hides a toolbar that overflows instead of revealing it.

Correct: clip only the first and last child radii and let `.table-wrap` own horizontal scrolling, then assert both the wrapper fits and no control leaves the viewport.

Wrong: a global `.panel + .panel { margin-top }` that also pushes the second column of a `.content-grid` down 20px.

Correct: reset `margin-top` on `.content-grid > *` and assert both columns share one top edge.

Wrong: fixing horizontal overflow by zeroing or hiding a primary information cell, leaving only status/actions, or claiming density through clipping useful site/task labels.

Correct: shared `.site-row` uses real grid/flex tracks with nonzero primary widths, title/first-hostname on one identity line, natural secondary wrapping and visible linked task labels. Assert nonzero row count and useful labels on every viewport/theme, with full accessible values for intentional ellipsis.

Wrong: hiding the wordmark with `display: none` on narrow screens while the brand `<img>` has `alt=""`, leaving the home link with no accessible name.

Correct: give the brand anchor an explicit `aria-label` and assert it on every breakpoint.

Wrong: `structuredClone(job)` where job is a Vue proxy, client-only status filtering over one server page, or polling only while status is running.

Correct: clone `toRaw(job)`, request filtered server pagination, and keep polling while notification/cleanup is pending.

Wrong: retry with the last successful path, or invalidate a request only after the search debounce timer runs.

Correct: retain the pending target for retry and invalidate immediately on input, so older responses cannot overwrite newer intent.

Wrong: render an error panel and an "empty directory" block for the same failed request, or pass a server/rclone message straight to the user.

Correct: reset the entry list on failure, show one localized error panel with a retry, and keep the raw text in a tooltip.

Wrong: hide sidebar labels with `display: none` during collapse, or let collapse rules leak below the 901px desktop breakpoint.

Correct: transition `opacity` + `max-width`, and scope collapse to `min-width: 901px`, with the `max-width: 900px` drawer owning horizontal motion.

Wrong: two controls with the same accessible name (for example an empty-state shortcut reusing the form's submit label).

Correct: give the shortcut its own label so strict role locators stay unambiguous.

## Site inventory UI

### 1. Scope / Trigger

Apply to `#sites`, site editing/filtering, reverse job associations, and independent resource loading. Site metadata must show the exact saved domain → job mapping without altering job execution.

### 2. Signatures

- `SiteInput` derives from shared `siteSchema`; `Site` adds `id`, `createdAt`, `updatedAt`. The arrays are `string[]`; do not let untyped JS transforms reduce them to `any`.
- `SitesView` receives `{sites,jobs,loaded,jobsLoaded,loading,error,errorDetail?,busyId}` and emits `create|edit|remove|openJob|reload`.
- `SiteEditor` receives `{site?,jobs,jobsLoaded,sites,save}` where `save(id,input) -> Promise<Site>` is App-owned. It emits `saved(site)|close`.
- App owns site APIs, request epochs, editor/delete state and the authoritative site list. Reverse job detail derives associated sites from this same list.

### 3. Contracts

- Navigation includes `sites` in both `Page` and the registry, with the single shell h1 `站点管理`. Content remains inside existing panels with the radius scale and mobile drawer.
- `SiteRow` is shared by the site list and overview preview. Its identity line shows the saved name plus only the first saved address's hostname, using shared `siteDomainHostname` for display and `siteDomainLink` for the complete safe href (including port/path/query/fragment). All saved addresses/order remain editable; invalid legacy values render as plain nonlinks. Use `noopener noreferrer` for new tabs. Address links are transparent navigation text, distinct from filled classification tags.
- Show actual repository labels with bundled GitHub/CNB/Gitee/GitCode marks, a nonempty one-line plain-text notes preview, tags and real linked job names/types/latest states. Multiple same-provider links retain distinct accessible names and full targets; no provider network requests or runtime favicon dependency. Full notes are accessible in the editor. Standard rows use natural layout, not fixed-height clipping; long/many-link content can grow.
- Site search covers name/domain/tag/repository URL/notes; site tags remain independent of job tags. Linked/unlinked counts and filtering use saved `backupJobIds`, even when job details are unavailable. Editor uses shared metadata limits/defaults, retains failed drafts and preserves omitted versus explicit-clear semantics.
- Overview keeps its existing title, four metric meanings, current execution, runtime environment and recent runs. Only its job preview becomes `站点列表`, showing up to six sites in saved order, total count, all-sites navigation and a create-site empty action. Normal task operations remain accessible. Render independently successful site/job data while overview fails or is pending; unavailable summaries must not invent zero/idle states. Latest attempt does not certify whole-site recoverability.
- Load sites and jobs independently of overview/runs. A rejected sibling request must not suppress the site request. `loaded` distinguishes a successfully empty inventory from a list never read; `jobsLoaded` distinguishes unresolved details from deletion. Keep the refresh guard active until all independent loads settle, and do not let another request's success clear a failure notice.
- Authentication boot waits for `/auth/status` and installs CSRF, then starts the resource refresh without awaiting it. Never keep `authLoading` true while dashboard resources load: a held `/overview` request must still allow the authenticated shell and independently loaded sites/jobs to render.
- A failed initial job read shows error/retry rather than an empty-success list. Overview activity derives from its successfully read summary, independently of `/jobs`. Preserve last-good content after refresh failures with a visible error/stale notice and retry, including silent overview polls and previously empty site inventories; only a successful read clears that resource's stale state.
- Drop stale site responses with request epochs. Clone form values once on mount; polling must not replace a draft or close it when its saved site disappears. Warn and retain the draft. A failed save also retains values.
- Validate the entire submitted site with shared `siteSchema`; show field messages and a useful Chinese explanation for `SITE_JOB_NOT_FOUND`/`SITE_NOT_FOUND`. Raw failures belong in tooltips. A missing selected ID can be explicitly removed only after a successful job-list read; failed reads never silently clear associations.
- Job deletion refreshes the site projection explicitly. Automatic unlink does not change site `updatedAt`, so timestamps cannot establish relation freshness.
- Deleting a site confirms that only metadata/links are removed and jobs/history/archives remain. Clicking a linked job opens existing job detail/version UI; clicking a reverse site chip opens its editor on `#sites`.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Site read fails | Error + retry; no empty-success inventory |
| Overview/jobs read fails but sites succeed | Saved sites remain visible; unknown task details show a pending state, preserving the saved count/IDs |
| Job disappears during editing | Keep the draft; show actionable missing-link copy and an explicit removal action |
| Site disappears during editing | Keep the draft and warn; do not recreate it silently |
| Invalid domain/tag or save failure | Shared field validation/API error; entered values remain |
| No search/tag matches | Separate no-match state and clear-filter action |

### 5. Good / Base / Bad Cases

- Good: two sites share a task, list it under both, and job detail lists both sites. Unlinking one leaves the other intact.
- Base: a saved site can start without addresses/tasks, and an installation with no sites shows the create shortcut after loading succeeds.
- Bad: `/overview` rejects before `/sites` is attempted, so the UI claims there are no sites; or `/jobs` fails and existing links are called deleted.

### 6. Tests Required

`check:browser` exercises real site CRUD/shared links, name/domain/tag/repository-only/notes-only filtering, exact full href with hostname-only display, all editor addresses, literal multiline remarks, same-provider repository distinction, forward/reverse navigation, retries, polling/failed-save draft preservation, safe unlink/delete, persistence and independent failed/pending overview/job requests. Keep intentional HTTP failures scoped in console-error handling; do not suppress unrelated browser errors.

The layout matrix has **seven pages × four widths × two themes = 56 asserted renders**, plus existing supplements and density evidence. Populate the eight standard sites and shared tasks through authenticated APIs; assert site/hostname/repository/job visibility and complete-row density. Reuse production guards for name/hostname/repository/job visibility and oversized-padding fault injections. Retain shell/containment/scroll/radius checks and inspect desktop/mobile/light/dark screenshots.

### 7. Wrong vs Correct

Wrong: `Promise.all([overview,jobs,runs]).then(loadSites)`, treating `jobs=[]` after a failed fetch as deletion, or replacing a mounted editor's draft whenever sites refresh.

Correct: independently load each resource with honest success/error flags, preserve saved association IDs, and keep the editor's mounted draft separate from refreshed authoritative records.

## Single-file editor and task cloning

### 1. Scope / Trigger

Apply to job creation/type selection, source pickers, file management and ordinary-task clone actions. App remains the mutation owner.

### 2. Signatures

- Job type and initial-type unions include `file`; type order is directory → file → Vaultwarden → newapi → system.
- File-manager `createJob(path,'file')` opens the single-file editor with the exact path prefilled.
- File-mode PathPicker browses directories and confirms one regular file; remote/directory modes retain their existing behavior.
- App calls `POST /jobs/:id/clone` and opens the returned public paused Job for editing after refreshing jobs/sites.

### 3. Contracts

- Single-file editors label the input `源文件`, offer `浏览源文件`/`选择此文件`, and keep manual/scheduled archive/retention/destination settings. Hide directory batch/watch/incremental/exclusion controls and normalize file exclusions to `[]` before client schema parsing. The API is authoritative for file type/path safety.
- System backup-content help renders only for `type === 'system'`. Directory/file editors must never inherit it through a fallback `else` branch; browser assertions cover the file editor and a copied directory editor.
- Browsing an existing file starts at its parent, preserving drive-root separators on Windows, never requests `/sources?path=<file>`, and preselects only once if that directory listing confirms the file. Every subsequent read clears selection so removed or navigated-away files cannot remain confirmable. Show selected filename and mutually exclusive loading/error/empty states.
- `复制任务` is available for ordinary jobs in list/detail, with pending submission protection. Clone on the server rather than repost a public DTO; preserve configured-secret flags and allow saving without re-entering unchanged secrets. The returned clone is paused and has no copied runtime history. Keep schedule/watch configuration inert until enable.
- Hide system clone actions. A failed clone request shows its actual error without a phantom row or editor. A successful clone refreshes both jobs and sites so reverse associations reflect the transaction. Editing or deleting a clone does not modify the original.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| File source missing locally | Explain the source-file requirement on the basic tab |
| Picker has no selected regular file / read in flight or failed | Disable file confirmation |
| File source rejected by server | Keep editor values and surface the error |
| Clone request fails | Show error; job count and authoritative list remain unchanged |
| System clone rejected | Explain that the fixed system task cannot be copied |
| Clone has configured secrets but empty password inputs | Save preserves the server-side values |

### 5. Good / Base / Bad Cases

- Good: choose a file in the real picker, save, manually run it, and inspect the completed backup; copy an encrypted task, edit the paused copy without entering a password and retain its site links.
- Base: a zero-byte file is valid, a file without a watcher shows no directory controls, and a system row has no clone action.
- Bad: browsing the file as a directory, carrying stale selection across navigation, or cloning the redacted DTO and losing its secrets.

### 6. Tests Required

The real browser gate must exercise file prefill/browse/navigation/selection, file save and manual execution, clone success/default pause, saving the copy without secret re-entry and an injected clone failure with unchanged job count. Server tests establish actual file extraction and private-secret preservation. Keep intentional HTTP-error exemptions scoped to the specific injected request.

### 7. Wrong vs Correct

Wrong: `POST /jobs` with `structuredClone(toRaw(publicJob))`, or pass an existing filename as the directory listing path.

Correct: call the server clone endpoint, and keep file browsing-directory and selected-file values separate.
