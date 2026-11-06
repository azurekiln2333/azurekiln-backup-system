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
- `type: 'newapi'` archives a new-api deployment without program source or images. `validateNewApiJob` resolves every path inside `SOURCE_ROOTS` (data dir, `.env`, compose, service unit, reverse-proxy config, plugins, logs), defaults the SQLite file to `<dataDir>/one-api.db` and requires it to stay inside `dataDir` (`NEWAPI_SQLITE_OUTSIDE_DATA_DIR`) so the archive stays self-describing, requires single-line database host/name/username for MySQL/PostgreSQL, and forces `format: '7z'` with `encrypted: true` (`NEWAPI_ARCHIVE_REQUIRED`) because the archive carries `.env` credentials. `newapi.database.password` and `newapi.logDatabase.password` are the only new sealed secrets; public DTOs expose `passwordSet` only.
- `prepareNewApi` writes `db/main.*` (and `db/log.*` when `logDbType !== 'same'`), `config/env` (mandatory, 0600) plus optional `config/compose.yaml`, `config/service.unit` and `proxy/*`, `data/` (excluding `new-api-body-cache`, `new-api-body-cache/**`, `*.db-journal`, `*.db-wal`, `*.db-shm`, and any copied database file), and optional `logs/` and `plugins/`. ClickHouse log databases are never exported automatically: the run records a warning and `RESTORE.md` carries the manual command. `includeLogTable: false` adds `--ignore-table=<db>.logs` and marks the archive.
- The new-api `manifest.json` (`kind: 'azurekiln-newapi-backup'`) records main/log engines and database names (never DSNs or passwords), per-table row counts plus a content digest queried from the live database, export bytes/hashes, per-file hashes, `appVersion`, `excluded` and `warnings`. `recoveryPoint` is the main-database snapshot instant (also stored as `mainDatabase.snapshotAt`), not manifest write time. `RESTORE.md` is generated from that manifest so instructions always match the archived scope: it omits the row-count table and prints explicit table self-checks for server dumps, and emits concrete log-database restore commands.
- Table digests order rows by the declared primary key, fall back to `rowid` for ordinary tables, and hash a value-sorted projection for `WITHOUT ROWID` tables so a digest is never null. A null digest is a failure, not a silent pass.
- `includeLogTable: false` is rejected (`NEWAPI_LOG_TABLE_REQUIRED`) whenever the main or log database is SQLite: a SQLite snapshot is one file and cannot drop a single table. The manifest's `logsIncluded`, the scope warnings and the editor checkbox therefore always agree, and only one logs warning is ever emitted.
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

Run `npm test`. `tests/api.test.mjs` covers setup/session/CSRF/OIDC/secrets/source boundaries, storage policy/cleanup routes, plus listing metadata, search-before-pagination, no-limit picker compatibility, query validation, and nearest-root parent navigation. `tests/executor.test.mjs` covers queue/cancel/recovery/retention/quota/exports/rclone import and retained successful archives. `tests/newapi.test.mjs` covers the newapi contract block, path sandboxing and forced encryption, the SQLite-file-inside-dataDir rule, MySQL/PostgreSQL credential-free argv construction, manifest field accuracy, recovery-point provenance, secret redaction, exclusion rules, digest non-nullness (including `WITHOUT ROWID`), non-contradictory scope warnings, restore-guide accuracy, and a round trip that packs the payload into a **real encrypted 7z**, extracts it into an empty directory (wrong password must fail), and compares every table's row count and content digest. `tests/integration.test.mjs` uses real compression/rclone and local SMTP to verify extraction, wrong-password rejection, live SQLite WAL, and default immediate cleanup. Live cloud, PostgreSQL/MySQL servers, ClickHouse, and the deployed OAuth provider need deployment verification beyond mocks/local aliases.

## 7. Wrong vs Correct

Wrong: copy live `db.sqlite3` without WAL, encrypt stored database passwords but log subprocess credentials, pass untrusted database names as flags, or delete successful staging only after email.

Correct: use online snapshot + integrity check; fixed executable argv with redaction and database option separator; remove successful staging independently before email; seal native rclone configuration credentials.

## Site inventory and job associations

### 1. Scope / Trigger

Apply when changing site CRUD, shared site validation, job deletion or system-state migration/restore. A site is administrator-maintained inventory; its associations do not execute or certify a backup.

### 2. Signatures

