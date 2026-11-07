# Site deployment notes completion

Implemented and locally verified on November 7, 2026. Remote submission/CI results are appended after the authorized push and merge.

## Delivered behavior

- Site create/edit now records an ordered cloud-image list and the checkbox `该站点通过 Watchtower 自动拉取更新`. Images support registry names, tags/digests, trim and exact deduplication. Shared limits are 20 references of at most 1024 characters with no embedded whitespace/control characters.
- Both fields persist in site JSON, project on every read, survive restart and real encrypted system backup/restore, and default to empty/false on old records without rewriting them. PATCH omission preserves prior state; empty/false clear independently. Invalid metadata/links cannot partially save.
- The controls are deployment notes. Their saves do not access registries/Docker/Watchtower or change jobs, schedules, watcher state or history. Failed saves retain drafts.
- GitHub Actions and CNB already provide cloud verification and version-tag publication. Main/branch pushes verify only; a valid version tag is still required for image publication.

## Confirmed cloud failure repair

After the user's requested fast-forward merge of prior commits to remote main at `fa233a7`, GitHub run `42314406587` failed 27 tests because apt rclone 1.60.1 lacks `config encryption set`. Four integration cases had also skipped. See `research/ci-rclone-failure.md` for real log evidence.

One checksum-pinned Linux rclone 1.75.1 installer now serves GitHub verification, CNB's shared verifier and the Docker runtime image. It selects amd64/arm64, checks official pinned SHA-256 before extraction and checks the required command before installation. CI exports absolute paths and enables real-tool cases. The shared verifier's invalid digit-prefixed Bash variable expansion now uses `printenv`. Both lanes include the site browser gate sequentially. Application encryption and release triggers are unchanged.

## Files and ownership

- Site implementation: `shared/contracts.mjs`, `server/store.mjs`, `web/src/components/SiteEditor.vue`, `tests/sites.test.mjs`, `scripts/check-site-deployment.mjs`.
- Cloud/runtime provisioning: `.github/workflows/build-and-release.yml`, `Dockerfile`, `scripts/install-rclone.sh`, `scripts/ci-verify.sh`, `tests/ci-scripts.test.mjs`, `tests/rclone-installer.test.mjs`.
- New backend site/tool specs, backend index, frontend contract and this task's planning/review/research/completion files.
- Notification hunks in shared contracts/store and all other workers' node/notification/UI/README changes were excluded from the index and left intact. No force push, branch deletion or destructive checkout is needed.

## Verification evidence

The exact staged source tree was exported to `.artifacts/site-deployment-submission-bd551c9d` with dependencies/tools linked, excluding all unrelated WIP. Checks were sequential:

| Gate | Result |
| --- | --- |
| Full real-tool tests with `RUN_BACKUP_INTEGRATION=1` | 150 tests, 146 passed, 0 failed, 4 Windows skips |
| Site tests | 19 passed, including real encrypted system archive export/download/import |
| `npm run check` / `npm run build` | Passed |
| Focused site browser | 6 cases: 1440/390/360 × light/dark; all passed |
| Existing full browser | Passed, 65 screenshots, 4 real encrypted backups, download, SMTP, login, watcher flow |
| Existing layout | Passed, 7 pages × 4 widths × 2 themes, 56 page renders and 60 screenshots |
| Radius audit / scoped diff / shell syntax | Passed |
| Independent review | No remaining product defects or blocking CI finding; missing test-fixture destination fixed |

The four Windows skips are the socket/symlink platform checks and the two new POSIX installer rejection fixtures; Linux CI executes those installer tests. The focused browser also asserts only ordinary site writes, unchanged non-site tables/deployment files, and zero external requests/operational actions. Representative desktop/mobile/light/dark feature screenshots and existing site/layout screenshots were visually inspected.

Logs and screenshots are under the exported tree's `.artifacts/`; focused UI evidence also exists in the root `.artifacts/site-deployment/`. These ignored artifacts are not committed.

## Limits

Local execution used Windows tools. The new installer success path, Linux full run, actual runtime image, CNB pipeline and arm64 execution must have their own evidence; none is inferred from Windows validation. Subsequent GitHub run status is recorded after submission. A branch/main push does not publish a container image, and no production deployment or version-tag release is requested here.

## First submission and Linux follow-up

`0245c22` was pushed and fast-forward merged to both remote branches on November 7. GitHub main run `42322774496` proves rclone 1.75.1 installation and **150/150 Linux tests passed, zero skipped**, including both installer rejection cases. The original 27-test dependency failure is resolved.

Its browser step then exposed an existing synchronization race at `scripts/check-browser.mjs:602`: the source-picker heading is mounted before its asynchronous directory listing finishes, so immediately checking `isDisabled()` can run before preselection. Failure capture already shows the correct preselected filename after loading. The same assumption occurs on reopening. A scoped follow-up waits for the real confirmable state using the existing bounded poll, while retaining the original path/filename/confirm assertions. This changes only test synchronization and preserves the unrelated notification-script WIP. Subsequent run results are recorded below after verification.
