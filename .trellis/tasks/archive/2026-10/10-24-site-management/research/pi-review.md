# Independent review log — site management (p7: docs + independent verification)

Owner: p7 (documentation + independent review). This file is the only product-adjacent
artifact p7 writes besides the three READMEs. No product/API/frontend/test edits are made here.

## Status

**FINAL — 2026-10-24. Frozen tree reviewed; verdict: PASS on AC1–AC6, no remaining blocker.**

- README site documentation written (zh-CN / en / zh-TW) and re-checked against the final frozen
  behavior. Claims match: field set, 20/2048 limits, bare-host→HTTPS, no userinfo, many-to-many,
  delete-site keeps jobs/runs/archives/other links, delete-job unlinks all sites, state lives in
  `state.sqlite` and rides system-config backup/restore, old archive → empty site list.
- Implementation reviewed end-to-end (contracts → store → routes → UI composables/components →
  browser/layout harnesses → specs). All findings from earlier passes (F1, F2, F4, N1, N2, N3) are
  resolved on the frozen tree; only N4 (low, cosmetic URL-edge notes) remains as a non-blocking note.
- Real-tool evidence was produced by the **parent** on the frozen tree (quoted verbatim below and
  clearly separated from what p7 itself executed).

## Implemented code reviewed (paths)

- `shared/contracts.mjs` — `tagListSchema` (now exported), `normalizeSiteDomain`,
  `siteDomainLabel`, `siteDomainLink`, `siteDomainSchema`, `siteSchema`.
- `server/store.mjs` — `sites`/`site_jobs` additive tables, `site_jobs_job` index,
  `siteView`/`listSites`/`getSite`/`saveSite`/`deleteSite`, `inTransaction`.
- `server/app.mjs` — `GET/POST /api/sites`, `GET/PATCH/DELETE /api/sites/:id` after the
  admin/CSRF middleware.
- `web/src/nav.ts`, `types.ts`, `App.vue`, `style.css`, `components/SitesView.vue`,
  `components/SiteEditor.vue`, `components/TagInput.vue`.
- `tests/sites.test.mjs`, `scripts/check-browser.mjs`, `scripts/check-layout.mjs`.

## Verified evidence (run in this worktree)

- `npm run check` → exit 0 (earlier transient failure during mid-edit is gone; re-run at
  integration because the tree is shared).
- `npm run build` → success (1607 modules; site shared-contract import bundles cleanly).
- `node --test tests/sites.test.mjs` → 9/9 pass at that moment (before the later additions), incl.
  many-to-many both directions, atomic rejection leaving prior state, PATCH merge/replace/clear,
  401/403/404, delete-site preserves jobs/runs/other links, delete-job cascades with system/active
  protections, legacy-DB upgrade, current + old real system-restore, fragments preserved, and
  `PRAGMA foreign_key_check` empty. The file has since grown to **10** tests (one `liveTools`-gated
  real export/import, below); final count comes from the parent's sequential run.

## Findings

### F1 (Medium) Server validation errors are not actionable in the site editor

- Evidence: `server/app.mjs:322` returns Zod failures as
  `{ error: { code:'VALIDATION_FAILED', message:'Check the submitted values.', details:[{path,message}] } }`.
  `web/src/api.ts:27` throws `ApiError(data?.error?.message ...)`, i.e. only the generic
  English message; `ApiError` does not carry `details`. `SiteEditor.vue` only sets field
  errors client-side for empty name, >20 addresses, >10 tags — it does not validate scheme,
  embedded credentials, 2048-char href overflow, or unknown job IDs.
- Impact: entering `ftp://x`, `https://user:pw@host`, or a link whose normalized href exceeds
  2048 chars shows “Check the submitted values.” in a Chinese UI with no field/indication.
  This misses the design's “actionable field errors” (AC2/R8) for server-only rules.
- Suggested owner fix (frontend): carry `details` on `ApiError` (or map in `App.saveSite`)
  and surface the domain/tag/job message inline in `SiteEditor`.

### F2 (Resolved) Address fragments were rejected, now preserved

- Earlier `normalizeSiteDomain` threw on `url.hash`. That was removed; the current shared
  contract preserves a safe same-origin fragment (`https://docs.example.com/guide#install`)
  and `siteDomainLabel` includes it. A dedicated test (`safe URL fragments are preserved
  instead of being rejected`) passes. No action needed; PRD/design/README need no change.