- `siteSchema`, `tagListSchema`, `siteDomainSchema`, `normalizeSiteDomain(input)`, `siteDomainLink(value) -> {href,label}` live in `shared/contracts.mjs`.
- Repository helpers share the same boundary: `normalizeSiteRepository(input) -> string`, `siteRepositorySchema`, `siteRepositoryProvider(value) -> 'github'|'cnb'|'gitee'|'gitcode'|null`, and `siteRepositoryLink(value) -> {href,provider,label}` where `provider` has that nullable union.
- Store: `listSites()`, `getSite(id)`, `saveSite(input,id?)`, `deleteSite(id)`.
- Authenticated routes: `GET /api/sites`, `POST /api/sites` (201), `GET/PATCH /api/sites/:id` (200), `DELETE /api/sites/:id` (204).
- SQLite: `sites(id PRIMARY KEY,data)`; `site_jobs(site_id REFERENCES sites ON DELETE CASCADE,job_id REFERENCES jobs ON DELETE CASCADE,PRIMARY KEY(site_id,job_id))`; index `site_jobs_job(job_id)`. Do not make `job_id` unique.

### 3. Contracts

- Input is `{name,domains,tags,repositoryUrls,notes,backupJobIds}`. Name is trimmed, required, at most 100 characters. Arrays default to `[]`; domains, repositories and links may be empty. Notes default to `''`. Output adds server-owned `id`, `createdAt`, `updatedAt`, with no embedded private jobs or secrets. Both public `siteView` and saved JSON metadata must explicitly include new metadata; shared schema defaults alone do not persist it.
- Domains accept up to 20 entries, each at most 2048 characters before and after normalization. Bare hosts default to HTTPS; URL parsing normalizes host/default port while preserving path/query/fragment semantics. Deduplicate identical canonical hrefs, preserving first order. Validation performs no network requests.
- Repositories accept up to 20 HTTP(S) browser URLs of at most 2048 characters on any host; provider recognition never gates validity. `SITE_REPOSITORY_HOSTS` is an exact-host icon lookup for github.com, cnb.cool, gitee.com, gitcode.com and hub.gitcode.com only. Other valid hosts, including GitLab, self-hosted repositories and known-name lookalikes, produce `provider:null` and remain valid navigation links. Bare addresses default to HTTPS; explicit HTTP, submitted alias, case-sensitive path/query/fragment and `.git` survive normalization. Require at least owner/group plus repository path, reject credentials/control whitespace/backslashes/nondefault ports, deduplicate canonical hrefs in order and never probe providers. Use normalization/schema validation to determine validity; a null provider alone does not mean invalid input.
- Notes are trimmed plain text of at most 500 characters; preserve internal newlines. Omitted PATCH fields preserve prior data, `repositoryUrls:[]` and `notes:''` clear independently, and invalid input rejects the whole metadata/link write. Legacy records missing either field read with its empty default without a startup bulk rewrite.
- Tags share the existing 10 × 32-character rules, with independent site/job values. Job IDs are bounded to 200 entries of 1–100 characters and deduplicated in request order. Typed JS transforms must expose `string[]` output to TypeScript consumers.
- `site_jobs` is the sole association source. Site JSON holds metadata/timestamps only. `backupJobIds` is projected on every read; never copy it into job JSON.
- `saveSite` merges a PATCH into the previous record before schema defaults apply, then validates all referenced jobs and writes metadata/replacement links in one store-owned transaction. Omitted arrays preserve values, supplied arrays replace, and `[]` clears.
- Site saves/deletes never change jobs, schedules, watcher settings, credentials, runs or archives, nor refresh scheduler/watchers. Automatic unlink after job deletion changes only relation rows and leaves site `updatedAt` unchanged.
- Startup creates the tables additively. Whole-database system snapshots include inventory automatically; an older restored database without site tables gains empty tables. Do not require site tables in the old-archive validator.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unauthenticated request / mutation without CSRF or with foreign Origin | Existing 401 / 403 authentication boundary |
| Missing site on GET/PATCH/DELETE | 404 `SITE_NOT_FOUND` |
| Invalid field, unsupported URL scheme, URL credentials or oversized canonical href | 400 `VALIDATION_FAILED`, with field issues |
| Valid repository URL on an unrecognized host | Accept on create/PATCH; persist/read the canonical href with no provider requirement |
| Any unknown job ID | 400 `SITE_JOB_NOT_FOUND`; prior metadata, timestamp and links unchanged |
| Delete linked job | Existing active/system-job protections still apply; successful deletion cascades links from every site only |

