# Implement: jobs-batch-grouping

Owner pane: `w1H:p2`. Dev port: **16401**. Temporary data dir: `.tmp/p2/` (never `.data/`).

## Ordering constraint

Phase 0 is **blocking** for the other three panes. Everything else waits on the shared-file rule:
`App.vue` / `style.css` may not be modified until `board.md` contains `SHELL-DONE`.

---

## Phase 0 — Baseline commits (DONE)
- [x] Read the full WIP diff; confirmed it is self-consistent (contracts → store → app → JobEditor → App → tests → docs).
- [x] `npm run check` green.
- [x] `npm test` green in isolation (one `executor.test.mjs` case is timing-flaky under 4 concurrent test processes; passes alone).
- [x] `npm run build` green.
- [x] Four path-scoped standardized commits:
  - `f7d558e feat(jobs): add task tags and batch creation API` — `shared/contracts.mjs`, `server/app.mjs`, `server/store.mjs`
  - `8d219a8 feat(web): add tag chips and batch add mode to job editor` — `web/src/components/JobEditor.vue`, `web/src/App.vue`, `web/src/style.css`
  - `dc37b52 test: cover job tags and batch creation in API and browser` — `tests/api.test.mjs`, `scripts/check-browser.mjs`
  - `b0e7024 docs: document task tags and batch directory creation` — `README*`, `.trellis/spec/**`
- [x] `BASELINE-DONE` written to `board.md`.

Rollback point: `486bc91` (pre-baseline `main`).

---

## Phase 1 — Planning artifacts

- [x] `design.md` (grouping composable, JobsView contract, batch tag default, tradeoffs).
- [x] `implement.md` (this file).
- [x] `implement.jsonl` / `check.jsonl` curated.
- [x] `task.py start`.

---

## Phase 2 — Implementation

### Step 1: `web/src/jobGroups.ts` (new, no shared-file risk)

- [ ] `type GroupMode = 'none' | 'tag' | 'type' | 'source'`.
- [ ] `groupJobs(jobs, { mode, match })` — filter by `match` first, then bucket:
  - `none` → single `all` group;
  - `tag` → first tag, `__untagged` last;
  - `type` → directory/vaultwarden/system, fixed order;
  - `source` → client-side dirname of the source path.
- [ ] Per-group `failed` count from `lastRun.status === 'failed'`.
- [ ] `localeCompare` sort (`zh`), `__untagged` forced last.
- [ ] `readCollapsed(storage, mode)` / `writeCollapsed(storage, mode, set)` with `localStorage` key `backup-job-groups:${mode}`, every access inside `try/catch`, tolerate `undefined` storage.
- [ ] Export a `groupModeLabels` map for the toolbar select.

Validation after this step: `npm run check`.

### Step 2: `web/src/components/JobsView.vue` (new)

