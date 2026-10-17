# Design: jobs-batch-grouping

## 1. Boundaries

| Area | Files | Owner |
|---|---|---|
| Backend batch API + tags | `shared/contracts.mjs`, `server/app.mjs`, `server/store.mjs` | this task (already landed in baseline `f7d558e`) |
| Editor batch UI + tag chips | `web/src/components/JobEditor.vue` | this task (baseline `8d219a8`) |
| Grouping composable | `web/src/jobGroups.ts` (new) | this task |
| Jobs list view | `web/src/components/JobsView.vue` (new) | this task |
| Wiring the view in | `web/src/App.vue` (minimal, after SHELL-DONE) | this task, minimal edit only |
| Grouping styles | `web/src/style.css` (after SHELL-DONE, append-only) | this task, minimal edit only |
| Shell/theme chrome | `web/src/App.vue`, `web/src/style.css` | ui-shell (p3) — do not touch before SHELL-DONE |

New files carry the bulk of the work to minimize conflict surface with the other three panes.

## 2. Data model additions (already merged)

- `jobSchema.tags`: `string[]`, max 10, each trimmed 1–32 chars, no `,`/CR/LF/NUL, case-insensitive dedupe keeping first spelling, default `[]`.
- `store.listJobs`/`getJob` default `tags: []` so pre-tag rows read cleanly (no migration needed; tags live inside the `data` JSON blob).
- `batchJobSchema`: `{ parentPath, folders[], nameTemplate, template }`; `folders` ≤ 100 unique single-segment names; `nameTemplate` must contain `{folder}`.
- `POST /api/jobs/batch` semantics: `sourcePath = join(parentPath, folder)`, `name = nameTemplate.replaceAll('{folder}', folder)`, every `template.destinations[].path` gets `/<folder>` appended after stripping trailing slashes. All jobs are validated first (`validateJob`, which enforces `SOURCE_ROOTS` containment, existence, encryption password) and checked against existing directory tasks by `sourcePath` (409 `JOB_SOURCE_EXISTS`); nothing is saved unless every folder passes. Returns `201` with the created job DTOs.

## 3. Grouping design

### 3.1 Group strategy (`web/src/jobGroups.ts`)

```ts
export type GroupMode = 'none' | 'tag' | 'type' | 'source';
export interface JobGroup { key: string; label: string; jobs: Job[]; failed: number; }
export interface GroupOptions { mode: GroupMode; match: (job: Job) => boolean; }
export function groupJobs(jobs: Job[], { mode, match }: GroupOptions): JobGroup[]
```

Rules:

- `mode: 'none'` → one group keyed `all`, label unused by callers (JobsView renders a flat table). Implemented as a single group so JobsView has one code path.
- `mode: 'tag'` → preferred key is each job's **first** tag (tags are ordered, and batch creation puts the shared tag first). Untagged jobs fall into a `__untagged` group labelled `未分组`.
- `mode: 'type'` → `directory` / `vaultwarden` / `system` with Chinese labels (`目录备份` / `Vaultwarden` / `系统配置`), ordered directory → vaultwarden → system.
- `mode: 'source'` → `path.posix.dirname(job.sourcePath)` for directory jobs; `job.vaultwarden.dataDir`'s parent for vaultwarden; `本系统配置` for system. Client-side dirname so no Node `path` import lands in the browser bundle.
- Groups are sorted by label with `localeCompare` (`zh` collation), `__untagged` last.
- `match` is applied **before** grouping so search/enable/tag filters and grouping compose. Group counts therefore reflect the filtered set, while `jobs.length` drives the "no matches" vs "no jobs" empty state.
- `failed` counts jobs whose `lastRun.status === 'failed'` — shown in the group header.

### 3.2 Collapse state persistence

```ts
export function readCollapsed(storage: Storage | undefined, mode: GroupMode): Set<string>
export function writeCollapsed(storage: Storage | undefined, mode: GroupMode, collapsed: Set<string>): void
```

- `localStorage` key `backup-job-groups:${mode}` → JSON array of group keys.
- Every read/write is wrapped in `try {} catch {}`; a `localStorage` that throws (privacy mode, quota) must never break rendering. `undefined` storage (SSR/test) returns an empty set and write is a no-op.
- Mode is part of the key so collapsing "mysql" under tag grouping does not collapse "目录备份" under type grouping.

### 3.3 Search interaction

When `search` is non-empty, groups render expanded regardless of persisted collapse state (a hit inside a collapsed group would otherwise be invisible). The persisted state is preserved untouched and reapplies when the search clears. `expandAll`/`collapseAll` write to the persisted set only for the current mode.

