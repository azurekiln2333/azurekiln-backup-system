# Implementation Plan

User authorizes: finish plan, implement UI and logic, use subagents as useful. No further database-choice question.

## Checklist

- [x] Inspect reference UI, OAuth provider, and upstream backup/restore.
- [x] Converge requirements and prepare PRD/design/interfaces.
- [x] Scaffold shared contracts/scripts and install dependencies.
- [x] Activate task; dispatch UI, API/auth/persistence, and backup/adapter agents.
- [x] Integrate complete real-data workflows and empty/error states.
- [x] Verify sessions/secrets/source boundaries/queue/SQLite WAL/encryption.
- [x] Verify real rclone local upload/cleanup and SMTP outcomes.
- [x] Add Linux deployment/config/recovery docs.
- [x] Run check/build/test and desktop/mobile browser workflows/screenshots.
- [x] Fix concrete regressions, record evidence, leave dev URL.

Final gates: check/build pass; 35 tests pass with zero skips; browser integration passes 25 screenshots with zero errors. Local preview: http://127.0.0.1:5173. Evidence and external live-test limits: verification.md. Implementation is ready for review; Git commit/archive remain pending user direction.

## Mounted File Browser Completion

- [x] Recover the original file-browser request and inspect existing partial implementation and checks.
- [ ] Correct requested-directory retry, stale search/navigation, root breadcrumbs, and shrinking-page behavior in FileManagerView.
- [ ] Check `/api/sources` parent containment, metadata, search/pagination validation, missing paths, and compatibility with PathPicker.
- [ ] Extend browser regressions for search, paging, navigation, retry, backup prefilling, and responsive layouts.
- [ ] Run type check, build, API/full tests, and browser verification; inspect screenshots.
- [ ] Record updated contracts, mounting guidance, and verification evidence.

Change boundary: FileManagerView owns navigation/listing state; app.mjs owns source listing and containment. Tests live in tests/api.test.mjs and scripts/check-browser.mjs; README/spec/task records describe the verified behavior. This follow-up excludes source write operations, remote browsing additions, unrelated cleanup, and Git staging/commits. Existing source-picker no-limit behavior must remain compatible.

## Successful Local Archive Policy Follow-up (2026-09-29)

- [x] Persist immediate/manual successful-archive cleanup, preserving immediate cleanup as the default.
- [x] Keep manually retained successful archives through housekeeping and restart while enforcing the temporary-space limit.
- [x] Provide authenticated storage usage/list and individual/bulk cleanup APIs.
- [x] Show policy, current temporary usage, retained archives, and cleanup actions in Settings.
- [x] Cover lifecycle, quota, API authorization, and desktop/mobile workflows.
- [x] Publish formal Simplified Chinese, English, and Traditional Chinese README files.

Change boundary: shared settings, backup lifecycle, storage API, Settings view, focused tests, and three README files. Existing failed-staging expiry and remote retention remain independent of successful local archive cleanup.

## Directory Change Watching Follow-up (2026-09-29)

- [x] Persist an opt-in watcher and 1–300 second debounce for directory tasks.
- [x] Recursively watch allowed sources, apply exclusions, merge bursts, and retain changes during active runs.
- [x] Refresh watchers on task changes and source recovery; show status in the authenticated task detail.
- [x] Cover real file events, queue overlap, exclusions, recovery, and API validation.
- [x] Complete full test/build/browser gates and record evidence.

Boundary: `server/watcher.mjs` owns file events; `server/app.mjs` owns task validation and API wiring; the existing backup queue owns execution. `JobEditor.vue` and `App.vue` expose configuration and status. No incremental transfer engine or Vaultwarden database watcher is added.

## Ownership

Root: package/lockfile, shared/, scripts/, Docker/config/docs and final integration. UI agent: web/. API agent: server/config.mjs, store.mjs, auth.mjs, app.mjs and tests/api.test.mjs. Executor agent: server/process.mjs, rclone.mjs, backup.mjs, scheduler.mjs and tests/executor.test.mjs. No agent overwrites another owner's files.

## Gates and Scope

Run npm run check, npm test, npm run build and browser checks. Use real tools/SMTP when available, and do not claim cloud/DB/OIDC deployment connectivity without evidence. Fixtures are isolated test data, never seeded application jobs. Preserve existing scaffold and reference repos. No live restoration, old-container removal, external publishing or unrelated Git staging/commits.
