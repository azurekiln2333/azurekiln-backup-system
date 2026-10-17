# Console and API Contracts

## 1. Scope / Trigger

Apply to `web/`, shared task schemas, and API changes that affect user workflows. This is a working single-administrator console with real API data and empty/error states.

## 2. Signatures

- `api<T>(path)` reads `/api` and parses the standard JSON/error response.
- `write<T>(path,body?,method?)` attaches the current CSRF token.
- `JobEditor` accepts `{job?,initialType?,initialSourcePath?}` and emits `saved(job)` or `close`. Only new jobs use the initial source path.
- `FileManagerView` emits `createJob(path)` from the current directory or a directory row; App opens a directory JobEditor with that source prefilled.
- `PathPicker` accepts `{kind,remote?,initialPath?}` and emits an absolute source or relative remote path.
- `RunDetail` accepts `{id}` and polls until execution, cleanup, and notification settle.
- `nav.ts` exports `navItems` (the page registry), `Page` (derived from it), `isPage(value)`, and `pageTitle(page)`.
- `errors.ts` exports `friendlyError(cause, fallback?)` and `rawError(cause)` for user-facing error copy.
- `AccountMenu` accepts `{username?, theme}` and emits `toggle-theme` / `logout`; it owns the only sign-out entry point.
- `JobsView` accepts `{jobs,overview?,busyId,activeJob,canRunJob}` and emits `create|open|run|edit|remove|toggle|toggleWatch`. It owns the list's search, enable filter, tag filter, grouping mode and collapse state; it never calls the API itself, so App stays the sole owner of data and mutations.
- `web/src/jobGroups.ts` exports `groupJobs(jobs,{mode,match})`, `readCollapsed/writeCollapsed(storage,mode)`, `readGroupMode/writeGroupMode(storage)`, `dirname` and `groupModeLabels`. `mode` is `none|tag|type|source`.

## 3. Contracts

- Schemas/defaults come from `shared/contracts.mjs`; `web/src/types.ts` extends DTOs with timestamps, configured flags, and runtime results.
- CRUD uses server responses as authoritative state. Never seed example jobs in the application.
- Navigation is hash-based: overview/jobs/files/runs/storage/settings. Theme persists in `backup-theme`.
- `web/src/nav.ts` is the single page registry: adding a page is one row there, which supplies the sidebar entry, the `Page` type, the hash validator, the `<h1>` title, and the optional task-count badge (`badge: 'jobs'`). The page body still needs its own `v-else-if` branch in `App.vue`.
- Each page renders its title exactly once, as `.main-content h1`. The topbar shows only the fixed `管理控制台` label and must not repeat the page name. No page-eyebrow/English sub-heading above `h1`.
- Sidebar collapse persists in `backup-sidebar-collapsed` (`'1'`/`'0'`, try/catch — storage may throw). Collapse only applies at `min-width: 851px`; below that the sidebar is a `transform` drawer keyed off `.sidebar.open` and collapse rules are neutralised.
- Collapse animates through `--sidebar-motion` (200ms) on `width`, `margin-left`, and label `opacity`+`max-width`. Never toggle `display` on labels mid-transition, and keep `overflow-x: hidden` on the rail so the transition never widens the document. The collapsed rail keeps icons plus `title` tooltips.
- Border radius comes only from `--radius-sm|md|lg|pill` in `style.css`. `--radius` is `0.5rem` (8px), matching new-api's 0.5 tier; containers never exceed `--radius-lg`, and only badges, switches, avatars, and dots use `--radius-pill`. `node scripts/ui-radius-audit.mjs` fails the build on any raw corner value.
- Account identity and sign-out live in the topbar `AccountMenu`, not in the sidebar. The sidebar has no workspace label, no administrator card, and no session footer; the content area has no footer. Overview's `运行环境` panel carries no `管理员会话` line.
- User-facing errors go through `friendlyError()`: low-level text (rclone `specify an existing rclone configuration file`, HTTP `not found`) is classified into actionable Chinese copy, and the original string is exposed only as a `title` tooltip via `rawError()`. An error panel and an empty-state block are mutually exclusive — never render both for the same failure.
- File management is a read-only view of allowed source roots. A single root opens automatically on initial load; explicit navigation back to mounted roots must stay there. Search is case-insensitive within the entire current directory, with 100-entry pages. Source visibility comes from container mounts and SOURCE_ROOTS, not host filesystem discovery.
- File navigation tracks the requested directory separately from successful results so retry replays the failed request. Search changes invalidate older requests before the debounce delay; stale responses cannot change the displayed directory. Refresh clamps pages when directory contents shrink. Breadcrumb containment handles trailing root separators and chooses the nearest configured root.
- Clone an existing reactive task using `structuredClone(toRaw(job))`. The API never returns archive/database/SMTP/OIDC passwords.
- Every task editor exposes an optional description. Lists use it as searchable secondary text, and the detail view shows the full saved value.
- The built-in system task uses the same editor and version view, but its format remains encrypted 7z. The import dialog uploads a local archive and password, then reports that restart is required.
- Settings storage view persists immediate/manual cleanup for successful local archives, shows actual temporary usage and retained archive size, and supports individual/bulk cleanup through authenticated APIs.
- The task editor exposes 7z algorithm, thread count, and dictionary size alongside the compression level. Older task DTOs may omit these fields, so initialize them from the shared schema's defaults before editing. Keep 7z-only controls hidden for ZIP and tar.gz.
- Directory task editors expose the optional file-change watcher and its debounce interval. Older task DTOs may omit `watch`; initialize its defaults before editing. Task details show the authenticated overview's live watcher state or error. The editor also picks the watch mode (whole directory vs. only new/modified files). The task list has a per-directory-task watch switch that PATCHes only `{watch:{enabled}}`, keeping mode and debounce; turning it off is allowed while the source is missing, like pausing.
- Task tags are edited as chips (Enter or comma adds, Backspace removes, suggestions come from existing tags). The task list shows tag chips, filters by a tag select or by clicking a chip, and includes tags in search. New directory tasks can switch to batch mode: the source becomes a parent folder, its subfolders are listed with checkboxes (folders already covered by a task are disabled), and saving posts to `/api/jobs/batch`.
- Batch mode seeds the tag list with the parent folder's name so the created tasks land in one group. The suggestion is only filled when the tag list is empty, and is replaced (never duplicated) when the user edits the parent path; a tag the user typed is never overwritten.
- The task list groups rows by `标签` / `类型` / `源父目录`, or stays flat. Filtering (`match`) runs before bucketing, so group counts follow the filtered set. Tag mode buckets by a job's first tag and collects untagged jobs in a trailing `未分组` group; type mode keeps directory → vaultwarden → system order; source mode groups by the source's parent directory. Group headers show the label, count and failure count — never the page title or a repeat of the column headers.
- A non-empty search forces every group open, because a hit inside a collapsed group would otherwise be invisible; the persisted collapse state is left untouched and reapplies when the search clears. Collapse state and the chosen mode live in `backup-job-groups:<mode>` and `backup-jobs-group-mode`; every `localStorage` access is wrapped in `try/catch` and a throwing or corrupt store degrades to "nothing collapsed" rather than breaking rendering.
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

