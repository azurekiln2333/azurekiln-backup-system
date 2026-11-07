# Site mobile layout review

Reviewed November 7, 2026 against the staged task diff and exact index export `.artifacts/site-mobile-layout-submission-83c90c6ecb`. Read the task PRD/design/plan, frontend contract, reuse guide and measured width investigation. Parallel notification/node changes were excluded from this review and left intact. No product code or Git state was changed by the reviewer.

## Findings (fixed)

None. No mechanical fixes were necessary.

## Findings (not fixed)

No blocking defect was identified in the task-owned changes. Actual Linux/cloud success remains evidence for the main session to obtain; local source inspection and Windows checks do not establish it.

## Behavior and regression review

- The phone-only CSS gives metadata both grid tracks, moves the unchanged edit/delete control group to row 2, and reserves column 1 for linked tasks. Desktop rules and SiteRow DOM/handlers/tab order are unchanged. Overview retains its more-specific single-column grid, so no empty action column is introduced.
- Repository labels and task names retain natural wrapping, complete targets and existing font/control dimensions. Long task names can grow within the narrower task column; no fixed height, clipping or label suppression was added.
- The eight-site fixture, original 104px/156px thresholds, complete-row requirements, visibility guards and negative controls remain intact. The wider-label stimulus uses test-only letter spacing and asserts it crosses the measured prior 222px boundary. Restoring old tracks must fail the same production density guard, providing a meaningful regression rather than mirroring CSS declarations.
- Wide-label checks cover inventory/overview in both themes, distinct full repository targets and control/document containment. Long repository/task strings must increase row height and retain their measured full content without overflow.
- Density measurements now record site metadata/action/repository geometry before density assertions. A top-level failure handler attempts screenshot and JSON capture before browser cleanup while preserving the original thrown error. The existing workflow artifact paths already include this directory.
- The staged diff contains only the repair's site CSS/layout-test additions, frontend spec and task artifacts. Existing notification settings CSS and settings-layout script modifications remain outside the index.

## Verification

- Lint: no standalone lint script exists. Reviewer `node --check` on the exact exported layout script and staged `git diff --check` passed.
- TypeCheck: reviewer `npm run check` passed against the exact exported source.
- Build/radius: main session reported both passed on the same export; implementer also reported syntax, type-check and radius checks passed.
- Browser/layout/tests: main session owns sequential runs to avoid tool contention. The reviewer did not launch another browser or duplicate suites while those checks were running. Final results and actual GitHub evidence belong in `done.md`.

Main-session validation subsequently passed on the exact export: full layout (56 renders, 64 screenshots including the wider-label cases), full browser (65 screenshots and four real encrypted backups), and 150 tests (146 passed, zero failed, four Windows skips). Standard row maxima are 77px at 1440, 126px at 390 and 146px at 360, in both themes. Main inspected desktop/mobile/light/dark screenshots. A normalized edit comparison confirmed the original parallel CSS and layout-script changes remain intact outside the task commit. Work commit `e68ed8c` was pushed to both remote branches; actual GitHub main run `42386672446` is the cloud verification evidence tracked in `done.md`.

That actual GitHub run completed with **success**: all 150 Linux tests passed with zero skips; type-check/build, full browser, six site-deployment cases and all 56 layout renders including the wider-label and negative controls passed. The original 156px threshold remains in place. This closes the prior Linux evidence gap; image publication and production deployment were not triggered.
