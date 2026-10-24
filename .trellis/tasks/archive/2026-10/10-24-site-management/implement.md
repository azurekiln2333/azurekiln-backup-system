# Implementation and verification plan

Status: implementation, independent review and all acceptance checks passed on 2026-10-24. The user authorized the scoped commit and GitHub push with “推送上去啊”; proceed with commit, finish/archive and feature-branch publication. Original final planning approval: “批准，按方案开始实施”.

## Dependencies and ownership

This is one site-inventory deliverable, not several independent child tasks. Establish the shared SiteInput/Site contract first. Then a backend implementer and a frontend implementer can work in parallel against it; integration checks and an independent reviewer follow both streams. Workers share the worktree, must not revert others, and must coordinate any overlapping shared file changes.

- Backend ownership (Pi `w1H:p4`): `shared/contracts.mjs`, `server/store.mjs`, `server/app.mjs`.
- Frontend ownership (Pi `w1H:p8`): `web/src/**`. App's site APIs/types must match the backend contract exactly.
- Test ownership (Pi `w1H:p6`): `tests/**`, `scripts/check-browser.mjs`, `scripts/check-layout.mjs`.
- Documentation/review ownership (Pi `w1H:p7`): the three README files and independent task acceptance review.
- Parent ownership: planning/context, integration coordination, spec updates, final evidence/commit/archive. No product work starts during planning.

## Ordered checklist

- [x] Obtain consent and create a separate site-management task.
- [x] Read scoped specs and inspect backend/frontend extension points.
- [x] Confirm both directions of many-to-many binding with the user.
- [x] Consolidate PRD; write design/execution plan and curate implement/check context.
- [x] Present the final plan, including multiple addresses, gradual setup, tag classification, reverse mapping, and deletion behavior; obtain fresh approval (2026-10-24).
- [x] Run phase 1.4 readiness guidance and `task.py start` only after approval.
- [x] Load implementation step, skills/specs, current status and scoped baseline diff; preserve existing unrelated changes.
- [x] Dispatch a Trellis implementer to establish the shared site schema/reusable tag contract, with agreed API field names and domain normalization.
- [x] Implement additive tables/indexes, store-owned atomic site CRUD, site routes, and meaningful backend/API/restore tests.
- [x] Implement navigation, App-owned site state/mutations, SitesView, SiteEditor, tag/search/filter behavior and reverse task detail associations in parallel after the shared contract is fixed.
- [x] Extend real browser lifecycle tests and the populated seven-page layout matrix; preserve existing guards and prove new visibility checks fail on an intentionally hidden site/domain/job label.
- [x] Run required application/browser/layout/radius checks sequentially where real-tool contention matters.
- [x] Dispatch `trellis-check` for full approved scope, tests, referential integrity, compatibility, error paths, UI behavior, and self-fixes confined to task-owned files.
- [x] Update the verified frontend/backend site contracts and record evidence/limits.
- [x] Make the authorized path-limited commit; never stage unrelated metadata/auth/agent directories/user archives. Push `feat/site-management` after scoped bookkeeping.
- [x] Finish/archive only after every site acceptance criterion has current evidence; leave CI/new-api follow-ups separately recorded.

## Required checks

- Shared schema: name/domain validation, safe link schemes, canonical deduplication preserving path semantics, independent tag values, job-ID set semantics, defaults and PATCH preservation.
- Store/API: actual SQLite lifecycle/restart, old DB migration, many-to-many both directions, transaction rollback on invalid IDs, site delete without job/history/archive mutation, job delete cascade with existing protections, 401/403/404/validation responses, and no secret fields in public site data.
- Restore: current state snapshot/import preserves exact site IDs/domains/tags/links; old archive restores to empty site tables after startup; `PRAGMA foreign_key_check` passes. Reuse existing system restore machinery rather than mock-only assertions.
- `npm test`, `npm run check`, `npm run build`.
- `npm run check:browser`, followed by `npm run check:layout`, with isolated fixtures and real backup tools/browser. Sites matrix: 56 page renders across seven pages/four widths/two themes plus existing supplements.
- `node scripts/ui-radius-audit.mjs`, `git diff --check`, scoped changed-path review.

## Rollback and risks

- Site associations are inventory, not proof of complete site backup coverage. Show actual linked jobs/status without inventing a blanket recovery-success claim.
- Additive tables must never rewrite existing job JSON or delete runtime data. Deleting inventory only cascades its link rows.
- Test global built-in system-task handling and paused/offline job association without changing their execution behavior.
- If implementation reveals a larger schema/UX requirement, return to planning and review it rather than expanding silently.
- Current pre-existing unrelated work includes `server/auth.mjs`, parent task metadata, journals, local agent directories and the user ZIP. Preserve it and avoid broad staging/reset/cleanup.
- The PostgreSQL adapter defects and GitHub image workflow remain separate unapproved implementation scopes; do not bundle them into site changes.

## Completion

Feature work committed as `2dcc72be0d2414a37b901170a145278d09d873ad`. All product gates passed before commit; the remaining closure operations are task archival, a scoped session record and the authorized normal push of `feat/site-management`.