### F3 (Low) Tag editor duplication

- `TagInput.vue` extracts the chip interaction for sites, but `JobEditor.vue` keeps its own
  copy (unchanged). Job-tag behavior is preserved (good), yet the interaction is now duplicated
  rather than shared. Consistent with “preserve current job-tag behavior”; note only.

### F4 (Low, coverage) Reverse site→handler path not exercised end-to-end

- `scripts/check-browser.mjs` asserts the job-detail `.site-links .tag-chip` names exist, but
  never clicks a chip to exercise `App.openSite()` → navigate('sites') → open editor. Forward
  (site→job) is tested. Consider one click assertion for the reverse navigation.

## Positive confirmations (evidence-backed)

- `site_jobs` has `PRIMARY KEY(site_id, job_id)`, both FKs `ON DELETE CASCADE`, and **no**
  `UNIQUE(job_id)` → many-to-many both directions (`server/store.mjs:56-61`).
- `saveSite` validates every `backupJobIds` entry inside one `BEGIN IMMEDIATE` transaction and
  inserts metadata before/with links, so a bad ID rolls back the whole update
  (`server/store.mjs:196-213`); test re-reads authoritative state after rejection.
- Site writes never touch jobs/scheduler/watchers/updatedAt (test asserts job `updatedAt`,
  `enabled`, `schedule` unchanged; design requirement met).
- `deleteJob` leaves timestamps alone and FK cascade removes links (`server/store.mjs:183-187`);
  test asserts site `updatedAt` unchanged after job delete.
- JWT-less auth: site routes sit after `auth.requireAuth, auth.checkOrigin, auth.csrf`
  (`server/app.mjs:110`, routes at 181-193); 401/403 covered by tests.
- Legacy DB: additive `CREATE TABLE IF NOT EXISTS`; test drops site tables, reopens, gets `[]`
  and keeps jobs.
- Restore: test builds a real snapshot bundle and runs `applyPendingSystemRestore`, plus an
  old-snapshot bundle without site tables → empty inventory, jobs kept.
- Frontend: `Page` union + registry include `sites`; single `h1` in App; no `<h1>` in SitesView;
  error/loading/empty/no-match/linked-unlinked states distinct; failed load shows error+retry,
  not empty-success; stale async responses dropped via `sitesRequest`; `typeLabel` now labels
  newapi; job detail shows reverse sites; delete copy states jobs/archives are retained.
- Address contract: bare host→`https://`, host lowercased, path/query case preserved, deduped,
  no DNS/HTTP probe; UI links only `http(s)` with `rel="noopener noreferrer"`.
- Layout script: 7 pages × 4 widths × 2 themes = 56 renders, populated site fixture, explicit
  name/domain/linked-task visibility assertions, and a negative control proving a hidden
  `.site-name` fails the guard.

## Final independent check (trellis-check pass 2, ongoing tree)

Verification snapshot (read-only, run by p7 before the freeze): `npm run check` exit 0; `node --test
tests/sites.test.mjs` 9/9 pass at that time (the file now holds 10, one liveTools-gated — see below);
`node scripts/ui-radius-audit.mjs` pass. Full `npm test`, `check:browser`, `check:layout`
were NOT run by p7 (parent schedules real-tool runs). The tree was still being edited after this
pass (`check-browser.mjs` 7:02, `SiteEditor.vue` 6:58, `SitesView.vue` 6:58, `contracts.mjs` 6:57) —
re-confirm everything on the frozen tree.

### Status of earlier findings

- F1 (generic server validation message): **resolved**. `SiteEditor.vue` validates the whole
payload with the shared `siteSchema.safeParse` and maps issues to actionable Chinese per field,
and now routes failures through `friendlyError`/`rawError` with `SITE_NOT_FOUND` /
`VALIDATION_FAILED` / `SITE_JOB_NOT_FOUND` mapped to Chinese (raw text only as a tooltip).
`web/src/api.ts` still does not surface `error.details`, but the editor no longer needs it for
site flows; any unmapped server code degrades to localized `friendlyError` copy.
- F2 (fragments): resolved, now preserved with a dedicated test.
- F3 (TagInput duplication vs JobEditor): unchanged, acceptable.
- F4 (reverse click coverage): **resolved**. `check-browser.mjs` now clicks a job-detail site chip,
asserts `#sites` and the `编辑站点 · 官网` editor.

