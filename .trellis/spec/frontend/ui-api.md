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

## 3. Contracts

- Schemas/defaults come from `shared/contracts.mjs`; `web/src/types.ts` extends DTOs with timestamps, configured flags, and runtime results.
- CRUD uses server responses as authoritative state. Never seed example jobs in the application.
- Navigation is hash-based: overview/jobs/files/runs/storage/settings. Theme persists in `backup-theme`.
- File management is a read-only view of allowed source roots. A single root opens automatically on initial load; explicit navigation back to mounted roots must stay there. Search is case-insensitive within the entire current directory, with 100-entry pages. Source visibility comes from container mounts and SOURCE_ROOTS, not host filesystem discovery.
- File navigation tracks the requested directory separately from successful results so retry replays the failed request. Search changes invalidate older requests before the debounce delay; stale responses cannot change the displayed directory. Refresh clamps pages when directory contents shrink. Breadcrumb containment handles trailing root separators and chooses the nearest configured root.
- Clone an existing reactive task using `structuredClone(toRaw(job))`. The API never returns archive/database/SMTP/OIDC passwords.
- Every task editor exposes an optional description. Lists use it as searchable secondary text, and the detail view shows the full saved value.
- The built-in system task uses the same editor and version view, but its format remains encrypted 7z. The import dialog uploads a local archive and password, then reports that restart is required.
- Settings storage view persists immediate/manual cleanup for successful local archives, shows actual temporary usage and retained archive size, and supports individual/bulk cleanup through authenticated APIs.
- The task editor exposes 7z algorithm, thread count, and dictionary size alongside the compression level. Older task DTOs may omit these fields, so initialize them from the shared schema's defaults before editing. Keep 7z-only controls hidden for ZIP and tar.gz.
- Directory task editors expose the optional file-change watcher and its debounce interval. Older task DTOs may omit `watch`; initialize its defaults before editing. Task details show the authenticated overview's live watcher state or error. The editor also picks the watch mode (whole directory vs. only new/modified files). The task list has a per-directory-task watch switch that PATCHes only `{watch:{enabled}}`, keeping mode and debounce; turning it off is allowed while the source is missing, like pausing.
- Task tags are edited as chips (Enter or comma adds, Backspace removes, suggestions come from existing tags). The task list shows tag chips, filters by a tag select or by clicking a chip, and includes tags in search. New directory tasks can switch to batch mode: the source becomes a parent folder, its subfolders are listed with checkboxes (folders already covered by a task are disabled), and saving posts to `/api/jobs/batch`.
- Empty password fields preserve credentials. Task editor validates with shared schema and selects the relevant tab for missing fields. Hidden tabs must not block native form submission.
- Runs filtering passes `jobId`, `status`, `limit`, and `offset` to the server. Counts and pages reflect the same filters; reject stale responses.
- All Vaultwarden database modes remain available: SQLite, PostgreSQL, MySQL/MariaDB. Switching mode sets its normal port and exposes connection/TLS fields.
- Tool and connection failures are visible; unavailable integrations never display fake success/progress.
- Assets/fonts are local. Lucide icons are named by button labels/tooltips. Table overflow stays inside `.table-wrap`; modal content scrolls without losing commands.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Setup passwords differ | Show error and keep setup form |
| API session expires | Clear CSRF/authentication and show login |
| Missing source/name/remote/password | Show validation message and relevant editor tab |
| rclone config/tools unavailable | Display actual error/status and retry/import controls |
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

## 7. Wrong vs Correct

Wrong: `structuredClone(job)` where job is a Vue proxy, client-only status filtering over one server page, or polling only while status is running.

Correct: clone `toRaw(job)`, request filtered server pagination, and keep polling while notification/cleanup is pending.

Wrong: retry with the last successful path, or invalidate a request only after the search debounce timer runs.

Correct: retain the pending target for retry and invalidate immediately on input, so older responses cannot overwrite newer intent.
