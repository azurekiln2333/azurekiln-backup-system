# fix(sites): portable compact mobile rows

## Goal

Restore the cloud layout gate for compact site rows on small phones while keeping repository and linked-task information readable.

## Confirmed background

- GitHub main run `42327196037` at `9132496` passed type-check, build, all 150 Linux tests, the full browser flow and six site-deployment cases. Its independent layout step failed at `light/360/sites`: a standard row measured 169px against the 156px maximum.
- The exact submitted tree passed the same layout script locally on Windows with standard rows up to 146px at 360/390px. A controlled-font probe on exact HEAD reproduces an extra 20px: at 360px the metadata track is 222px, native Cascadia repository links total 219.922px including their gap, while Courier New totals 224.047px and wraps the second repository. The actual Linux fallback font has not been identified; the measured width sensitivity matches its 390px/360px-overview screenshots and 169px inventory failure.
- The density fixture contains eight sites, two repository references, tags, one short note and two linked tasks. Site deployment-note fields are not rendered in `SiteRow`.
- `SiteRow.vue` is shared between the site inventory and overview. Existing specs require natural wrapping, useful visible labels and no fixed-height clipping.

## Requirements

- Diagnose the actual layout contribution before choosing a repair. Use exact committed source to separate the failure from unrelated parallel WIP.
- Keep the existing density thresholds and standard fixture. Make the shared site row fit the 360px/390px standard density requirement in Linux Chromium and Windows Chromium.
- Preserve the title and first-hostname identity line, complete safe links, distinct repository labels/provider marks, tag interactions, note preview and actual task names/types/states. Long or numerous references may grow naturally.
- Add meaningful diagnostic/regression evidence for the verified cause, retaining existing visibility, density and negative-control guards.
- Validate desktop/mobile and light/dark presentation, full type-check/build/browser/layout gates and the actual GitHub result after the authorized submission.
- Preserve unrelated node/notification changes, including other workers' hunks in global CSS and layout scripts. Commit only the repair's owned changes and write `done.md` with exact results and limits.

## Acceptance Criteria

- [x] The prior 169px failure is reproduced or explained by measured DOM/font/layout evidence before repair.
- [x] Standard site rows meet the existing 104px desktop / 156px phone maxima and complete-row requirements without hiding useful content (local exact submission; actual cloud result remains below).
- [x] Both inventory and overview retain accessible names, links, labels and actions, with no horizontal document/control overflow across the existing viewport/theme matrix.
- [x] Long repository/task labels remain readable and can grow naturally; fault injection still catches hidden information and oversized row padding.
- [ ] Type-check, build, full browser/layout and targeted cause regression checks pass; actual cloud results are documented honestly.
- [ ] Only this task's changes are submitted, parallel WIP is preserved, and task `done.md` records validation.

## Out of scope

- Site metadata/API changes, new visual design, node/notification features, release triggers and deployment operations.
- Relaxing test thresholds, changing the fixture to fit, clipping row content or adding an arbitrary CI-only font to conceal the problem.

## Authorization and open decisions

The user approved creating this Trellis repair task and entering planning, then explicitly approved the final proposal with `快点修完上去云构建啊`. The approved narrow-screen grid rearrangement gives metadata full width, followed by task chips with edit/delete controls beside them, retaining control size and desktop behavior. This authorizes implementation, scoped commits/pushes and actual cloud verification. Repository-answerable technical questions are investigated directly; no site data/API changes are requested.