### Patch status (assigned fixes, verified by reading the current files only — no checks run)

**N1 (was Medium, R8) — FIXED (p8).** `App.vue refresh()` now starts `loadSites()` and
`loadJobs(silent)` independently (`const sitesPromise = loadSites(); const jobsPromise = loadJobs(...)`)
and awaits both in `finally`, so a failed `/overview`/`/runs` no longer blocks the site read.
`loadJobs` keeps the last good list but sets a new `jobsLoaded` flag false on failure, and a shared
`handleUnauthorized` clears the session once. `SitesView` now receives `loaded` (never assume empty
before `/sites` succeeds) and `jobsLoaded`; `App.vue:326`-style false-empty is gone: `!loaded && !error`
shows the loading line, `loaded && !sites.length && !error` shows the empty state, and an error
overrides both. Residual risk: none found in the read path.

**N3 (was Low) — FIXED (p8).** `SiteEditor.staleJobIds` is gated by `props.jobsLoaded`, so an
unloadable task list no longer marks real links as deleted; the editor shows “任务列表尚未成功加载”
and keeps the draft. `SitesView` reports unresolved ids as `任务信息未同步（N）` / `任务信息待加载（N）`
and never renders “未关联备份任务” for a stored link.

**N2 (type safety) — ADDRESSED at the contract (p4), confirm on freeze.** `shared/contracts.mjs` now
has JSDoc on `normalizeSiteDomain`, `siteDomainLabel`, `siteDomainLink`, `dedupeStrings` and the
tag transform, so `z.infer<typeof siteSchema>` should yield `string[]` for `domains`/`tags`/`backupJobIds`.
`web/src/types.ts` was not changed (still `z.infer`). The `as string[]` / `as SiteInput` casts in
`SitesView.vue` / `SiteEditor.vue` are now redundant but harmless; they do not change runtime
behavior. Confirm with the frozen `npm run check` that inference is real (if it were still `any`,
removing a cast would be needed to expose it).

**F1 residual (English server copy) — FIXED.** `SiteEditor` now routes failures through
`friendlyError`/`rawError` and maps `SITE_NOT_FOUND` / `VALIDATION_FAILED` to Chinese, with the raw
text only as a `title` tooltip (matches the frontend error contract).

**N4 (URL normalization) — unchanged, low.** Positives: host lowercased, default ports collapsed
(`:443`/`:80`), path/query case preserved, IDN punycoded, IPv6 handled, userinfo/unsupported
schemes/control chars rejected, no network probe. Notes: `mailto:x@y.com` is rejected with
“地址不能包含用户名或密码。” (parsed as `https://mailto:x@y.com`) — rejected but misleading;
`example.com/#` keeps `#` in the href while the label drops it; `example.com.` (trailing dot) is not
deduped against `example.com` (design only requires dedupe of identical normalized hrefs).

**p6 evidence additions — verified by reading.** Browser now has N1/N3 regressions: failed
`/overview` still lists sites with no empty state and a manual refresh keeps the rows; failed
`/jobs` shows the stored link count, `任务信息待加载`, no “未关联备份任务”/“已被删除”, keeps the link
in the editor draft, never drops it on an attempted save, and replaces the marker after recovery.
Layout keeps the single shared `assertSiteVisibility` and injects three separate faults
(name/domain/job) via `assert.throws`, then `assert.doesNotThrow` once removed.


### Evidence credibility check (positive)

- `tests/sites.test.mjs`: real express + native SQLite + real `applyPendingSystemRestore`; covers
  many-to-many both ways, atomic rejection leaving prior state, PATCH merge/replace/clear,
  401/403/404, delete-site preserves jobs/runs/other links, delete-job cascades with system/active
  protections and no `updatedAt` rewrite, legacy-DB upgrade (now also creates a site post-upgrade
  and re-checks FK), current+old snapshot restore, and `PRAGMA foreign_key_check` empty after each
  lifecycle. **New 10th test (liveTools-gated)**: real rclone alias + real 7-Zip, production
  system-job export (snapshot + encrypted 7z + upload) → download → production
  `stageSystemRestore` → `applyPendingSystemRestore` → reopen store → asserts the exact site
  (domains/tags/links), the linked job, and FK integrity. This is credible end-to-end restore
  evidence rather than a mock; p7 must not run it (real tools) — the parent runs it sequentially.
