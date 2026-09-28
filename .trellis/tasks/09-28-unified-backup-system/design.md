# Technical Design

## Mounted File Browser Follow-up

Keep `/api/sources` as the authenticated read-only listing owner. The existing optional `limit`, `offset`, `search`, `total`, and entry metadata support FileManagerView; omission of pagination retains the existing PathPicker response behavior. Determine the nearest allowed parent root with path containment, including filesystem roots and overlapping configured roots. UI state must distinguish the requested location from the last successful listing, invalidate stale work when input changes, and retry the failed request. Clamp a refreshed page when files disappear. No backup execution or source mutation changes are needed.

## Structure

Node 24 ESM with Express, native node:sqlite, Vue 3/TypeScript/Vite, lucide-vue-next, Croner, Nodemailer and openid-client. Root owns package/config/deployment/shared contracts. web/ owns UI. server/config.mjs, store.mjs, auth.mjs, app.mjs own persistence/auth/API. server/process.mjs, rclone.mjs, backup.mjs, scheduler.mjs own tool execution and backup lifecycle. Interfaces are in research/contracts.md.

## Authentication and Persistence

DATA_DIR stores SQLite state and an independent AES-256-GCM key. Seal archive/DB/SMTP/OIDC/rclone passwords; sanitized DTOs omit secrets and expose passwordSet flags. Empty secret update fields retain prior values. Password hashing uses scrypt. Random sessions are persisted as hashes, carried in HttpOnly/SameSite cookies; authenticated writes require CSRF tokens. Setup is one-time and loopback-only unless SETUP_TOKEN or environment provisioned admin credentials authorize it. OAuth uses discovery, confidential client, state/nonce/S256 PKCE, verified ID Token, and exact issuer/sub binding.

## Queue and Source Preparation

Directory and Vaultwarden jobs share destinations/schedule/archive/retention/notification settings. Store each run, logs, target results, progress, notification and cleanup status separately. States: queued/running/succeeded/failed/cancelled/interrupted. Phases: queued/preflight/preparing/archiving/verifying_archive/uploading/verifying_remote/pruning/cleanup/completed. A serial background queue returns HTTP 202 immediately. Croner computes timezone-aware schedules with persisted nextRunAt. Startup marks stale runs interrupted without killing arbitrary stored PIDs.

Resolve source paths under configured SOURCE_ROOTS and reject escaping symlinks, source/staging recursion and traversal. Stage under DATA_DIR/tmp/<job>/<run>, outside source roots. Fixed executables and argv arrays only. Directory mode uses an inner tar to preserve metadata. Vaultwarden preserves db.<stamp>.sqlite3/.dump/.sql, config.<stamp>.json, rsakey.<stamp>.tar, attachments.<stamp>.tar and sends.<stamp>.tar. Database backup is mandatory; absent optional assets are recorded as skipped.

SQLite uses online backup plus integrity_check; test live WAL and deployment mount permissions, never use immutable mode for live data. PostgreSQL uses custom-format pg_dump with appropriate client version and protected credentials. MySQL/MariaDB uses a transaction-aware export and explicit TLS settings through protected client configuration. DB consistency does not establish one atomic snapshot with changing attachments; application-wide consistency requires a maintenance window. Environment/Compose files outside the data directory need a separate directory task.

## Archive, rclone and Cleanup

Use tar.gz when unencrypted; encrypted mode uses 7z/ZIP AES-256, with 7z header encryption. Require password, redact invocation logging, isolate child processes under the service user, and test the archive before upload. A selected remote must exist in discovered configuration; clients cannot provide arbitrary connection strings.

Import existing rclone config into a private writable persistent directory. Do not overwrite refreshed OAuth tokens automatically. Serialize shared-config operations; suppress interactive password prompts. Use structured metadata output and never return config credentials. Each uploaded version resides below destination/<job>/<run>; publish completion metadata after verification. Check size and comparable backend hashes where available and report checksum limitations explicitly. Record SHA-256 for future end-to-end verification.

Prune only recorded completed task-owned versions, keeping the minimum configured copies. Delete successful archive/plaintext staging before sending email. Failed staging is at most one attempt per task, subject to expiry/budget; preserve earlier remote versions. Email/retention warnings are independent from backup success. Download streams a verified archive through a temporary file and cleans it on completion/error.

## UI and Deployment

Working console or login/setup is the first screen. Navigation: overview/tasks/executions/storage/settings. Use main-site color/typography tokens, compact tables/forms, small-radius dialogs, real empty states and responsive navigation. Task editor contains conditional Vaultwarden fields, source/remote pickers, password, scheduling, retention and notifications. Detail shows logs/phases/targets/archives. Settings offer SMTP test, OIDC binding, tool health and temp policy.

Linux image bundles rclone, 7-Zip, sqlite3, PostgreSQL and MariaDB clients. Mount selected sources read-only and DATA_DIR persistently, with private rclone config writable. No Docker socket or host-wide source mount. HTTPS terminates at proxy. Windows currently has Node/npm but no backup binaries/Docker in PATH; verify with isolated local binaries or state the unverified deployment integration. Back up the independent secret key; historical archives need their original passwords.
