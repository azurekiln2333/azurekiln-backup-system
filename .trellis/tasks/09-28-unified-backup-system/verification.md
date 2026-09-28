# Verification Evidence

## Runtime and Scope

Node v24.15.0 on Windows. Real test tools: rclone v1.75.1, 7-Zip 26.03, Windows tar, native SQLite. All integration fixtures use isolated temporary state and local alias remotes. Real app state is fresh/uninitialized; no example tasks are seeded.

## Completed Checks

- `npm run check`: Vue/TypeScript check passes.
- `npm run build`: Vite production build passes into `web/dist`; Express static serving exercised by browser check.
- `npm test`: final integrated gate passed 35/35, zero skips/failures/cancellations (~75 seconds). Includes final retention retry and download disconnect/shutdown/changed-object regression tests.
- `npm run check:browser`: passed 25 screenshots, zero browser errors, 2 real encrypted backups, 3 SMTP messages, actual archive download and cleanup.
- Viewports: 1440x1000, 390x844, 360x800, 768x1024. Light/dark and mobile navigation checked. Screenshots are in `.artifacts/screenshots/`, with machine-readable `verification.json`.
- Browser workflow covers setup, rclone import/remotes/connection test, source and destination browsing/mkdir, SMTP form submission/test, encrypted directory task, secret-preserving edit, schedules, all Vaultwarden editor DB modes, live SQLite task, distinct AB/BC targets, execution detail, download, version listing, status filter, logout/login.
- API tests verify persistent sessions, CSRF/origin rules, setup token/exposed setup protection, source paths/symlinks, secret-key recovery, actual local SMTP, and mock OIDC signatures/state/nonce/PKCE/subject/replay.
- Executor/integration tests verify live WAL, extraction and wrong-password rejection for 7z/ZIP, successful immediate cleanup, independent mail failure, retention ownership, queue/cancel/restart, failed staging bounds, quota reservations/monitor, native rclone config encryption/import rollback, exclusions and database export/TLS command contracts.

## Review Fixes

Snapshot WAL mode, rclone serialization/import validation, successful plaintext/archival cleanup before email, interrupted plaintext recovery, settled notification states, concurrent download reservations, sampled exporter quota, destination-edit retention identity, database option termination, conservative MariaDB TLS enforcement, native rclone encryption and credential rollback, portable exclusion validation, missing-source pause, actual active-task controls, hidden form validation, filtered pagination, pruned download controls, mobile tables and modal-toast placement.

Final review issues also resolved: idempotent deletion of missing completion markers, bounded downloads of changed remote objects, signal propagation on HTTP disconnect, abort/await transfers on shutdown, and ENOENT-tolerant concurrent staging enumeration. Browser integration was rerun after these fixes and passed with zero errors.

## External Limits

Docker is unavailable locally; image not built. Live PostgreSQL/MySQL servers, actual cloud storage, and the deployed AzureKiln OAuth2 provider are not connected. Their configuration/command/protocol contracts are implemented and covered locally; live deployment and recovery validation remain required before removing the existing backup container. Disk quota checks are sampled, allowing a bounded interval of write overshoot.

## Local Preview

Detached `npm run dev` launcher started at `http://127.0.0.1:5173`, API port3148. `GET /api/auth/status` confirms uninitialized and unauthenticated. Runtime logs are in `.artifacts/logs/`; selected ports are in `.artifacts/dev.json`. Git staging/commits and task archive auto-commits were not requested.
