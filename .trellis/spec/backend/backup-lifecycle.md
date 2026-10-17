# Backup Runtime Contracts

## 1. Scope / Trigger

Apply to changes in `server/`, `shared/contracts.mjs`, deployment settings, and backup adapters. The directory and Vaultwarden workflows share the same persisted task, serial queue, archive, destination, and notification contracts.

## 2. Signatures

- `createApp(options?)` is async and returns `{app,store,config,backupService,rclone,scheduler,close}`. Direct CLI execution listens; imports do not listen.
- `createBackupService({store,config,rclone})` provides `enqueue(jobId,trigger)`, `isJobActive(jobId)`, `cancel(runId)`, `shutdown()`, `getArchives(jobId)`, `prepareDownload(jobId,runId,destinationId,{signal}={})`, `health()`, `storage()`.
- `createRcloneService({config,getSettings,saveSettings})` reads decrypted private settings and persists generated configuration passwords through `saveSettings`.
- `createStore(config)` uses native Node SQLite; public reads sanitize secrets, private reads require `{includeSecrets:true}`.
- `GET /api/sources?path=&limit=&offset=&search=` lists allowed roots or one directory for FileManagerView and PathPicker; it requires an administrator session.

## 3. Contracts

- `DATA_DIR` persists state, the independent `secret.key`, private rclone config, and bounded `tmp/`. It must never overlap `SOURCE_ROOTS`.
- `SOURCE_ROOTS` accepts a JSON string array or OS-delimited absolute paths. Sources are constrained to these roots, including database TLS assets.
- Source listings return `{roots,path,parent,entries,total}`. With no path, `path` and `parent` are null and entries represent configured roots. Directory entries contain `{name,path,isDirectory,size,modifiedAt}`; directory size is null and timestamps are ISO strings. Symbolic links and non-regular files are excluded; entries removed or made unreadable during metadata lookup may be skipped.
- Source query `limit` is optional (1–200), `offset` defaults to 0 (0–1000000), and `search` is at most 200 characters. Validate even for root listings. Directory search is case-insensitive and runs before sorting/pagination; directories sort first, then names. Omit `limit` to retain the full listing consumed by PathPicker. `total` counts filtered directory entries before metadata-race skips.
- Source parent navigation stops at the nearest configured root. Use path containment (`isWithin`) rather than appending a separator to root strings; filesystem roots already end in a separator. Overlapping configured roots choose the longest matching root.
- Credentials are sealed with AES-256-GCM. Empty secret updates preserve existing values; DTOs expose configured flags. Logs, HTTP errors, and email use redaction.
- Runs have `queued|running|succeeded|failed|cancelled|interrupted` status, separate phase/progress, target verification results, `cleanupStatus` and `notificationStatus`.
- Plaintext preparation is removed after archive validation. Successful archives follow the persisted immediate/manual cleanup policy; manual copies stay in task/run-owned temporary directories until explicitly cleared. Startup scrubs plaintext from interrupted preparation. Failed validated archives may be retained under expiry/latest-per-task/quota policy. Manually retained successful archives count toward the temporary limit but are not evicted by housekeeping.
- A 250 ms stage monitor cancels owned export/compression work that exceeds the global temporary quota, including download reservations. This is sampled enforcement, so one write interval can exceed the configured cap.
- Destination retention identifies the task, destination ID, remote, and owned directory prefix. Editing a destination does not authorize deleting older locations.
- Task descriptions are optional, trimmed, at most 500 characters, and default to an empty string when older stored tasks are read.
- Task `tags` are up to 10 trimmed labels (1–32 chars, no comma/newline), deduplicated case-insensitively keeping the first spelling; stored tasks without tags read as `[]`.
- `POST /api/jobs/batch {parentPath, folders, nameTemplate, template}` creates one directory task per child folder: `sourcePath = parentPath/<folder>`, name from `nameTemplate` (must contain `{folder}`), and each template destination path gets `/<folder>` appended. Folder names are single path segments. Every task is validated (including `SOURCE_ROOTS`, existence, encryption password) and checked against existing directory tasks with the same source (409) before any is saved, so a batch is all-or-nothing. At most 100 folders.
- The fixed `system-config` task is created disabled, cannot be deleted or converted, and requires a destination and password before execution. Its archive is always encrypted 7z and contains an online state snapshot, the active key and rclone config, and available deployment files.
- System import verifies the encrypted archive, file hashes, SQLite integrity, and key marker before staging. Startup applies it with a journal and preserves prior files for rollback. Imported archive metadata is reconciled against remote completion records before the version is exposed.
- Retention deletion is idempotent for missing objects; real authentication/network errors remain failures. A retry can remove the archive after its completion marker was already deleted.
- SQLite online backup uses the native backup API, then switches only the completed snapshot to DELETE journal mode and validates integrity. PostgreSQL uses custom-format pg_dump; MariaDB uses transactional dumps and `--` before the database name.
- Internal tar payloads preserve metadata. Encrypted 7z uses AES-256 and header encryption; ZIP uses AES-256. Verify archive before upload, then size and supported hashes before publishing a completion manifest.
- Per-task 7z settings accept LZMA2 or LZMA, 1-8 explicit threads or automatic, and a restricted dictionary size of 8-256 MiB or automatic. Automatic settings retain 1 thread and a 32 MiB dictionary at levels 7-9; other levels use 7z defaults. Never interpolate arbitrary method or dictionary strings into tool arguments. ZIP and tar.gz do not consume 7z method/thread/dictionary options.
- Download admission serializes size checks/reservations, verifies downloaded bytes, and releases storage on completion/error.
- Downloads check remote size, enforce rclone's hard transfer limit, and monitor actual bytes. HTTP disconnect supplies an abort signal; shutdown aborts and awaits active transfers before releasing storage.
- Exclusions accept literal paths plus `*`/`?` wildcards. Reject extended glob syntax so preflight and tar do not disagree about files that can be skipped.
- Enabled directory tasks may opt into recursive source watching with a 1–300 second debounce. Watch events use the same exclusions and enqueue full runs with trigger `watch`. Preserve events received during an active run for one subsequent run. Watch only paths revalidated within `SOURCE_ROOTS`; report errors in authenticated overview data and retry attachment after source outages. Stop watchers on pause, deletion, and shutdown. Vaultwarden and system tasks cannot enable watching.
- `watch.mode` is `full` (default; watch runs archive the whole directory) or `incremental`. Incremental tasks persist a per-task baseline snapshot (`watch_baselines`: relative path → `[size, mtimeMs]` or `['link', target]`, keyed to `sourcePath`). The watcher captures it on first attach with `ensureWatchBaseline` (insert-only, drops paths touched during capture, holds watch flushes until done); an existing baseline triggers one check run for offline changes. Only `trigger: 'watch'` runs diff against it: they archive `incremental.<stamp>.tar` (new/modified files via a NUL-separated `tar --null -T` list) plus `changes.<stamp>.json` (added/modified/deleted), name the archive `<file>.incremental.<ext>`, and record `backupKind`/`changes` on the run and `backupKind` in `complete.json`. No new/modified files → succeed without an archive, targets, or email; deletions stay pending in the baseline. Manual/scheduled runs stay full. The baseline is replaced only after every destination verifies. Leaving incremental mode or changing the source deletes it; pausing keeps it.
- Retention: `keepLast`/`days` select retained full versions; incremental versions are pruned only when older than the oldest retained full version and outside `days`. Without full runs, incremental versions accumulate.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Source traversal/symlink escape or source/state overlap | Reject; never traverse outside allowed roots |
| Unauthenticated source browse / invalid query / missing source / file supplied as directory | Return 401 / 400 / 404 / 400, respectively |
| Missing archive password for encryption | Reject task save/preflight |
| Invalid schedule or unavailable selected remote | Return validation error; do not queue a broken task |
| Database export or archive verification fails | Fail run; remove sensitive preparation; preserve older verified remote versions |
| Upload/hash verification fails | Fail run or retry within configured bounds; never mark complete |
| Email or retention fails after verified upload | Keep backup successful; record independent warning/status |
| Service restarts during a run | Mark interrupted; settle notification state; scrub sensitive staging |
| Temporary quota exceeded | Abort owned operation, fail with storage error, clean sensitive files |

