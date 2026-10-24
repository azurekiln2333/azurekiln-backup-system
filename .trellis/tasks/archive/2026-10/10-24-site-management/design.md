# Design: site inventory with many-to-many backup jobs

## Approved requirement and proposed record behavior

The user explicitly chose many-to-many: a site can link database/configuration/file jobs and a shared database job can link several sites. The user approved the complete plan on 2026-10-24; it is now implemented and verified: sites have multiple domain/access addresses, may initially have no address or job, use independent tags for classification, and expose existing jobs rather than new execution controls.

## Change boundary

The current gap is inventory organization: jobs exist, but no site record connects a name/domain to related jobs. Add shared validation, additive persistence, authenticated CRUD, and one new page with an editor. Leave backup scheduling, executors, credentials, source paths, destinations, and histories as they are.

Expected paths:

- `shared/contracts.mjs`: reusable existing tag-list validation and the site input contract.
- `server/store.mjs`: additive site/relation tables, atomic CRUD, sanitized relation projections and cascade-only link cleanup.
- `server/app.mjs`: sites routes behind the existing authentication/CSRF middleware.
- `web/src/types.ts`, `nav.ts`, `App.vue`: types, sites navigation, real API state/mutations, site editor lifecycle and reverse associations in existing job detail.
- New `SitesView.vue` and `SiteEditor.vue`: list/filters and editing, using existing Modal/panel/styles.
- `web/src/style.css`: only necessary wrapping/responsive site styles. Extract a tag input only if the existing interaction would otherwise be duplicated substantially; preserve current job-tag behavior.
- `tests/api.test.mjs`, focused site persistence/restore tests, `scripts/check-browser.mjs`, `scripts/check-layout.mjs`: meaningful cross-layer verification.
- Relevant frontend/backend spec docs and concise README feature documentation after verification; no deployment rewrite in this task.

## Data contract

```text
SiteInput {
  name: string,
  domains: string[],
  tags: string[],
  backupJobIds: string[]
}
Site = SiteInput + { id: string, createdAt: string, updatedAt: string }
```

- Names are trimmed, required and bounded, following the existing 100-character name convention. IDs/timestamps are server-owned.
- Domain entries accept a bare host or HTTP(S) access address (including an explicitly supplied port/path). Bare hosts use HTTPS. Normalize to an HTTP(S) URL href at the shared-schema boundary; trim, normalize the hostname/default port through the URL parser, deduplicate identical normalized hrefs, reject unsupported schemes and embedded username/password, and never perform DNS/HTTP checks while validating. Preserve case-sensitive URL path/query semantics. Both display and href generation consume this contract instead of independently reparsing untrusted strings.
- Addresses may be empty initially; allow up to 20 entries, each at most 2048 characters, with matching API/UI limits and actionable field errors. A domain need not be globally unique because shared hosts/path-based sites can be legitimate.
- Reuse the existing tag list rules (10 labels, 1-32 characters, case-insensitive deduplication retaining first spelling). Site tags have no foreign-key relationship to job tags.
- Deduplicate job IDs, with a bounded input of 200 entries of 1–100 characters. All IDs must exist before any metadata/link update commits. Existing paused/offline jobs remain eligible; a relation does not require running or probing the job. Allow the built-in system task as clearly labeled metadata rather than silently excluding an existing task type.

## Single authoritative relation and migration

Add these tables in the store's existing startup initialization after jobs exists:

```text
sites(id PRIMARY KEY, data JSON text)
site_jobs(
  site_id REFERENCES sites(id) ON DELETE CASCADE,
  job_id REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY(site_id, job_id)
)
index site_jobs(job_id)
```

Do not add `UNIQUE(job_id)`. Site JSON holds metadata/timestamps; `backupJobIds` is projected from the relation table, not duplicated in stored JSON or job JSON. Derive reverse associations from the same live sites response in App.

Site metadata plus replacement association set is a single store-owned SQLite transaction. Validate references first; if any update fails, roll back all changes and leave the old record/links intact. Follow existing merge behavior for PATCH: omitted fields retain their value, supplied arrays replace their set, empty arrays clear it. Avoid applying schema defaults to the partial patch before merging.