Run `npm run check`, `npm run build`, and `npm run check:browser`. The browser script requires installed Chromium and real rclone/7-Zip tools. It uses isolated temporary state and local alias destinations, checks setup/config import/pickers/editor/execution/download/settings/login, and writes desktop/mobile/light/dark screenshots under `.artifacts/screenshots/`. File-browser assertions cover search before pagination, empty states, page shrink, missing-directory retry, stale directory/root responses, search responses arriving during the debounce delay, and both source-prefill actions. Freeze the browser clock for debounce race checks so assertions do not depend on network speed. Do not populate the user's real installation with fixtures.

Also run `node scripts/ui-radius-audit.mjs`; it scans `web/src/**/*.{vue,css}` and must report zero violations.

The sign-out assertion opens the account menu first (`getByRole('button', {name: '账号菜单 admin'})`) because sign-out now lives inside it. Menu entries must keep the native `button` role: adding `role="menuitem"` makes `getByRole('button', …)` stop matching and breaks the flow.

Running several console checks concurrently on one machine starves rclone detection and surfaces as a false "import button stays disabled" timeout. Confirm node/Chrome process counts have dropped before treating that failure as a regression.

## 7. Wrong vs Correct

Wrong: `structuredClone(job)` where job is a Vue proxy, client-only status filtering over one server page, or polling only while status is running.

Correct: clone `toRaw(job)`, request filtered server pagination, and keep polling while notification/cleanup is pending.

Wrong: retry with the last successful path, or invalidate a request only after the search debounce timer runs.

Correct: retain the pending target for retry and invalidate immediately on input, so older responses cannot overwrite newer intent.

Wrong: render an error panel and an "empty directory" block for the same failed request, or pass a server/rclone message straight to the user.

Correct: reset the entry list on failure, show one localized error panel with a retry, and keep the raw text in a tooltip.

Wrong: hide sidebar labels with `display: none` during collapse, or let collapse rules leak below the 851px drawer breakpoint.

Correct: transition `opacity` + `max-width`, and scope collapse to `min-width: 851px`.

Wrong: two controls with the same accessible name (for example an empty-state shortcut reusing the form's submit label).

Correct: give the shortcut its own label so strict role locators stay unambiguous.