### 5. Good / Base / Bad Cases

- Good: site A links DB + files; site B links the same DB. Unlinking A retains B and both jobs. A GitLab/self-hosted repository URL persists alongside a recognized GitHub URL.
- Base: a named site without addresses/jobs is valid; an old installation initially lists no sites.
- Bad: one invalid job ID commits a new name but deletes old links, a site delete deletes backup data, a restore drops the relation table, or an absent provider icon blocks a valid repository URL.

### 6. Tests Required

`tests/sites.test.mjs` must exercise real HTTP/SQLite CRUD, both many-to-many directions, merge/replace/clear semantics, authoritative reads after rejected writes, auth/CSRF, public payloads, site/job deletion safety, reopen/legacy migration, current and old restore, and empty `PRAGMA foreign_key_check`. With real tools, export an actual encrypted system backup, download it, stage/import the exact archive, and compare saved inventory and relations. Snapshot-only fixtures do not establish archive export/decryption evidence.

Repository regressions must create/edit/read the reported GitLab URL and a self-hosted URL, preserve full canonical targets/order/deduplication, and assert null providers for unknown and known-name lookalike hosts. Retain independent malformed/unsafe URL and count/length rejection checks; tests must not depend on repository-host availability.

### 7. Wrong vs Correct

Wrong: store `backupJobIds` in both site JSON and a join table, use `UNIQUE(job_id)`, apply partial-schema defaults before merging a PATCH, or reject a repository because `siteRepositoryProvider(value) === null`.

Correct: project IDs from the composite-key relation, and merge → validate → transactionally replace metadata and links. A failed write leaves the prior authoritative record intact. Validate repository navigation with `siteRepositorySchema`; a valid projection such as `{href:'https://gitlab.com/team/repo',provider:null,label:'team/repo'}` needs no provider integration.

## Single-file backups and paused job cloning

### 1. Scope / Trigger

Apply to job-type changes, source validation, archive preparation and clone APIs. Both workflows reuse the existing SQLite job model and backup lifecycle.

### 2. Signatures

- `jobSchema.type` includes `file`; its existing `sourcePath` identifies exactly one regular file.
- `resolveSourcePath(config,input,{allowMissing?,directory?,file?})` adds a regular-file requirement with `file:true`.
- `POST /api/jobs/:id/clone` accepts an optional strict `{name?:string}` body and returns 201 with a public Job.
- `store.cloneJob(sourceId,validatedInput)` writes the paused copy and its site relations in one transaction.

### 3. Contracts

- File save/execution enforce existing allowed-root, component-symlink, realpath and state-overlap boundaries. Zero-byte files are valid. Directory jobs still reject files; file jobs reject directories/special files. Missing-source exceptions apply only to existing pause flows and paused cloning, not ordinary creation/execution.
- File preparation revalidates the source and creates a one-member `file.<stamp>.tar` under the run-owned payload. The member uses its basename, with option-safe argv; never archive the parent as `.`. Compression/encryption, quota monitor, cancellation, archive/upload verification, destination retention and cleanup remain shared. Directory-only watch/incremental features are unavailable, and file exclusions normalize to `[]`.
- Cloning uses the private source and schema projection, retaining archive/database secrets, configuration and destination IDs. IDs are job-scoped for retention. Give the copy a fresh identity/timestamps, bounded name (100 UTF-16 code units), `enabled:false`, `lastRun:null` and `nextRunAt:null`. Copy no runs, logs, queue state, baseline or remote completion ownership.
- Copy site associations atomically and preserve existing site metadata/timestamps. Select sites with `WHERE job_id=?`; `siteJobIds(siteId)` is the opposite lookup and cannot serve this operation. Enforce the site's 200-link limit before insertion; a failed relation write rolls back the new job too.
- Retain schedule/watch configuration under the disabled job, allowing an active original to be cloned. Do not refresh scheduler/watchers or enqueue on clone: scheduler refresh would modify original runtime timestamps. Existing timers/watchers remain unchanged. Public DTOs never contain plaintext secret values.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Extant non-file supplied to a file task | 400 `SOURCE_NOT_FILE` |
| Missing required source / forbidden source / source symlink | Existing 404 `SOURCE_PATH_MISSING` / 403 `SOURCE_PATH_FORBIDDEN` / 403 `SOURCE_SYMLINK_FORBIDDEN` |
| File task enables watching | 400 `WATCH_DIRECTORY_ONLY` |
| Unknown clone source | 404 `JOB_NOT_FOUND` |
| Fixed system-config clone | 409 `SYSTEM_JOB_CLONE_FORBIDDEN` |
| Invalid clone name/body or unexpected config overrides | 400 `VALIDATION_FAILED` |
| Any linked site is at its association limit | 409 `SITE_JOB_LIMIT_REACHED`; no new job or links |
| Clone without authenticated session/CSRF | Existing 401/403 boundary |

