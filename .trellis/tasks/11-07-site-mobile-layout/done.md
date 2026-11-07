# Mobile site layout repair

Implemented and locally verified on November 7, 2026. The authorized submission triggers the existing GitHub cloud verification; its observed result is appended below before final completion.

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

Pending the authorized work-commit push. Do not interpret this initial entry as a green cloud run; record the real run ID/SHA/conclusion before archiving.
