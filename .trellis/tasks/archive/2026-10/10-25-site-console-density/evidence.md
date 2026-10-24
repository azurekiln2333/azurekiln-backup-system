# Implementation and verification evidence

Date: 2026-10-25 (Asia/Shanghai). Base: `cc900be`, branch `feat/site-console-density`.

## Baseline

`.artifacts/baseline-density/baseline.json` and three screenshots were captured before frontend changes, with isolated state and eight sites. At 1440×900, 390×844 and 360×780 the complete-row counts were 3, 2 and 1; maximum row heights were 181, 262 and 262px. The baseline had no repository/notes fields. Final density checks retained the same existing title/address/tag/job data and added two repositories plus a short note to every row; the full rendered content is therefore not identical.

## Coordination

- Actual existing Herdr workspace `w1H`: p4 backend/shared, p8 frontend/assets, p6 site tests/browser/layout, p7 three READMEs/independent review. No panes were created, moved, closed or focused.
- Native backend helper: source research and exclusive `tests/file-clone.test.mjs` ownership. Native asset helper: `.artifacts/provider-assets/` only.
- Parent owns activation/branch, specification updates, integration, final sequential gates and scoped Git operations. Unrelated dirty auth/task/workspace/agent/ZIP paths remain outside the task.

## Findings resolved during implementation

- Clone associations originally used the site-to-job lookup in reverse; replaced by `SELECT site_id ... WHERE job_id=?`.
- Clone default-name truncation now counts UTF-16 code units and avoids splitting surrogate pairs.
- A paused clone must not refresh scheduler/watchers: refresh mutates existing jobs' runtime timestamps.
- File picker must browse the existing file's parent and revalidate selection on each listing rather than request a directory listing of a file.
- Independent overview data must not hide successful site loads or invent zero/idle runtime summaries.
- Density fixture must retain baseline data and include two repositories on every final standard row; visibility and negative controls follow actual data.

## Local provider assets

GitHub and CNB official SVG assets, and Gitee/GitCode unchanged symbol paths extracted from official SVGs, were downloaded to `.artifacts/provider-assets/ready/`. Source URLs, extraction notes, XML safety checks and hashes are recorded in that artifact directory; frontend bundles only the selected local files. No runtime provider request is required.

## Gates

- Backend owner reported 34 existing API/grouping/watcher regression tests passed and targeted contract/store/clone/file probes passed. These are preliminary evidence, not the final full-suite result.
- Final integrated type check/build, radius audit and whitespace checks: PASS.
- Final full tests and encrypted file/system export round trips: PASS, 108 tests / 106 passed / zero failed / two platform-specific skips.
- Final browser lifecycle: PASS, exit 0, 64 screenshots / four real encrypted backups / zero browser errors / five local SMTP messages.
- Final layout matrix and deliberate-defect controls: PASS, exit 0, 56 asserted renders / 60 screenshots. Parent inspected baseline/final desktop/mobile/light/dark screenshots; both independent native reviewers signed PASS for the final scope, closing AC1–AC8.

### Full-suite attempts before final acceptance