- [ ] Move the jobs-page template out of `App.vue` **verbatim** (toolbar, empty states, `.table-wrap.jobs-table`, all `aria-label`s) so browser checks keep passing.
- [ ] Own local state: `search`, `jobFilter`, `tagFilter`, `groupMode` (persisted under `backup-jobs-group-mode`), `collapsed` (via `readCollapsed`/`writeCollapsed`).
- [ ] Toolbar gains a `分组方式` select (`不分组 / 按标签 / 按类型 / 按源父目录`) next to the existing enable segmented control and tag select.
- [ ] Grouped rendering: `<tbody v-for="group in groups">` with a leading header row carrying `aria-expanded` chevron toggle, label, count, and failure count when non-zero. Header row must **not** duplicate column-header text or the page title.
- [ ] Search non-empty ⇒ groups force-expanded (persisted collapse state untouched, reapplies when search clears).
- [ ] `全部展开` / `全部折叠` controls in the toolbar, active only when `groupMode !== 'none'`.
- [ ] Emits: `create`, `open`, `run`, `edit`, `remove`, `toggle`, `toggleWatch`. No API calls inside the component.
- [ ] Local `sourcePath(job)` / `typeLabel(type)` one-liners (App.vue's copies stay untouched to avoid restructuring a file p5/p3 own).

Validation: `npm run check`.

### Step 3: batch tag default in `JobEditor.vue` (owner: this pane)

- [ ] `batchTag(parentPath)` helper → `basename(parentPath).slice(0, 32)`.
- [ ] When batch mode turns on and `form.tags` is empty, seed `form.tags = [batchTag(parentPath)]`. Re-seed when the parent path changes **only if** the current tag still equals the previous auto tag (never clobber a user edit).
- [ ] Existing tag chips UI already lets the user edit/remove it.

Validation: `npm run check` + `npm test` (tags assertions already exist).

### Step 4: automated 100+ task grouping coverage

- [ ] Extend `tests/api.test.mjs` (or a new `tests/job-groups.test.mjs` for the pure composable) with:
  - [ ] `groupJobs` unit cases: each mode, untagged bucket, failure counting, `match` composition, sort order.
  - [ ] `readCollapsed`/`writeCollapsed` round-trip, corrupt JSON tolerance, throwing-storage tolerance.
  - [ ] 100+ generated jobs → grouping returns bounded group counts and no job loss (`groups.flatMap(g => g.jobs).length === jobs.length`).
- [ ] If a DOM-level test is not possible in this repo's harness, cover the 100+ requirement at the composable level and assert the browser check renders all groups.

Validation: `npm test`.

### Step 5: **Gated** — wait for `SHELL-DONE` in `board.md`

- [ ] Poll `board.md`. While waiting, complete Steps 1–4, plus README/spec text.
- [ ] On `SHELL-DONE`: read the *current* `App.vue` and `style.css` (p3 will have rewritten them).
- [ ] Minimal `App.vue` edit only:
  - [ ] import `JobsView`; replace the `<template v-else-if="page === 'jobs'">` body with `<JobsView … />`;
  - [ ] delete now-dead locals (`search`, `jobFilter`, `tagFilter`, `allTags`, `filteredJobs`, related `watch`);
  - [ ] drop icon imports that became unused (keep whatever the shell still needs; let `vue-tsc` decide).
- [ ] Minimal `style.css` edit: append grouping styles only (`.group-row`, `.group-toggle`, `.group-count`, `.group-failed`, `.group-band`), using the shell's existing CSS variables. No restyling of existing classes.
- [ ] Commit immediately after wiring (`feat(web): wire grouped jobs view into console`), path-scoped to `web/src/App.vue`, `web/src/style.css`, `web/src/components/JobsView.vue`.

Validation: `npm run check`, `npm run build`, `npm run check:browser`.

### Step 6: browser verification (port 16401)

- [ ] Before changing anything visible: screenshot baseline into `.artifacts/p2-before/`.
- [ ] Run the app on **16401** with temp data under `.tmp/p2/`.
- [ ] Real a/b/c flow through the UI: create `a`, `b`, `c` under a `crontab_backup`-like parent, use batch mode, assert 3 tasks, each with its own destination suffix, and that they land in one tag group.
- [ ] Verify: group-by switching, collapse persistence across reload, search auto-expand, 100+ task list, no duplicate headings, no duplicated elements. Screenshots into `.artifacts/p2-after/`.
- [ ] `npm run check:browser` green (it drives the batch flow added in the baseline).
- [ ] Do not touch `.data/`.

### Step 7: docs

- [ ] `.trellis/spec/frontend/ui-api.md` — record the JobsView contract, grouping modes, collapse persistence, and the deliberate two one-liner helpers.
- [ ] `README.md` / `README.en.md` / `README.zh-TW.md` — task-list grouping + collapse, and the batch auto-tag behaviour.

---

## Validation commands (run before each commit)

```
npm run check
npm test
npm run build
npm run check:browser      # only for UI-visible changes; port 16401
```

`npm --silent run check` and `npm run build` are fast; `npm test` takes ~140 s and one
`executor.test.mjs` case is timing-flaky when four test processes run concurrently —
re-run the single file before concluding a regression.

---

## Commit plan (path-scoped, immediate, never `-a`)

| # | Message | Files |
|---|---|---|
| 1 | `feat(web): extract job grouping composable` | `web/src/jobGroups.ts` |
| 2 | `feat(web): add grouped collapsible jobs view` | `web/src/components/JobsView.vue`, `web/src/style.css`* |
| 3 | `feat(web): prefill batch tag from parent folder` | `web/src/components/JobEditor.vue` |
| 4 | `test(jobs): cover grouping modes and collapse persistence` | `tests/job-groups.test.mjs` |
| 5 | `feat(web): wire grouped jobs view into console` | `web/src/App.vue`, `web/src/style.css` |
| 6 | `docs: document job grouping and collapse behaviour` | `README*`, `.trellis/spec/frontend/ui-api.md` |

`*` `style.css` writes are held until `SHELL-DONE`; commit 2 lands the component first and
groups the styles with commit 5 if the shell is still in flight.

---

## Review gates

1. After Step 1+2: `npm run check` green, composable unit tests green.
2. After Step 5: full `check` + `build` + `check:browser` green, before/after screenshots inspected.
3. Final: full-scope quality check per `.trellis/spec/frontend/index.md` Quality Check, then commit.

## Rollback points

- Before wiring: delete `JobsView.vue`/`jobGroups.ts` — zero production impact.
- After wiring: revert the single wiring commit; the previous inline list returns.

---

## Outcome (completed)

All steps above landed. Deviations from the plan, and why:

| Plan item | What actually happened |
|---|---|
| Step 5 gate | Waited for `SHELL-DONE`; during the wait, `JobsView` was exercised in a standalone Vite harness on port 16401 (`.tmp/p2/harness`, since removed) so grouping/collapse could be validated in a real browser without touching `App.vue`. |
| Styles in `style.css` | Deliberately moved to a new `web/src/jobs-groups.css` + a one-line import in `main.ts`, so `style.css` (owned by the ui-shell pane) was never edited. Later converted 3 raw radii to `var(--radius-md)` / `var(--radius-pill)` after the shell added the tokens. |
| Step 4 DOM coverage | Grouping covered by `tests/job-groups.test.mjs` (10 cases, incl. 137-task no-loss/no-duplicate) plus a real-browser harness run. A committed DOM test was not added: the repo's test harness is `node --test` without a DOM, and `check:browser` covers the wired page. |
| check sub-agent | The dispatched review was interrupted mid-run (it hit an environment `tar` PATH issue, unrelated to this task). The equivalent review was done in-session: a real-browser run of the wired page found a genuine defect — the "全部折叠" button shipped disabled because its condition was inverted — fixed in `5f713b5` and re-verified. |

Real defects found and fixed during this task:

1. `5f713b5` — collapse-all was disabled whenever anything was expanded (inverted `!allCollapsed`), making the everyday action unreachable. Added `anyCollapsed` and corrected both buttons.
2. `3e812f4` — `jobGroups.ts` failed `vue-tsc` once `jobSchema.type` gained `newapi`; `typeLabels`/`typeOrder` now cover it.
3. `c3e5fef` — removed an unused `basename` helper.

Known limitation carried to the parent task: `tests/executor.test.mjs` has one timing-sensitive case that fails when four test processes run concurrently and passes in isolation.