- `scripts/check-layout.mjs`: 7 pages × 4 widths × 2 themes = 56 renders; single shared
  `assertSiteVisibility` used in the matrix AND in three separate fault injections via
  `assert.throws` (name/domain/job label), then `assert.doesNotThrow` after removal — the guard is
  proven able to fail rather than print-only.
- `scripts/check-browser.mjs` site block: empty → create via real editor → shared job across two
  sites → failed GET shows error+retry and no stale rows → reverse chip navigates and opens the
  editor → forward task opens detail → domain search / no-match / tag filter → background poll
  keeps the open draft → failed save keeps values → unlink keeps the job and other site's link →
  delete site keeps task + `passwordSet` → reload persistence → 390/360/768 screenshots.

## FINAL verdict (frozen tree) — PASS AC1–AC6

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC1 (nav + page shell, single title, real CRUD wiring) | **PASS** | `nav.ts` explicit `Page` union includes `'sites'` + registry row `站点管理` (`Globe`, group 工作区); `App.vue:383` renders `<SitesView v-else-if="page === 'sites'">` with `loaded/jobsLoaded/loading/error/errorDetail` wired to real `loadSites`; single `h1` via the registry; real `GET/POST/GET:id/PATCH/DELETE /api/sites*` routes behind `requireAuth+checkOrigin+csrf`. Parent: check:browser full site lifecycle + reverse click navigation; check:layout 7×4×2 asserted renders incl. the sites page. |
| AC2 (shared validation client+server, canonical storage, safe links) | **PASS** | One boundary `shared/contracts.mjs` (`siteSchema`/`siteDomainSchema`/`normalizeSiteDomain`/`siteDomainLink`) used by both server routes and `SiteEditor` (`siteSchema.safeParse` + per-field Chinese). Store round-trips exact saved values (test asserts `deepEqual` after reopen). Bare host→https, host lowercased, default ports collapsed, path/query case preserved, IDN punycoded, IPv6 handled, userinfo/unsupported scheme/path-only/port-0/empty-label/control-char rejected, no DNS/HTTP probe; 20 domains × ≤2048. Parent: sites tests (10, one real-tool) all pass. |
| AC3 (many-to-many both directions, atomic writes) | **PASS** | `site_jobs` composite PK `(site_id,job_id)`, both FKs `ON DELETE CASCADE`, `site_jobs_job` index, no `UNIQUE(job_id)`; `saveSite` merges PATCH → validates all job IDs inside `BEGIN IMMEDIATE` → rolls back on any bad ID, leaving prior metadata/timestamp/links intact. Tests: two sites share a job, one site several jobs, PATCH merge/replace/clear, authoritative read after rejected write. Parent: browser creates the shared two-site case and unlinks without touching the other site. |
| AC4 (search/filter/reverse navigation/search-empty) | **PASS** | `SitesView` filters by name/domain/site-tag, shows a distinct no-match state; site tag filter independent of job tags; job detail lists linked sites and clicking a chip jumps to `#sites` + opens `编辑站点 · <name>`. Parent: check:browser reverse chip navigation → forward detail, search/no-match/tag filter, and the F4 reverse path now asserted. |
| AC5 (persistence, legacy upgrade, restore, delete safety) | **PASS** | Reopen persistence; legacy DB without site tables upgrades additively (then creates a site + FK check); current and pre-site snapshots restore through real `applyPendingSystemRestore` (old → empty inventory, jobs preserved); delete-site keeps jobs/runs/archives/other links; delete-job cascades links only, no `updatedAt` rewrite, system/active protections intact; `PRAGMA foreign_key_check` empty after each. Parent: **real encrypted system export → download → production staged import → restore** round-tripped the exact site (domains/tags/links) + linked job + FK check. |
| AC6 (quality gates on frozen tree) | **PASS** | Parent ran the serial real-tool suites on the frozen tree (quoted in the next section); p7's own read-only runs are marked separately. Visible labels readable, layout clean per parent's screenshot inspection (desktop-sites/editor, sites-360, light1440-sites, dark360-sites, light390-sites). |

**Remaining blocker: none.**

## Evidence provenance (who ran what)

### Run by the parent (frozen tree) — authoritative for AC6, NOT executed by p7