## 4. JobsView component

Props/emits (keeps App.vue the single owner of data & mutations, so no store is introduced):

```ts
defineProps<{ jobs: Job[]; overview?: Overview; busyId: string; activeJob: (id: string) => boolean; canRunJob: (job: Job) => boolean }>();
defineEmits<{ create: []; open: [job: Job]; run: [job: Job]; edit: [job: Job]; remove: [job: Job]; toggle: [job: Job]; toggleWatch: [job: Job] }>();
```

Owned local state: `search`, `jobFilter`, `tagFilter`, `groupMode`, `collapsed`.

- `search`/`jobFilter`/`tagFilter` move **out** of App.vue into JobsView (App.vue keeps no other consumer of them — verified: `filteredJobs` is only used by the jobs page).
- Table markup is moved verbatim from App.vue so column layout, `aria-label`s and `check-browser.mjs` selectors (`.jobs-table tbody tr`, `.job-primary`, `按标签筛选`, `启用 ${name}` etc.) keep working.
- Grouped rendering: one `<tbody>` per group, each preceded by a group header row `<tr class="group-row">` containing a chevron toggle button (accessible `aria-expanded`), the label, the count, the failure count when non-zero, and per-group expand/collapse.
- **No duplicate headings**: the group header shows only the group name + counts. JobsView does not render the page `<h1>` (App.vue's `page-heading` owns it) and does not repeat a "备份任务" title. The toolbar shows only controls.
- The "no duplicate element" rule also means the existing `任务 / 来源` table header stays the single column header even when grouped; group rows are visually distinct (banded) and carry no column-header text.

`sourcePath(job)` / `typeLabel` / `watchLabel` / `statusLabels` / `shortTime` are needed. `sourcePath` and `typeLabel` currently live in App.vue. Plan: re-implement the two tiny pure functions inside JobsView (guarded by the existing `format.ts` import for the rest) rather than exporting them from App.vue, which would force a `<script>` restructure in a file ui-shell is rewriting. Duplication is 2 one-liners; acceptable and explicitly noted in the spec update.

## 5. Batch tag default

`JobEditor` already exposes a tag input. For R2's "batch tasks cluster naturally", the batch form pre-fills the tag list from the parent folder name:

- On enabling batch mode and after loading subfolders, if `form.tags` is empty, set `form.tags = [basename(parentPath).slice(0, 32)]`.
- Implemented with a pure helper `batchTag(parentPath)` inside JobEditor; user can edit or clear it before saving (requirement: "可在批量创建表单里取消/修改").
- Guard: only auto-fill when the tag list is empty, so a user-chosen tag is never overwritten.

## 6. App.vue wiring (gated on SHELL-DONE)

Replace the `<template v-else-if="page === 'jobs'">…</template>` body with:

```html
<JobsView v-else-if="page === 'jobs'" :jobs="jobs" :overview="overview" :busy-id="busyId" :active-job="activeJob" :can-run-job="canRunJob"
  @create="createJob()" @open="openJob" @run="runJob" @edit="edit" @remove="deleting = $event" @toggle="toggleJob" @toggle-watch="toggleWatch" />
```

Delete now-unused App.vue locals (`search`, `jobFilter`, `tagFilter`, `allTags`, `filteredJobs` watchers) and unused icon imports. `createJob()` is kept because the page header and overview still use it. If ui-shell has already removed those locals or restructured the toolbar, adapt to whatever it left and keep the edit minimal.

## 7. Tradeoffs

- **Client-side grouping vs. server grouping**: grouping over the already-fetched `jobs` array is simpler, instant, and needs no new API. Cost: with very many tasks the client holds them all — already the case for the jobs list today (no pagination), so no regression. 100+ tasks render fine with collapsed groups.
- **First tag as group key vs. showing a job in every tag group**: showing one job in several groups makes counts lie and the row repeat (violates "no duplicate elements"). First-tag wins, and batch creation guarantees the shared tag is first.
- **Separate `__untagged` group vs. hiding untagged jobs**: hiding would lose data. A labelled group is explicit.
- **App.vue-local helpers duplicated vs. exported**: duplication of two one-liners beats restructuring a file another pane owns.

## 8. Compatibility / rollback

- No API or schema change in this design phase; baseline commits already changed the DTO additively (`tags` defaults to `[]`), so old stored jobs and old clients keep working.
- `JobsView`/`jobGroups` are additive files: reverting the App.vue wiring alone (one commit) restores the previous list UI with no data impact.
- `localStorage` key is namespaced; a corrupt value is swallowed and treated as "nothing collapsed".
