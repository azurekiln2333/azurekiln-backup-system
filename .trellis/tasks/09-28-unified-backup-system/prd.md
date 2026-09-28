# Unified Directory and Vaultwarden Backup System

## Goal

Provide one administrator console for directory and Vaultwarden backups, replacing the separate vaultwarden-backup container after recovery validation. Deliver the UI and working application logic together.

## Decisions and Evidence

- Initial repository contains Trellis tooling only; preserve existing scaffold.
- Branding: ../azurekiln-main-site/app/js/tailwind/tailwind.config.js, blue #005ab7, light gray #f7f9fb, Manrope/Inter, light/dark themes.
- OAuth: ../azurekiln-oauth2/server.js:1297 supports OIDC, RS256, and S256 PKCE for a confidential server-side client.
- User requests all upstream Vaultwarden database modes, configured in the task editor; no deployment database-choice question.
- User explicitly authorizes implementation after this plan, with subagents as useful. This overrides an additional planning confirmation gate.
- Baseline: single Linux container with source mounts and persistent state. Windows supports UI/API development; missing external backup tools are reported honestly.

## Requirements

- R1: One local administrator, initial setup, persistent sessions, optional OIDC binding to the same administrator; no public registration.
- R2: Directory task CRUD, source browser, exclusions, enabled/paused state, manual execution, schedules/timezone, independent remote/path destinations, and retention.
- R3: Import existing rclone config, list remotes, browse/create directories, test connectivity; real missing-tool/config/error states.
- R4: Vaultwarden mode: SQLite default, PostgreSQL, MySQL/MariaDB, configurable data/database/RSA/attachments/Sends paths and database connection/TLS options.
- R5: Actual SQLite online backup, pg_dump, or transactional MySQL/MariaDB export. Collect config.json, rsa_key*, attachments, sends when present. Database failure fails the task; optional missing assets are recorded as skipped.
- R6: One final archive per run, unencrypted tar.gz or AES-256 password-encrypted 7z/ZIP. Encrypt 7z filenames, preserve filesystem metadata with inner tar containers, and retain familiar Vaultwarden artifact names.
- R7: Upload with copy/copyto, verify remote result, and prune only recorded task-owned completed versions.
- R8: Delete archive/plaintext staging immediately after upload verification, independently of email. Bound failed staging to latest attempt per job, expiry, and global budget; retries may reuse the archive.
- R9: Durable history, phase/progress, logs, target results, cancellation, bounded retries, interrupted-run recovery; default serial execution.
- R10: Persisted SMTP settings, test email, per-task success/failure/start notifications; notification errors reported independently.
- R11: Complete overview, task editor, execution/detail, archive/download, storage, and settings workflows; no seeded demo data.
- R12: Encrypt secrets at rest with independent persistent key; mask API secrets, redact logs/email, restrict source roots, and use subprocess argv without shell interpolation.

## Acceptance Criteria

- AC1 (R1,R12): Setup/login/logout work; unauthorized and unbound OAuth users cannot access the console/API.
- AC2 (R2,R3): A->AB:path-a and B->BC:path-b persist independently across restart; source and remote pickers use real listings.
- AC3 (R4,R5): Editor exposes all DB modes. A live WAL SQLite fixture produces a valid self-contained snapshot. PostgreSQL/MySQL command/error coverage and live-test limitations are explicit.
- AC4 (R6): Real archives extract; encrypted archives reject wrong passwords and accept correct passwords.
- AC5 (R7,R8): Real rclone local-remote upload verifies and removes local staging; failure cannot remove earlier successful versions.
- AC6 (R9): Queue prevents overlap, cancellation stops owned work, restart marks interrupted work correctly.
- AC7 (R10): SMTP test works; mail failure neither changes backup success nor prevents local cleanup.
- AC8 (R11): Desktop/mobile workflows and screenshots show no overflow/overlap and usable empty/error states.
- AC9 (R12): No plaintext secrets in stored configuration/API/logs; reject traversal/symlink escapes.
- AC10: Build/check/tests pass; leave a usable dev URL and describe unverified external integrations.

## Mounted File Browser Follow-up (2026-09-28)

The user requested a file-management page that directly shows container-mounted directories, then asked to inspect its progress and continue. Resume this existing task's read-only source browser work.

- Show allowed mounted roots, directory/file names, type, file size, and modification time; retain source boundary and symlink restrictions.
- Support directory breadcrumbs, parent navigation, case-insensitive current-directory search, pagination, refresh, and useful loading/empty/error states.
- Opening or retrying a directory must target the requested location. Older requests must not replace newer navigation/search results; shrinking directory contents must not strand a user on an empty page.
- Create a directory backup with the selected source prefilled. Keep the existing source picker compatible.
- Verify API behavior and desktop/mobile browser workflows. Document how Compose mounts and SOURCE_ROOTS control visibility.
- No source upload/delete/rename or remote file manager is requested; source mounts remain read-only.

## Out of Scope

Multi-host agents, incremental deduplication, automatic in-place restore over live data, edits to reference repos, and removal of the old backup container. Include archive download/recovery instructions; container replacement follows deployment recovery testing.
