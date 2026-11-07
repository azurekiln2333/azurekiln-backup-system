# Implementation and verification

- [x] Inspect workflow/frontend contracts and current parallel WIP; create the user-approved repair task with base branch main.
- [x] Inspect real GitHub run `42327196037` screenshots and exact-HEAD local geometry. Reproduce the additional repository line under controlled wider-font metrics; inspect a candidate grid injection.
- [x] Present final planning summary and receive subsequent explicit implementation approval (`快点修完上去云构建啊`).
- [x] Curate implement/check context and activate the task only after approval.
- [x] Dispatch Trellis implementer with ownership restricted to mobile site CSS and site layout regression/diagnostics; preserve existing dirty hunks.
- [x] Validate exact submitted source, sequentially: type-check/build, radius audit, full layout including font/long-content/failure controls, full browser, relevant tests. Inspect desktop/mobile/light/dark evidence.
- [x] Independent Trellis check across all task-owned changes; repair verified findings and repeat only affected checks.
- [x] Update frontend spec with the measured width sensitivity and required diagnostic/regression contract; write done.md with exact checks and limitations.
- [x] Commit only task-owned hunks, push/fast-forward merge under prior authorization, and inspect actual GitHub result without weakening gates (`e68ed8c`, run `42386672446`: success).
- Finish-work: archive only this completed task and record the journal; preserve other tasks and WIP. The task status, archive path and subsequent journal commit record completion of this bookkeeping step.

Expected code paths: phone `.site-*` declarations in `web/src/style.css`; production site guards, evidence handling and new targeted site regressions in `scripts/check-layout.mjs`. No shared schema, server, SiteRow DOM or deployment changes are planned.

Existing unsubmitted hunks in both expected files are unrelated. Snapshot their starting diff and stage only task-owned additions; do not use `git add .`, amend, force push or destructive checkout. Browser suites must run sequentially to avoid tool detection starvation.
