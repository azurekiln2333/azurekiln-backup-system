# Portable compact site rows

## Verified behavior gap

The phone inventory reserves a 62px edit/delete track plus an 8px gap beside all primary site metadata. At a 360px viewport its 316px row has 24px horizontal padding, leaving only 222px for identity, repositories, tags and note. The overview has no action track and leaves 292px. Two standard repository links fit with Windows Cascadia (219.922px including gap) and fail with a slightly wider 10px monospace font (Courier New: 224.047px). Their second flex line adds 20px. In the exact-HEAD probe that changes the first row from 144.5px to 164.5px, crossing the unchanged 156px maximum. Actual Linux 169px includes different platform text metrics; its exact font is unproven.

## Proposed repair boundary

- Change only the phone site-grid declarations in `web/src/style.css`: let `.site-row-main` span both tracks, place `.site-actions` in grid row 2, and keep `.site-jobs` in column 1 of row 2.
- This reserves the action track alongside task chips instead of all metadata. Standard task chips fit in that column; long names still wrap naturally. Overview rows keep their current full-width jobs because their existing more-specific rule uses column 1 in a single-column grid.
- Keep the existing DOM, handlers, tab order, action hit boxes, title/hostname line, provider icons, full repository labels, note preview, desktop tracks, theme tokens and density values.
- Candidate style injection into an ignored exact-HEAD snapshot produced 144.5px at 360 and 124.5px at 390 with Courier New, no source changes. Inventory and overview screenshots were inspected. This experiment establishes feasibility, not completion or Linux success.

## Regression design

Extend the existing layout script rather than create a duplicate fixture or guard. Retain its eight sites and all assertions. Include diagnostics for metadata/action/repository rectangles and save a failure screenshot plus measurements before cleanup if a guard throws; the current density JSON is written only after the matrix and lacks the failed viewport.

Add a controlled wider-monospace case at 360px for inventory and overview in light/dark, using a deterministic local font or measured width stimulus to exercise the proven wrap boundary without depending on the host's installed Windows fonts. It must run the same production visibility/density guards. Retain fault injections showing hidden labels and oversized padding fail. Verify naturally growing long repository/task content, distinct complete link targets, action containment and no hidden/clipped text. Do not alter normal application fonts to pass a test.

## Ownership and integration

Implementation owns only phone `.site-*` CSS hunks, layout-regression/diagnostic hunks and task artifacts. Existing notification settings CSS and settings-layout test hunks belong to other windows and stay outside this task's commit. Main coordinates executable spec updates and Git commits. Export HEAD plus only this task's staged hunks to an ignored validation snapshot before submission; use normal fast-forward pushes to the feature branch and main under existing session authorization.

## Validation and rollback

Run type-check/build, radius audit, full layout/browser and relevant tests sequentially against exact submitted source, inspecting phone/desktop and light/dark screenshots. Verify an actual GitHub run after submission. Runtime-image publishing, production deployment and unrelated node/notification code are excluded. Reverting the task's narrow CSS/test/spec changes restores prior behavior; no data migration is needed.
