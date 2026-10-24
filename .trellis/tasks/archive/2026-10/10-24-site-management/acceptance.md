# Site-management acceptance evidence

Status: implementation and all six feature acceptance criteria passed on 2026-10-24. The user explicitly authorized commit and push with “推送上去啊”; scoped commit, archive and feature-branch publication are approved.

| Criterion | Required authoritative evidence | Current result |
| --- | --- | --- |
| AC1: navigation, CRUD, shell/error states | Real site APIs plus browser desktop/mobile flow and screenshot review | PASS: authenticated CRUD, desktop/mobile navigation, one h1, explicit load/error/retry/empty/no-match states |
| AC2: domains and visible linked tasks | Shared validation tests, saved/reloaded API data, populated browser/layout label assertions | PASS: canonical HTTP(S) URLs, safe fragments, normalization/limits, exact persisted values, visible name/domain/job labels across eight width/theme combinations |
| AC3: many-to-many and safe atomic updates | Two sites sharing a job; one site with several jobs; rejected invalid-link update leaves prior state intact | PASS: real HTTP + SQLite assertions for both directions, merge/replace/clear semantics, unchanged authoritative state after rejection |
| AC4: search/tags/reverse mapping | Real browser search and tag filtering; job detail shows current linked sites; editor failure preserves data | PASS: search/filter, forward job detail and reverse chip-to-editor navigation, polling and failed-save draft preservation |
| AC5: persistence/restore/deletion | Store reopen/old migration/current+old system restore, FK checks, actual task/history/archive preservation and no dangling associations | PASS: reopen, additive old-DB migration, current/old snapshot restores, real encrypted system export/download/staged import/restore, safe deletion and clean foreign keys |
| AC6: full integration and visual gates | Final npm test/check/build, sequential browser/layout (56 renders), radius audit, independent review, git diff check | PASS: 90 pass / 0 fail / 1 skip; type/build/browser/layout/radius/diff gates pass; independent Pi final review PASS AC1–AC6 |

## Baseline (not feature verification)

- Pre-feature type check passed on Node v24.15.0.
- Pre-feature full test run completed with real artifact tools: 81 tests, 80 passed, 0 failed, 1 intentional Windows symlink skip (about 152 seconds). This establishes the baseline, not feature acceptance.

## Final verification

- `npm.cmd test` with absolute artifact `RCLONE_BINARY`, `SEVEN_ZIP_BINARY` and `RUN_BACKUP_INTEGRATION=1`: **91 tests, 90 passed, 0 failed, 1 intentional Windows symlink skip**, 156789.1859 ms. Includes ten site cases, one exercising the actual encrypted system export → download → production staged import → restore pipeline.
- Final `npm.cmd run check`: exit 0. Final `npm.cmd run build`: exit 0, 1607 modules; build after the last refresh-guard/error-state fixes.
- `npm.cmd run check:browser`: exit 0, **57 screenshots**, `browserErrors: []`, three real encrypted backups, download, SMTP, watched change and login. Site coverage includes shared associations, CRUD, read retry, both navigation directions, search/tags, polling draft preservation, failed saves, safe unlink/delete, reload, and independent overview/job failures. Evidence: `.artifacts/screenshots/verification.json`.
- Sequential `npm.cmd run check:layout`: exit 0, **7 pages × 4 widths × 2 themes = 56 asserted renders**, 60 screenshots including supplements. Overview: 8/8 combinations, 22/22 rows with visible names. Populated sites: all eight width/theme combinations; the same production guard throws under separate hidden site/domain/job-label controls and passes when restored.
- `node scripts/ui-radius-audit.mjs`: pass. `git diff --check`: pass (only local LF/CRLF notices).
- Parent inspected actual screenshots: `desktop-sites`, `desktop-site-editor`, `sites-360`, `light-1440-sites`, `dark-360-sites`, `light-390-sites`. Site/domain/shared-job labels are readable; mobile content stays inside panels and the viewport; desktop and both themes preserve the existing shell.
- Independent review: Pi `w1H:p7`, final frozen-tree verdict **PASS AC1–AC6, no remaining blocker**, with evidence provenance in `research/pi-review.md`. Reported findings about independent loading, stale selected IDs, field errors and inferred array types were fixed before final verification.

Only task/spec/evidence documentation changed after these product checks. The workflow step 3.4 review is approved; publication will use the existing `feat/site-management` branch. Server deployment remains outside this task.

## Boundaries

- No production database/server connection or deployment is part of this site-inventory task.
- GitHub image publication and the known new-api/PostgreSQL export defects remain separate tracked work, not completed by site management.

## Work commit

`2dcc72be0d2414a37b901170a145278d09d873ad` — `feat(sites): add site inventory and shared backup job links`. The approved 30-file allowlist was checked against the exact staged paths. Unrelated work was excluded.
