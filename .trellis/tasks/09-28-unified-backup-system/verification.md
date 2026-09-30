# Verification Evidence

## Runtime and Scope

Node v24.15.0 on Windows. Real test tools: rclone v1.75.1, 7-Zip 26.03, Windows tar, native SQLite. All integration fixtures use isolated temporary state and local alias remotes. The local preview uses existing initialized state; no example tasks are seeded by the application.

## Completed Checks

- `npm run check`: Vue/TypeScript check passes.
- `npm run build`: Vite production build passes into `web/dist`; Express static serving exercised by browser check.
- `npm test`: final integrated gate passed 50/50, zero skips/failures/cancellations (~122 seconds). Includes local-archive cleanup, file watching, capacity protection, retention retry, and download disconnect/shutdown/changed-object regression tests.
- `npm run check:browser`: passed 42 screenshots, zero browser errors, 3 real encrypted backups including a watched change, actual archive download, manual local retention, storage usage, and UI cleanup.
- Viewports: 1440x1000, 390x844, 360x800, 768x1024. Light/dark and mobile navigation checked. Screenshots are in `.artifacts/screenshots/`, with machine-readable `verification.json`.
- Browser workflow covers setup, rclone import/remotes/connection test, source and destination browsing/mkdir, SMTP form submission/test, encrypted directory task, secret-preserving edit, schedules, all Vaultwarden editor DB modes, live SQLite task, distinct AB/BC targets, execution detail, download, version listing, status filter, manual archive policy, occupied-space display, local archive removal, and logout/login.
- API tests verify persistent sessions, CSRF/origin rules, setup token/exposed setup protection, source paths/symlinks, secret-key recovery, actual local SMTP, and mock OIDC signatures/state/nonce/PKCE/subject/replay.
- Executor/integration tests verify live WAL, extraction and wrong-password rejection for 7z/ZIP, default immediate cleanup, manual successful-archive retention across runs/restart, explicit cleanup, quota protection, independent mail failure, retention ownership, queue/cancel/restart, failed staging bounds, quota reservations/monitor, native rclone config encryption/import rollback, exclusions and database export/TLS command contracts.

## Review Fixes

Snapshot WAL mode, rclone serialization/import validation, successful plaintext cleanup and policy-based local archive handling before email, interrupted plaintext recovery, settled notification states, concurrent download reservations, sampled exporter quota, destination-edit retention identity, database option termination, conservative MariaDB TLS enforcement, native rclone encryption and credential rollback, portable exclusion validation, missing-source pause, actual active-task controls, hidden form validation, filtered pagination, pruned download controls, mobile tables and modal-toast placement.

Final review issues also resolved: idempotent deletion of missing completion markers, bounded downloads of changed remote objects, signal propagation on HTTP disconnect, abort/await transfers on shutdown, and ENOENT-tolerant concurrent staging enumeration. Browser integration was rerun after these fixes and passed with zero errors.

The successful local-archive policy defaults to immediate cleanup. Manual mode retains only the verified archive; housekeeping never evicts it to make space. Authenticated APIs report actual temporary usage and allow individual/bulk cleanup. The Settings view was checked at 1440, 390, and 360 pixels with an occupied retained archive. Three formal README variants cover deployment, operation, recovery, and the new policy.

## Directory Watching Follow-up (2026-09-29)

- `npm test`: 50/50 pass, zero skips; includes recursive file events, burst coalescing, events during active runs, exclusions, pause, source recovery, and authenticated API validation.
- The watcher handle identity guard and required active-job contract were checked with focused watcher/API tests after the full suite.
- `npm run check` and `npm run build`: pass after the final editor spacing change.
- `npm run check:browser`: 42 screenshots, zero browser errors, and three real encrypted backups. The third was triggered by writing a file into an enabled watched directory; its remote target was verified. Desktop and 360-pixel watcher editor screenshots were inspected for control overlap.
- Network filesystems, container mount event delivery, and deployed cloud storage remain environment-dependent; scheduled execution is recommended alongside watching for critical data.

## External Limits

Docker is unavailable locally; image not built. Live PostgreSQL/MySQL servers, actual cloud storage, and the deployed AzureKiln OAuth2 provider are not connected. Their configuration/command/protocol contracts are implemented and covered locally; live deployment and recovery validation remain required before removing the existing backup container. Disk quota checks are sampled, allowing a bounded interval of write overshoot.

## Local Preview

Detached `npm run dev` launcher is available at `http://127.0.0.1:5173`, API port 16323. `GET /api/auth/status` confirms the local state is initialized and currently unauthenticated. Runtime logs are in `.artifacts/logs/`; selected ports are in `.artifacts/dev.json`. Git staging/commits and task archive auto-commits were not requested.
