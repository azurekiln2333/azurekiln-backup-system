# Repository host fallback verification

Date: 2026-10-25. Branch: `fix/repository-host-fallback`. Baseline: `95a5566`.

## Implementation and review

- `trellis-implement` completed the eight product/test/README files. Main synchronized backend/frontend specs.
- A separate `trellis-check` agent reviewed the full task against the PRD and relevant specs. It found no repository-link correctness, accessibility, branding, or scope defects and required no edits.
- The exact reported GitLab URL, a separate self-hosted repository, and known-name lookalike hosts are accepted independently of the icon map. Unknown providers remain clickable text with full targets and accessible names, without icons.

## Passed checks

- `node --test tests/sites.test.mjs`: 16 passed, including unknown-host create/read/edit/restart persistence and a real encrypted configuration-backup round trip.
- `npm run check`: passed.
- `npm run build`: passed.
- `node --check scripts/check-browser.mjs`: passed.
- `npm run check:browser`: passed; 65 screenshots and 4 real encrypted backups. New assertions cover mixed known/unknown repositories, site list and overview, editing/reload/mobile behavior, full hrefs, useful accessible labels, no unknown-provider icons and no repository-host requests.
- `npm run check:layout`: passed; 56 asserted renders and 60 screenshots, seven pages by four viewport widths by two themes. Populated-site density and negative-control assertions passed.
- `node scripts/ui-radius-audit.mjs`: passed.
- `git diff --check`: passed.

## Full-suite limitation

Two `npm test` runs each reported **109 tests: 105 passed, 1 failed, 3 skipped**. Both failed the existing executor test `upload failure preserves previous successful archive and bounded failure staging` at `tests/executor.test.mjs:300`: `only latest failed staging retained` observed `true` instead of `false`.

The exact named executor case passed alone without code edits: **1 passed**, 8.95 seconds. This establishes suite-sensitive behavior, not a clean full-suite gate. Neither this executor test nor its implementation is changed by this task, and no baseline full-suite run was performed to attribute the failure further. All site regressions passed in both full runs. Do not describe the complete test suite as passing.

## Visual inspection

Main and checker inspected the fresh desktop/mobile unknown-host views and light/dark populated site layouts. No task-scope visual defect was found. Representative artifacts:

- `.artifacts/screenshots/desktop-sites.png`
- `.artifacts/screenshots/desktop-overview-repository-hosts.png`
- `.artifacts/screenshots/sites-390.png`
- `.artifacts/layout/light-1440-sites.png`
- `.artifacts/layout/light-390-sites.png`
- `.artifacts/layout/dark-1440-sites.png`
- `.artifacts/layout/dark-390-sites.png`

## Pending

User review of the concrete commit plan. No commits, archive operation, deployment, or journal changes have been performed for this task.
