# Acceptance Record

Task: `10-20-newapi-layout-shell` — 按 newapi 布局架构重做控制台外壳与全站页面。

Status: layout scope complete and verified. Business/backend scope of sibling tasks untouched.

## Scope delivered

- Inset shell: 48px sticky header spanning the viewport, 208px rail (44px collapsed, 272px mobile drawer), floating `.workspace` inset by 216/56 with an 8px radius, `main` capped at 1600px and centred.
- Panel system: every page block is `<section class="panel">` + `panel-heading` + `panel-body`. Only the page `<h1>`, the stats band, notices, pagination, the settings tab rail and the `content-grid` wrapper sit outside a panel.
- Stats band: four transparent, borderless columns at `18px 20px` with 24px icons.
- `content-grid`: desktop `1.6fr : 1fr` with a shared top edge; single full-width column with a 20px gap at and below 1100px.
- Migrated pages: overview, jobs, runs, files, storage, settings, plus the modal/editor surfaces.

## Verification (final run)

| Command | Result |
| --- | --- |
| `npm run check` (vue-tsc) | pass |
| `npm run build` | pass |
| `npm test` | 81 tests, 80 pass, 0 fail, 1 skipped |
| `npm run check:layout` | pass — 6 pages x 4 viewports x 2 themes, 48 page renders asserted, 52 screenshots |
| `npm run check:browser` | pass — 44 screenshots, 3 real encrypted backups (incl. a watched change), download, SMTP, login, responsive |
| `node scripts/ui-radius-audit.mjs` | pass — zero radius violations |

`check:layout` additionally reports: `Overview task rows: 8/8 combinations, 8 row renders, 8 with a visible name (系统配置)`.

## Negative test of the acceptance gate

The overview-row assertions were proven to fail on the original defect: temporarily restoring `display: block` on `.overview-job` plus `width: 0` on `.job-primary` produced

```
AssertionError: light/1440/overview: row "系统配置" shows its name
```

Reverting the sabotage returned the suite to green, confirming the check is not a no-op.

## Known limitations

- The mobile drawer has no Escape-to-close binding; it closes by tapping the scrim. This is recorded as a future improvement and is **not** asserted as supported.

## Commits

| Hash | Summary |
| --- | --- |
| `fa4c569` | inset shell with 208px rail |
| `6772cb4` | panel / stats / content-grid primitives, overview + runs |
| `217d70b` | jobs, files, storage, settings, editor onto the panel system |
| `6c757f9` | persistent layout acceptance check |
| `f2192cd` | spec: panel layout contract |
| `58ec372` | fix: restore overview task row layout + brand accessible name |
| `e1b94bd` | test: require visible overview task rows in every viewport/theme |

## Not committed (by parent-task constraint)

- `.trellis/tasks/10-18-ui-revamp-newapi-backup/board.md` (parent board, append-only, not committed)
- `.trellis/workspace/` journal entries
- Unrelated pre-existing changes: `server/auth.mjs`, `.trellis/tasks/10-18-ui-revamp-newapi-backup/task.json`, agent tool directories