### 5. Good / Base / Bad Cases

- Good: cloning a shared encrypted task preserves private secrets and adds the paused copy to every linked site, with independent history.
- Base: an empty ordinary file backs up and extracts as the same empty basename; a paused clone may retain a temporarily missing allowed source.
- Bad: packing a file's parent leaks siblings, reposting a public Job drops passwords, or cloning refreshes and changes the original schedule state.

### 6. Tests Required

`tests/file-clone.test.mjs` checks HTTP/SQLite type/path/auth/clone boundaries, private secret retention and public redaction, fresh paused identity/history/baseline, shared site relations/limits/transaction rollback, original independence and bounded Unicode naming. Real encrypted archive extraction must prove exact filename and bytes, absence of siblings, wrong-password failure and cleanup. Browser checks exercise real file selection/create/run and server-side cloning. Run full suites sequentially with local real tools.

### 7. Wrong vs Correct

Wrong: `POST /jobs` with a copied public DTO, or `tar -C dirname(source) .` for a file task.

Correct: clone the private configuration on the server, atomically save fresh paused job/link rows, and tar only the option-safe selected basename.

## Server nodes and definition synchronization

### 1. Scope / Trigger

Apply to node administration, scoped receiver authentication, definition transport and node persistence. Path mapping and API-token issuance are separate integrations.

### 2. Signatures

- `createNodeService({store,config,validateJob,backupService,scheduler,watcher,tokens?,mapPath?,fetchImpl?,timeoutMs?})` provides `requireSyncToken`, `status`, `test`, `sync`, `receive`, `isSyncing` and async `close`.
- Administrator-session routes: `GET/POST /api/nodes`, `GET/PATCH/DELETE /api/nodes/:id`, `POST /api/nodes/:id/test` and `/sync`.
- Bearer receiver routes: `GET /api/sync/status`, `PUT /api/sync/jobs` with `{jobs:[{syncKey,job}]}` (at most 500, unique keys).
- SQLite adds `nodes(id PRIMARY KEY,data)` and `synced_jobs(sync_key PRIMARY KEY,job_id UNIQUE REFERENCES jobs ON DELETE CASCADE)`.

### 3. Contracts

- Node fields are `{name,baseUrl,token?,enabled,pathRules,jobOverrides}`; rule arrays and override dictionaries replace as whole collections. Empty/omitted token updates preserve the sealed value. Public reads expose `tokenSet`, timestamps and the last summary; never plaintext tokens. Validate HTTP(S) URLs without credentials/query/fragment and retain explicit private-node addresses.
- Summary: `{at,status,total,synced,unmapped,failed,jobs}`. Per-job statuses are `synced|unmapped|failed`; summary statuses are `succeeded|partial|failed`.
- Send definitions only: remove passwords, runtime/history and system jobs. Exclude imported jobs to prevent echo loops. Stable `syncKey` updates the same receiver-local ID and preserves its history and credentials; missing local credentials pause the definition. Reject incoming secret fields and active-job updates.
- Call external `mapPath(path,rules)` for source/dependent/absolute-destination paths. Explicit source overrides win. Any unresolved absolute path skips the whole task; a missing mapper conservatively leaves such tasks unmapped. Inject contract fixtures in backend tests so they do not depend on another lane's uncommitted mapper implementation.
- Receiver tokens require explicit `sync` scope independently of session cookies. Use an injected authenticator or the planned API-token table reader; absent tokens fail closed. This workstream does not issue tokens.
- Transport uses manual redirects, a default 15-second timeout, 1 MiB request/response limits and sanitized failures. Shutdown aborts requests and waits for pushes before closing storage.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing administrator session / mutation without CSRF | Existing 401 / 403 boundary |
| Invalid Bearer token / insufficient scope | 401 `TOKEN_INVALID` / 403 `TOKEN_SCOPE_FORBIDDEN` |
| Missing node / required token absent | 404 `NODE_NOT_FOUND` / 400 `NODE_TOKEN_REQUIRED` |
| Disabled node / concurrent push or delete | 409 `NODE_DISABLED` / `NODE_SYNC_BUSY` |
| Unresolved absolute path | `unmapped` result; no definition sent for that task |
| Redirect / timeout / invalid response | Sanitized 502 `NODE_REDIRECT_FORBIDDEN` / `NODE_REQUEST_TIMEOUT` / `NODE_RESPONSE_INVALID` |
| Invalid individual definition | Failed per-job result; other valid jobs can synchronize |