- `.artifacts/logs/site-console-tests.log`: 108 tests, 105 passed, one failed, two Windows-specific skips. The failure compared Windows tar listing stdout decoded as UTF-8 with a Unicode filename. The corrected test still asserts exactly one member and checks the actual extracted filename, bytes/hash, sibling absence and metadata. Its isolated real-tool rerun passed (one test, 8.16s).
- `.artifacts/logs/site-console-tests-final.log`: 68 tests reached, 58 passed, nine failed and one skipped. V8 reported `Fatal process out of memory: Zone`; rclone also failed during Go runtime allocation and subprocess startup returned `spawn UNKNOWN`. Some setup/crypto-dependent requests returned 401/500. Read-only auth audit found no shared fixture/session/time-mock defect; allocation pressure is the likely cause, not proven for every response because older assertions omitted response bodies. This attempt is not a passing gate.
- Final controlled rerun uses the same complete test glob with `--test-concurrency=1`, real 7z/rclone integration enabled and `GOMAXPROCS=2`. No production setting or authentication behavior is changed to accommodate this machine.
- `.artifacts/logs/site-console-tests-serial.log`: final controlled rerun completed with exit 0 in 209.07s: **108 tests, 106 passed, zero failed, two Windows-specific skips**. It includes private-secret/site-link clone transactions, the Windows drive-root dirname regression, real encrypted single-file/empty-file extraction, current/legacy system snapshot restore and real encrypted site export/download/staged-import restoration. Previous failing attempts above remain recorded separately.
- Initial final typecheck/build both exited 0. A preliminary browser run then failed the existing mobile containment guard (`editor-390`, `new-api` button outside viewport); screenshot inspection confirmed the newly expanded backup-type selector overflowed the modal. The guard remains intact; the frontend owner is correcting the selector layout and the remaining background-job-read state before the rebuilt final browser run. Historical log: `.artifacts/logs/site-console-browser-preliminary.log`.
- Final frozen product source includes wrapped mobile type controls and independent job loading/error/request-epoch state with last-good list rendering. Final `npm.cmd run check` and `npm.cmd run build` both passed again; logs `site-console-typecheck.log` and `site-console-build.log`.
- Browser harness corrections preserve the actual flows: `poll` returns the action result, so the saved file job must be selected from its returned list; exact original-task selectors avoid matching the newly created copy; pending overview copy is distinct from unavailable/error copy. The file-save assertion failure remains in `site-console-browser-file-assertion.log`.
- Layout fixtures created by API after initial empty SPA load require an explicit reload before measurements. Both overview/site views await real rows before probing, while retaining nonzero and visibility guards. Computed padding is checked by its four sides so equivalent three-/four-value shorthand serialization cannot create false failures. Final layout evidence remains pending until the full matrix and deliberate-defect controls pass.
- Visual inspection found the original shared `.tag-chip` base rule had been removed, leaving browser-default tag buttons. The parent restored that exact original rule; hostname links remain transparent. A later browser run passed file execution/download and clone success/secret-preserving save/failure checks, then the deliberately held overview request exposed auth boot awaiting dashboard refresh. The parent detached resource refresh from authentication completion; static review plus repeated type/build checks passed. Historical failure: `site-console-browser-pending-auth.log`. Final browser and post-restoration layout results follow below when complete.

## Final acceptance

- Full backend gate: `.artifacts/logs/site-console-tests-serial.log`, exit 0, 209.07 seconds, with real rclone/7zip and `RUN_BACKUP_INTEGRATION=1`. No backend source changed after that passing gate.
- Final type/build gates: `.artifacts/logs/site-console-typecheck.log` and `site-console-build.log`, both exit 0 after the final editor correction. `node --check scripts/check-browser.mjs`, radius audit and `git diff --check` passed.
- Final layout: session 30871, exit 0; `.artifacts/logs/site-console-layout.log`, `.artifacts/layout/density-metrics.json`, capture `2026-10-24T20:08:44.569Z` (2026-10-25 Asia/Shanghai). All seven pages × four widths × two themes, eight overview combinations / 48 visible site names, populated-site density/visibility guards and deliberate-defect controls passed. This includes restored tag styling and decoupled auth/resource loading.
- Independent screenshot review then found ordinary file/directory editors incorrectly falling through to system-only backup help. `JobEditor` now guards that help with `form.type === 'system'`. Browser assertions require the exact system-description text to be absent in the single-file and copied-directory editors. No main-page layout or CSS changed in this correction.
- Latest complete browser: session 60417, confirmed exit 0, `.artifacts/logs/site-console-browser.log`, `.artifacts/screenshots/verification.json`, checked `2026-10-24T20:15:46.119Z`. Its 64 screenshots, four actual encrypted backups, downloads, file picker/navigation/refresh, file save/manual run, paused clone/retained secret/blank-password save/failure, site metadata/search/full links, independent resource loading/failure/retry, restore and login flows all passed, including both new system-help assertions. `browserErrors=[]`; five SMTP messages received.
- Screenshot inspection: baseline desktop/360px plus final sites/overview desktop/mobile in both themes and file/clone editors. Addresses remain transparent links, tags retain filled chips, title/hostname share a row, mobile controls remain reachable, and long secondary labels grow naturally.
- p7 delivered the three README updates, but repeated provider 502 errors prevented its final review. Native `final_quality` and `layout_status` performed the independent full-scope review instead; their signed reports are in `research/final-quality.md` and `research/independent-review.md`.

| Viewport | Baseline complete rows / max height | Final complete rows / max height (both themes) |
| --- | --- | --- |
| 1440×900 | 3 / 181px | 8 / 77px |
| 768×1024 | Not captured | 8 / 97px |
| 390×844 | 2 / 262px | 3 / 146px |
| 360×780 | 1 / 262px | 3 / 146px |

The desktop target (≥6 rows, ≤104px) and phone targets (≥3 rows, ≤156px) pass with the extra repository/note content present. Application state remains SQLite; archives remain files. Production deployment and the separate GHCR pipeline are outside this task.