Quoted exactly as supplied:

- `npm test` with absolute real tools + `RUN_BACKUP_INTEGRATION=1`: **91 total, 90 pass, 0 fail,
  1 intentional Windows symlink skip, 156789 ms**; the real encrypted sites system
  export/download/stage/import test passed.
- Final `npm run check` and `npm run build`: pass.
- `npm run check:browser`: **57 screenshots, browserErrors=[], 3 actual encrypted backups**, SMTP/
  download/watch/login plus full site lifecycle / reverse click / error retry / draft / N1 / N3
  scenarios.
- `npm run check:layout`: **7×4×2 = 56 asserted renders, 60 screenshots**, overview 8/8 with 22/22
  named rows; populated sites across 8 combinations with real guard-throw controls for
  name/domain/job.
- `ui-radius-audit` and `git diff --check`: pass.
- Parent visually inspected `desktop-sites`/editor, `sites-360`, `light1440-sites`, `dark360-sites`,
  `light390-sites`: labels readable, layout clean.

### Run by p7 (earlier, pre-freeze tree — superseded by the parent's frozen-tree runs)

- `npm run check` exit 0; `node --test tests/sites.test.mjs` 9/9 at that time (file later grew to 10);
  `node scripts/ui-radius-audit.mjs` pass; `git diff --check` clean (CRLF warnings only).
- p7 did **not** run full `npm test`, `check:browser`, or `check:layout`, and did not run the real
  encrypted export/import test; those are parent-run above.

## Confirmed on the frozen tree by reading (final pass)

- **N1 fixed, incl. refresh lock/dispatch:** `refresh()` starts `loadSites()` and `loadJobs(silent)`
  as independent promises, releases `refreshing` only after `await Promise.all([jobsPromise,
  sitesPromise])`, and clears the global notice only when nothing failed — so a `/jobs` failure is
  not erased by an unrelated `/overview` success, and a slow read cannot overlap the next
  poll/refresh. `SitesView` still distinguishes never-loaded (loading line) from loaded-empty.
- **N3 fixed:** `jobsLoaded` gates `staleJobIds`/association rendering; unresolved ids show
  `任务信息待加载/未同步（N）`, never “未关联备份任务” or “已被删除”, and drafts keep their links.
- **N2 fixed:** `shared/contracts.mjs` now JSDoc-types `dedupeTags`, `dedupeStrings`,
  `normalizeSiteDomain`, `siteDomainLabel`, `siteDomainLink`; `types.ts` keeps
  `SiteInput = z.infer<typeof siteSchema>` + `Site extends SiteInput`, so `domains/tags/backupJobIds`
  are `string[]` and the former `as string[]`/`as SiteInput` casts are redundant (harmless).
- **Contract hardening beyond earlier notes:** path-only inputs (`/foo`, `https:///foo`) now
  rejected instead of being misread as a host; port `0` rejected; empty DNS labels (`.com`,
  `a..b.com`) rejected; single trailing dot (FQDN) and IPv6 literals still allowed.
- **Logout/session safety:** logout bumps `sitesRequest`, clears sites/link state and closes editors,
  so an in-flight read cannot repopulate a signed-out session.
- **Specs match code:** `backend/backup-lifecycle.md` (site section: signatures, `site_jobs`
  composite key + no `UNIQUE(job_id)`, merge→validate→transaction, error matrix, real-archive test
  requirement) and `frontend/ui-api.md` (hash nav now includes `sites`, explicit `Page` union +
  registry, `errors.ts` convention) are accurate as written.

## Non-blocking notes (do not gate the verdict)

- **N4 (low, URL edge copy):** `mailto:x@y.com` is rejected but with the userinfo message
  (“地址不能包含用户名或密码。”); `example.com/#` keeps `#` in the href while the label drops it;
  `example.com.` (FQDN trailing dot) is not deduped against `example.com` (design only requires
  dedupe of identical canonical hrefs). All are rejected-or-benign, not data-safety issues.
- `web/src/api.ts` still does not surface `error.details`, but site flows no longer need it (the
  editor validates locally and maps codes to Chinese), so this is a general-purpose improvement
  outside this task's scope.
- `frontend/ui-api.md` does not list `SitesView`/`SiteEditor`/`TagInput` in its component-signature
  list; the page-level contracts are captured, so this is a completeness nit for a future spec pass.
