# Site deployment notes design

## Change boundary

The site editor currently records addresses, repositories, notes and backup associations but has no structured image/update notes. Add two metadata fields at their owner: shared `siteSchema`, the explicit store projection/save record, and `SiteEditor.vue`. The fields never enter backup jobs or runtime deployment configuration. Existing dirty node/notification/frontend work must remain intact.

## Contracts

- `cloudImages`: at most 20 trimmed nonempty strings, maximum 1024 characters each, no embedded whitespace/control characters; exact case-sensitive deduplication retaining first order. Empty array default. Plain image-reference text (registry/repository with optional tag/digest), no network validation or URL navigation.
- `watchtowerAutoUpdate`: strict boolean, default false. Public response and persistence use the same field. This is an operator-maintained note about the site's external deployment.
- Existing site POST/GET/PATCH/DELETE routes remain unchanged. Store `siteView` supplies legacy defaults; `saveSite` projects both parsed fields after merging PATCH with the prior record, in its existing metadata/link transaction.
- `SiteInput`/`Site` derive from the shared schema; avoid a duplicate browser validator. Reuse list rows and checkboxes already used in the editor. Scope UI changes to settings; no new global switches or runtime polling.

## Ownership and verification

Implementation may edit `shared/contracts.mjs`, `server/store.mjs`, `web/src/components/SiteEditor.vue`, `tests/sites.test.mjs` and a focused `scripts/check-site-deployment.mjs` browser script. No changes to dirty global styles, App, notification modules or mapper files are necessary. Main session owns task artifacts, code-specs, staging/commits and merge verification; check sub-agent reviews and fixes only the same assigned feature files.

Use real HTTP/SQLite tests for defaults, normalization, create/read/reopen, independent PATCH clears, invalid-write atomicity, legacy rows and snapshot/restore retention. Browser checks use isolated state and actual APIs, exercise both themes plus desktop/mobile inputs and draft preservation, assert metadata-only network behavior, and save screenshots under `.artifacts/`. Reuse existing full check/layout/browser scripts unchanged; run expensive suites sequentially. Before committing, stage only this task's hunks in shared dirty files and verify an exported index snapshot.

## Confirmed merge verification repair

Main run 42314406587 failed 27 tests because apt rclone 1.60.1 lacks `config encryption set`. Its four skipped real-tool cases also need explicit integration env. The same unpinned installation appears in CNB's `scripts/ci-verify.sh` and `Dockerfile`; repair provisioning once with `scripts/install-rclone.sh`, fixed 1.75.1 official SHA-256 for amd64/arm64, capability validation and absolute binary export. Keep `server/rclone.mjs` encryption intact. A real shell probe also confirms `${7ZZ_BINARY:-}` fails; use `printenv` for that legacy numeric environment key. Owned extra files: installer, Dockerfile, workflow, shared CI script, existing CI script guard and meaningful Linux-only installer rejection tests. Add the focused site browser gate sequentially to both verification lanes. Local Windows cannot execute Linux image/architecture binaries; obtain subsequent GitHub run evidence and report remaining image/CNB limits honestly.