## 5. Good / Base / Bad Cases

- Good: A maps to AB/path-a and B maps to BC/path-b; both persist and verify independently.
- Base: SQLite with missing optional `config.json`/RSA/attachments/Sends succeeds with recorded skips.
- Bad: Remote export writes unbounded bytes, plaintext survives restart, or a mail error prevents successful cleanup.

## 6. Tests Required

Run `npm test`. `tests/api.test.mjs` covers setup/session/CSRF/OIDC/secrets/source boundaries, storage policy/cleanup routes, plus listing metadata, search-before-pagination, no-limit picker compatibility, query validation, and nearest-root parent navigation. `tests/executor.test.mjs` covers queue/cancel/recovery/retention/quota/exports/rclone import and retained successful archives. `tests/integration.test.mjs` uses real compression/rclone and local SMTP to verify extraction, wrong-password rejection, live SQLite WAL, and default immediate cleanup. Live cloud, PostgreSQL/MySQL servers, and the deployed OAuth provider need deployment verification beyond mocks/local aliases.

## 7. Wrong vs Correct

Wrong: copy live `db.sqlite3` without WAL, encrypt stored database passwords but log subprocess credentials, pass untrusted database names as flags, or delete successful staging only after email.

Correct: use online snapshot + integrity check; fixed executable argv with redaction and database option separator; remove successful staging independently before email; seal native rclone configuration credentials.
