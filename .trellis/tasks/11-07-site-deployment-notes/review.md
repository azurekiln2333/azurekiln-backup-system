# Site deployment notes review

Reviewed on November 7, 2026. Scope: the site-image additions in `shared/contracts.mjs`, `server/store.mjs`, `web/src/components/SiteEditor.vue`, `tests/sites.test.mjs`, and `scripts/check-site-deployment.mjs`. The CI installer, workflow, Dockerfile and associated tests were reviewed read-only. Concurrent nodes, notifications and global frontend work were left intact. No Git mutations were performed by the reviewer.

## Findings (fixed)

- File: `scripts/check-site-deployment.mjs`
- Issue: the enabled backup-job fixture omitted its required destination. `store.saveJob` raised `DESTINATION_REQUIRED` during setup, before Chromium could exercise the site feature.
- Fix: give the fixture an inert `fixture:backups/site-deployment` destination and expose the matching alias through the stubbed `listRemotes` adapter. Execution adapters remain inert and the script still asserts that site edits cause no operational actions or external requests.
- Verification: reviewer ran `node --check scripts/check-site-deployment.mjs` successfully. The main session subsequently ran the focused browser script successfully across all six viewport/theme combinations.

## Findings (not fixed)

No unresolved product defects or blocking CI-code findings were identified within the assigned scope. No design, interface or module-boundary changes are recommended.

The main session subsequently completed exported-tree tests/check/build/browser/layout; see `done.md` for the exact results. Subsequent Linux/cloud/image evidence remains separate from this review.

## Contract review

- The shared schema enforces strict boolean input and the specified image-list limits, trimming, whitespace/control rejection, case preservation and stable exact deduplication. Browser types continue to derive from the shared schema.
- Both the explicit stored record and public `siteView` include the new fields. Legacy rows receive defaults without a bulk rewrite. PATCH merges the previous record before parsing, so omitted values survive while `[]` and `false` clear independently.
- Metadata and job links remain in the existing transaction. Rejected metadata and missing linked jobs cannot partially save deployment notes. Site handlers do not refresh execution services, configure Watchtower or probe registries.
- The editor retains its mounted draft after validation/server errors, uses labelled add/remove image controls and the exact Watchtower label, and explains that the checkbox records an external deployment arrangement. Existing responsive dialog and checkbox styles are reused.
- HTTP/SQLite tests cover normalized create/read/reopen, limits and wrong types, independent clears and omission, invalid-write atomicity, unchanged execution state, legacy non-rewrite behavior, database restore and a real encrypted system-configuration backup containing the fields.
- The browser regression covers add/remove/save/reopen/clear, duplicate normalization, rejected validation and injected server-failure draft retention. It asserts unchanged non-site tables and deployment/rclone files, ordinary site mutations only, and no external requests or execution actions.
- The new backend site/tool-provisioning specs and the frontend UI contract describe the implemented ownership and validation boundaries. The main session owns their final synchronization and task completion document.

## CI review

The original remote failure is confirmed in [the investigation](research/ci-rclone-failure.md): GitHub run `42314406587`, attempt 1, tested SHA `fa233a7d509845daa5c76bdaf8b082d3c3176850` with apt rclone `1.60.1-DEV`. All 27 failed cases encountered its unsupported `config encryption set` command. Four real-tool cases were skipped. The independent failed-staging timing issue was not the cause of that run.

The main session's repair preserves application config encryption and shares one rclone `1.75.1` installer across GitHub verification, CNB's shared verification entrypoint and the Docker runtime image. The two pinned archive digests match the official checksum values recorded during the investigation. The installer rejects unsupported architectures, checks bytes before extraction, probes the required CLI before installation and cleans its temporary directory on exit. Rejection tests preserve the existing executable. Provisioning callers declare the download/extraction prerequisites; the shared verifier checks encryption capability even when an old executable already exists and prefers the installed absolute path after provisioning.

GitHub now passes absolute rclone/7-Zip paths and enables real-tool integration cases. Existing shared-verifier exports and its Linux skip budget are preserved. Both verification lanes include the focused site browser gate sequentially.

The main session also fixed a confirmed pre-existing Bash bug: `${7ZZ_BINARY:-}` and `$7ZZ_BINARY` cannot read a digit-prefixed environment key. `printenv 7ZZ_BINARY` replaces the invalid expansion, and the regression guard now rejects both invalid parameter forms. This was a parent-owned fix, not an additional reviewer edit.

## Verification

- Lint: no standalone lint script is defined in `package.json`; reviewer script syntax check passed.
- TypeCheck: implementation agent reported `npm run check` passed. Main-session exported-tree rerun was pending when this report was written; the reviewer did not duplicate it.
- Build: implementation agent reported `npm run build` and the radius audit passed. Main-session exported-tree rerun was pending.
- Site tests: implementation agent reported 19/19 passing, including real encrypted system-backup restoration. The reviewer inspected coverage and did not repeat the suite as instructed.
- Focused browser: main session reported all six combinations passed, `1440/390/360` pixels in light and dark themes, and visually inspected the `1440-light` and `390-dark` screenshots. The resulting JSON records no operational actions or external requests.
- CI focused tests: main session reported 12 tests, 10 passed and two explicit Windows skips for POSIX installer fixtures. Installer and shared-verifier Bash syntax checks passed, and an actual shell probe reproduced the numeric-key substitution failure before correction.
- Limits: the reviewer did not execute a Linux installer success path, runtime container, CNB pipeline or arm64 binary. A subsequent real GitHub run and the main session's final full test/check/build/browser/layout results remain necessary evidence and must not be inferred from local Windows checks.

## Linux follow-up review

Main run `42322774496` subsequently completed all 150 Linux tests with zero failures/skips and installed the pinned rclone. Its browser step failed at the pre-existing single-file picker check, immediately after waiting only for the picker heading. The reviewer independently read `PathPicker.vue`: initial `load()` sets loading/clears selection, awaits the source response, then preselects a confirmed regular file; the heading is visible throughout. Thus `isDisabled()` can correctly be true before loading settles, including on reopening.

The parent's two bounded polls wait for the actual confirmable state before preserving the existing path/filename/enabled assertions. This fixes test synchronization without changing product behavior or weakening the checks: a failed source read or broken preselection still times out. Reviewed read-only, with no additional source edits or duplicated test run by the reviewer. The parent owns exact-snapshot browser rerun and subsequent cloud evidence.
