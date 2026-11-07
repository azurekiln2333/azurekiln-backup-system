# Mobile site layout repair

Implemented, submitted, merged to main and verified by the real GitHub cloud run on November 7, 2026. The complete result is recorded below.

## Cause and repair

At 360px the previous inventory gave all metadata a 222px track because the 62px edit/delete column and 8px gap occupied its right side. Two standard repository references can total over 224px with slightly wider monospace metrics, adding a 20px flex line. This was reproduced against exact committed source with measured DOM/font evidence in `research/width-probe.md`; the actual Linux fallback-font identity is not assumed.

The phone-only grid now lets metadata span the full row and puts the unchanged action controls beside the linked-task area below it. Desktop tracks, shared SiteRow DOM, handlers, fonts, action dimensions and all complete link/label values are preserved. Long repository/task content still grows naturally. The original 104px desktop / 156px phone density limits and eight-site fixture remain unchanged.

The existing layout gate now includes a deterministic wider-label stimulus, reuses the production visibility/density guards, proves that restoring the old tracks fails, and checks long labels grow without clipping or overflowing controls. Density evidence includes metadata/action/repository geometry; failed runs attempt screenshot/JSON capture before browser cleanup.

## Scope and ownership

- Owned changes: mobile site hunks in `web/src/style.css`, site regression/diagnostic hunks in `scripts/check-layout.mjs`, the frontend UI spec and this task's artifacts.
- Other workers' existing node/notification/settings CSS and script hunks were preserved and excluded from the index, together with all unrelated backend/UI/README WIP.
- No API/data migration, deployment automation, tag, image publication or production operation is part of this repair.

## Exact-source verification

The exact staged code was exported to ignored `.artifacts/site-mobile-layout-submission-83c90c6ecb`, excluding parallel WIP. Sequential verification passed:

| Check | Observed result |
| --- | --- |
| Type-check / production build | Passed |
| Script syntax / radius audit / scoped diff | Passed |
| Full layout | 7 pages × 4 widths × 2 themes, 56 asserted renders, 64 screenshots |
| Wider-label regression / old-track negative control / long-content stress | Passed in inventory and overview, light and dark |
| Standard rows, both themes | 1440px: max 77px / 8 complete; 390px: max 126px / 4 complete; 360px: max 146px / 3 complete |
| Full browser | 65 screenshots, four real encrypted backups, download, SMTP, login, watcher and responsive flows |
| Full tests with real tools / integration enabled | 150 total, 146 passed, zero failed, four explicit Windows skips |
| Independent Trellis review | No blocking findings; see `review.md` |

Representative desktop and mobile, light and dark screenshots were visually inspected. Tests used absolute rclone 1.75.1 and 7-Zip paths. The four Windows skips remain platform-specific socket/symlink/POSIX-installer cases. No Linux result is inferred from these local checks. Ignored logs and screenshots stay under `.artifacts/`.

## Remote verification

Work commit `e68ed8cdbd06b94669ca77c8ff37a43211adec3e` (`fix(sites): keep mobile metadata clear of the action column`) was normally pushed atomically to `feat/nodes-and-notify` and fast-forward merged to remote `main` on November 7, 2026.

GitHub main run `42386672446`, attempt 1, verified that exact SHA and completed with overall **success**:

- Type-check and production build passed; rclone 1.75.1 installation passed.
- All **150 Linux tests passed, zero failed or skipped**.
- Full browser passed with **65 screenshots and four real encrypted backups**.
- Site deployment notes passed all **six viewport/theme cases**.
- Full layout passed: **7 pages × 4 widths × 2 themes, 56 asserted renders, 64 screenshots**, including the wider-label regression, old-track negative control and long-label stress checks. The previously failing `light/360/sites` gate now passes with the original 156px guard.
- Image publication, release and latest-promotion jobs were skipped as expected for branch/main pushes; no image or production deployment was published.

Sanitized actual run-log evidence is saved locally in ignored `.artifacts/github-42386672446-evidence.jsonl`. The log archive was retrieved using the existing Git credential only in memory and following its signed redirect without forwarding authorization; no secret or signed URL was persisted. Normalized comparisons independently confirmed parallel edits in both shared source files were preserved. Documentation-only archive/journal commits follow the verified repair without further product-code changes.
