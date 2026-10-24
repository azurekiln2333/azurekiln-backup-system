# Local verification readiness

Inspected on 2026-10-24 before feature implementation.

- Node: `v24.15.0` (`D:/ProgramFiles/nodejs/node.exe`).
- Use `npm.cmd` for shell commands on this Windows host.
- Existing real-tool artifacts are available despite not being on PATH:
  - `.artifacts/tools/rclone-v1.75.1-windows-amd64/rclone.exe`
  - `.artifacts/tools/7zip/x64/7za.exe`
- Existing browser script auto-detects these artifact tools and uses `C:/Program Files/Google/Chrome/Application/chrome.exe`; that browser exists.
- `npm.cmd run check` passed against the pre-feature baseline.
- Pre-feature full `npm.cmd test` completed with absolute RCLONE_BINARY/SEVEN_ZIP_BINARY and `RUN_BACKUP_INTEGRATION=1`: 81 tests, 80 passed, 0 failed, 1 intentional Windows symlink skip, about 152 seconds. Do not start overlapping full/real-tool/browser suites. This is separate from the required post-feature suite.
- Current feature branch: `feat/site-management`, forked from `afe7eb0`, with pre-existing unrelated modifications preserved. The user's subsequent “推送上去啊” on 2026-10-24 authorizes the scoped commit and remote feature-branch push.

These observations establish test prerequisites, not feature completion or live-server PostgreSQL connectivity.

## Live coordination

The user requested the four existing Pi panes in Herdr. Verified all four are working in project workspace `w1H` on `feat/site-management`: `w1H:p4` owns shared/backend code, `w1H:p8` owns frontend code, `w1H:p6` owns tests/browser/layout scripts, and `w1H:p7` owns the three READMEs and independent acceptance review. The parent owns task/spec/evidence updates, integrated checks and the scoped commit. Workers share the worktree and must preserve each other's edits.

Inherited Herdr caller IDs point to a different workspace. Always use the verified explicit `w1H` pane IDs. Do not use `--current`, move panes or change focus.

## Post-verification revalidation and finish preflight

Revalidated the worktree after the commit-review request. All inspected feature source/test files predate the final frontend build (2026-10-23 23:17:51 UTC), browser verification (23:20:28 UTC), and layout screenshots (23:24–23:25 UTC). The branch and scoped/unrelated dirty paths remain as documented. No further product changes or unapproved Git mutations were made.

Read the actual finish helpers before scheduling bookkeeping: `task.py archive` supports `--no-commit` and restricts its auto-commit to the archived task paths; `add_session.py` supports `--no-commit` but its normal auto-commit stages the current developer's entire journal/index files. Those files already contain unrelated dirty changes in this worktree. After work-commit approval, use `add_session.py --no-commit` and inspect the exact session delta before any journal commit; do not bundle the pre-existing journal edits merely because the helper would stage the same files. No helper has been executed to archive or append this session while commit approval is outstanding.

Commit/push authorization has now arrived. Preserve the recorded verification results and unrelated dirty work while completing the scoped commit, task archive, session record and normal GitHub push.