Old databases gain empty tables idempotently; old jobs are untouched. System backup already snapshots the full SQLite state and startup restores the database before opening the store. No separate `sites.json`, new archive format, or backup-executor branch is needed. Verify real snapshot/import behavior plus `PRAGMA foreign_key_check`; do not require new tables when validating an old archive.

## API boundary

- `GET /api/sites` -> sanitized `Site[]`.
- `POST /api/sites` -> 201 and saved `Site`.
- `GET /api/sites/:id` -> `Site` or existing-style 404.
- `PATCH /api/sites/:id` -> authoritative saved `Site`; merge/validate before one transaction.
- `DELETE /api/sites/:id` -> 204, metadata/links only.

Use existing wrap/error/Zod handling under administrator middleware. Mutations require current CSRF. Unknown association IDs return a stable actionable error with no partial write. Site APIs return IDs, not embedded private job records or credentials.

Site writes do not refresh the scheduler, toggle watchers, execute backups, or rewrite job timestamps. Job deletion retains existing active-job/system-task protections and archive/history behavior; FK cascade removes only link rows.

Site `updatedAt` records explicit site saves. Automatic unlink after deleting a job does not rewrite site metadata timestamps; the authoritative response always projects current links. App must refresh/reconcile sites after a job deletion and must not infer relation freshness from `updatedAt` alone.

## Frontend flow

1. Add `sites` to the explicit Page union and navigation registry under workspace. App's existing shell owns the single `站点管理` h1.
2. App loads sites as authoritative API data with its own loading/error state, resets it on logout, and reconciles current editor/selection after refresh. A site-load failure must not discard valid jobs/overview data. Avoid stale async responses overwriting newer mutations.
3. SitesView receives sites, sanitized jobs, and current run information; it emits create/edit/remove/open-job events. It owns local name/domain/tag search and site-tag filtering. An API failure, empty inventory, and no filter matches have separate states.
4. A panel-contained list shows name, wrapping domain links, site-tag chips, and actual linked job names/type/status. Counts may supplement names but cannot replace them. Long domains and shared job names must stay visible at 360px.
5. SiteEditor uses existing Modal/form primitives. Name is required; addresses and tags support adding/removing entries; a searchable multi-select lists existing jobs with name/type/source. Editing a shared job association must not remove another site's selection. Save failures keep entered values.
6. Clicking a linked task opens the existing job detail/version UI. Task detail displays its current associated sites using the same relation data; site association editing stays in SiteEditor to avoid unrelated changes to backup settings forms.
7. Delete copy explicitly says the site record/associations will be removed and backup jobs/history/archives are retained. Unbinding uses the same relation-only rule. Domain links open only safe HTTP(S) targets; no remote favicon/probe dependency.

Use tags as lightweight classification; do not add a second category tree or overload existing one-bucket job grouping with multi-site membership.

Implementation cautions from plan review: App's existing job-type formatter must explicitly handle newapi when reused for linked-task types (its fallback currently labels it as a directory backup). Refreshing site data may reconcile selection/read-only detail, but must not replace a mounted editor's unsaved cloned values. Browser/layout checks must await loaded populated labels rather than treat an h1 plus fixed delay as proof of rendered associations.

## Verification and release boundary

Backend tests cover shared job bindings, transactional rejection, idempotent migration, reload/restart, partial PATCH preservation, cascade unlink, job immutability, auth/CSRF, public payload safety, and current/old system restore. API assertions must inspect authoritative saved state after failures.

Real browser tests create isolated sites/jobs and exercise the full lifecycle, shared links, filtering/search, reverse detail mapping, failure preserving values, deletion keeping jobs, and persisted reloads. Extend the layout matrix to seven pages x four widths x two themes (56 renders), including populated sites with meaningful label visibility assertions. Retain existing shell/task-row guards and run the radius audit.

No live production server access or GitHub push is required to verify this feature. Keep the separate image/deployment plan intact and report its outstanding approval/technical work independently.
