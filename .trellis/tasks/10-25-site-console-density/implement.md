# Execution plan and four-Pi ownership

Status: implementation and AC1–AC8 acceptance complete on 2026-10-25; parent is finishing scoped Git publication and task bookkeeping. The subsequent user message requests immediate implementation and adds single-file backup and job cloning; see PRD amendment. PRD/design own selected contracts; research alternatives are historical.

## Verified workspace and ownership

HERDR_ENV=1. Inherited caller IDs refer to unrelated w24; never use --current/UI focus. Live inventory confirms project workspace w1H and four idle Pi agents at the project cwd:

| Pane | Owned files and responsibility |
| --- | --- |
| w1H:p4 | shared/contracts.mjs, server/store.mjs and site routes only if needed: shared repository/notes/provider/hostname contract and backward-compatible persistence. |
| w1H:p8 | web/src/** and local provider assets: site editor/row/search, shared compact primitives and overview integration. Sole App.vue/style.css owner. |
| w1H:p6 | tests/**, scripts/check-browser.mjs, scripts/check-layout.mjs: API/restore tests, browser coverage, density/visibility guards. |
| w1H:p7 | Three READMEs, then independent full-scope acceptance review; send findings to owners instead of overlapping edits. |
| Parent | Planning/spec/evidence/context, readiness, coordination/integration, sequential full gates, screenshots, scoped commit/finish when authorized. |

Workers share one worktree and are not alone. Preserve others' changes; no reset/clean, broad staging, branch switching, amend, push, pane creation/closure/movement/focus changes or production access. Workers do not commit; parent controls Git. Preserve unrelated auth/task/journal/agent-directory/ZIP work.

## Dispatch and dependencies

Every brief starts `Active task: .trellis/tasks/10-25-site-console-density`, names phase, owned paths, AC and shared-worktree rules. Load matching Trellis implement/check instructions and curated JSONL. Planning preflight is read-only: no product edits before parent approval and successful task.py start.

p4 establishes the shared schema/helper exports first and signals CONTRACT-READY. p8/p6 can prepare from the agreed design, then compile against real exports. p8 solely owns frontend; p6 owns tests/scripts. Reviewer reports overlapping findings back to owners and rechecks fixes. Parent schedules full/real-tool/browser/layout suites one at a time; targeted isolated checks can run after implementation starts. Verify actual files/results rather than treating a claimed DONE as acceptance.

## Ordered checklist

- [x] Obtain new-task consent; read workflow/spec indexes/prior tasks and research actual local newapi references.
- [x] Resolve multiple repositories, optional notes, title+first hostname and overview-list-only scope.
- [x] Write PRD/design/execution plan and curate real implement/check context entries.
- [x] Read-only final preflight with the four actual Pi panes; p4/p8/p6 READY, p7's explicit precedence/search coverage findings incorporated, final p7 acknowledgment requested.
- [x] Lossless PRD convergence/read-through; present final scope/AC/deferred items and obtain subsequent explicit approval.
- [x] Load before-dev/phase1.4, start only after approval, and create feat/site-console-density from the current feat/site-management HEAD with matching task metadata while preserving dirty work.
- [x] Capture populated pre-change screenshots/geometry with agreed eight-site fixture in isolated data/ports. `.artifacts/baseline-density/baseline.json`: complete rows 3/2/1 at 1440/390/360; maximum heights 181/262/262px.
- [x] p4: schema/default/provider/address projection and explicit public/save metadata; PATCH/legacy compatibility. File/clone backend also complete; full serial real-tool integration suite passed.
- [x] p8: local icons, dense shared row, editor/search, full-address retention, shared compact rhythm and overview preview.
- [x] p6: schema/API/store/legacy/encrypted-restore tests and meaningful browser/layout/density guards with failing controls.
- [x] p7: three README updates complete. Repeated provider 502 errors prevented its final review; native final_quality and layout_status supplied independent signed full-scope PASS instead.
- [x] p4/p8/p6/p7: implement and verify file backups and server-side paused job cloning under the approved PRD amendment.
- [x] Run required integrated checks; inspect actual before/after desktop/mobile/light/dark screenshots and link targets/editor arrays.
- [x] Route findings to owners, recheck boundaries and obtain independent PASS for all AC.
- [x] Update executable specs/evidence and prepare the scoped commit/finish/publication sequence under the existing user authorization. Parent executes Git and bookkeeping after acceptance.

## Checks and evidence

Use npm.cmd on Windows: `npm.cmd run check`, `npm.cmd run build`, targeted new tests then final `npm.cmd test` with absolute artifact rclone/7zip binaries and RUN_BACKUP_INTEGRATION=1. Sequential `npm.cmd run check:browser`, then `npm.cmd run check:layout`; `node scripts/ui-radius-audit.mjs`, `git diff --check` and exact changed-path review.

Prior 91-test/57-browser-screenshot/56-layout-render results are baseline only. This task needs new evidence. Use isolated fixtures/ports and existing artifact tools; do not touch .data/server data. Baseline sites can use existing address/task/tag fields while future repository/note fixture values are recorded for the final run.

## Critical checks

Explicit schema/store/editor projections; old-client omitted PATCH preservation; independent clears; exact full-address/repository order through encrypted restore; no unsafe note HTML or provider substring matching; same-provider distinction; hostname/title one row at 360px; no overflow; independent request failures and draft preservation; real task labels retained while measuring density; approved replacement assertions with failing controls; no shared-job overcount/run repetition or unsupported recoverability claim; no overlapping real-tool suites or unrelated staged work.

## Completion evidence

Final gates: 108 tests / 106 pass / zero fail / two platform skips; type/build, radius and whitespace PASS; browser session 60417 exit 0 (64 screenshots, four actual encrypted backups); final layout session 30871 exit 0 (56 asserted renders, 60 screenshots and deliberate-defect controls). Desktop density is eight rows / 77px, phones three rows / 146px. Both independent reports close AC1–AC8. See `evidence.md` for exact scope, baseline differences and historical failures.