### 5. Good / Base / Bad Cases

- Good: one controller task reaches two different node-local paths; a second push updates each existing remote task.
- Base: an encrypted definition arrives paused until local credentials are configured.
- Bad: copy controller passwords, accept cookies as sync-token authorization, echo imported jobs back, or push unresolved absolute paths.

### 6. Tests Required

`tests/nodes.test.mjs` exercises real HTTP/SQLite CRUD, session/CSRF and scoped Bearer boundaries, token sealing/redaction, reopen/idempotence, per-node mapping and explicit overrides, nested TLS files, whole-task skips, secret/history preservation, independent invalid results and bounded sanitized transport. Verify the exact staged tree without mapper/notification/frontend WIP; run the repository test, type-check and build commands.

### 7. Wrong vs Correct

Wrong: authorize receiver writes using a node's outbound token or save transported public DTOs as new jobs on every push.

Correct: require a receiver-local `sync` principal, project a secret-free definition and upsert through `store.saveSyncedJob(syncKey,validatedInput)` with receiver-local credentials.

## Deployment Compose filenames and discovery

### 1. Scope / Trigger

Apply when changing deployment manifests, runtime discovery or release bundles. Keep filenames consistent so system backups capture the selected deployment.

### 2. Signatures

- `loadConfig(env = process.env, cwd = process.cwd())` returns `systemComposePath: string`.
- `scripts/prepare-release.mjs` exports `BUNDLE_FILES`, including `docker-compose.yml` and `docker-compose.build.yml`.
- Local build: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

### 3. Contracts

- Ship `docker-compose.yml` and `docker-compose.build.yml`. The base manifest mounts `./docker-compose.yml:/system-config/docker-compose.yml:ro` and sets `SYSTEM_COMPOSE_FILE=/system-config/docker-compose.yml`.
- A nonempty `SYSTEM_COMPOSE_FILE` resolves against `cwd` and wins even if absent. Otherwise select the first existing file in `['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']` under `cwd`; return `''` if none exist. Discovery does not create deployment files.
- Keep serialized backup members `deployment-compose.yaml` and new-api `config/compose.yaml`, plus restore output `restored-compose.yaml`, unchanged. Deployment naming must not break existing archive readers.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Explicit Compose path, including a missing file | Use its resolved path; do not fall back |
| Multiple default filenames exist | Select the first existing candidate in the documented order |
| Only a legacy filename exists / no candidate exists | Select the legacy path / return `''` |
| Release lacks either `.yml` manifest | Packaging/CI fails instead of publishing an incomplete bundle |

### 5. Good / Base / Bad Cases

- Good: explicit `SYSTEM_COMPOSE_FILE=deployment/custom.yml` overrides both defaults.
- Base: an existing `.yaml` deployment remains discoverable after upgrading.
- Bad: rename the host file but leave its container mount, release list or CI check pointing at the old name.

### 6. Tests Required

`tests/config.test.mjs` asserts each default filename, ordered precedence with multiple candidates, absent defaults and explicit relative/absolute paths. `tests/ci-scripts.test.mjs` checks mounts, build command and required package members; `tests/release.test.mjs` verifies exact bundle membership and rejects old root manifest names. Inspect a release generated from the checkout as well as synthetic fixtures.

### 7. Wrong vs Correct

Wrong: choose only `path.join(cwd, 'docker-compose.yml')`, silently dropping old deployments, or globally replace archive-member suffixes.

Correct: use ordered discovery and retain archive contracts: `['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map(file => path.join(cwd, file)).find(existsSync) || ''`, with explicit environment configuration taking precedence.
