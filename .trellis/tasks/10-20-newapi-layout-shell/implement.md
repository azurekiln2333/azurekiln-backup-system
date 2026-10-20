# implement.md — newapi-layout-shell

Requirements `prd.md` · design `design.md`.
Global rules (path-limited commits, immediate commit, board protocol, ports) come from
`../10-18-ui-revamp-newapi-backup/prd.md`.

Dev server: **port 16403**, isolated temp data dir. Never touch `.data/`.

Validation commands:

```bash
npm run check
npm test
npm run build
npm run check:browser
node scripts/ui-radius-audit.mjs
```

---

## 0. Checklist

### Phase 0 — baseline evidence
- [ ] 0.1 Confirm `SHELL-DONE`/`ALL-DONE` on the board and that p3 released `App.vue`/`style.css`.
- [ ] 0.2 Save current screenshots to `.artifacts/layout-before/` (not committed) as the comparison set.
- [ ] 0.3 `grep -n "main-content\|workspace-footer\|page-band" scripts/check-browser.mjs` — record which
      locators depend on the markup we are about to change (risk L1).

### Phase 1 — layout skeleton (highest risk, one commit)
- [ ] 1.1 `style.css`: add `--app-header-height`, `--sidebar-width: 208px`,
      `--sidebar-width-icon: 44px`, `--sidebar-width-mobile: 272px`, `--sidebar-motion`, `--shell-gap`,
      `--shadow`, `--panel-radius`, `--workspace-radius`. **No colour value changes.**
- [ ] 1.2 `style.css`: rewrite `.app` / `.header` / `.sidebar` / `.workspace` / `.main` per design §2.2–2.4,
      incl. mobile drawer override and `prefers-reduced-motion`.
- [ ] 1.3 `App.vue`: move `<header class="header">` out of `.workspace` to be a direct child of `.app`,
      before `<aside class="sidebar">`; move brand + collapse toggle + breadcrumb into the header;
      keep `.main-content` on `<main>` and the single `<h1>`.
- [ ] 1.4 Run `npm run check` + `npm run build`; open at 1440 / 768 / 390 / 360 and verify:
      header spans full width, sidebar starts below it, workspace floats with an 8px gutter,
      collapse animates smoothly, no horizontal overflow.
- [ ] **Commit 1** `refactor(ui): adopt newapi inset shell with 208px rail`
      → gate G1.

### Phase 2 — panel / stats / grid systems
- [ ] 2.1 `style.css`: add `.panel` / `.panel-heading` / `.panel-body` / `.stats` / `.stat` /
      `.content-grid`, and the sticky table head. Delete the now-unused `.metrics` / `.metric` /
      `.overview-columns` rules **only after** the pages that use them are migrated (do it in the
      page commits, not here).
- [ ] **Commit 2** `refactor(ui): add panel, stats and content-grid primitives`

### Phase 3 — page-by-page migration (one commit each)
For every page: replace `.page-band`→`.panel`, `.section-heading`→`.panel-heading`, add
`.panel-body`, and verify no duplicate metric/title survives.

- [ ] 3.1 overview: `.metrics`→`.stats`, `.overview-columns`→`.content-grid`, remove the duplicated
      storage figure from the environment panel. → **Commit 3** `refactor(ui): rebuild overview on panel grid`
- [ ] 3.2 jobs (`JobsView.vue`, minimal class swaps only). → **Commit 4** `refactor(ui): move jobs list onto panel system`
- [ ] 3.3 runs. → **Commit 5** `refactor(ui): move run history onto panel system`
- [ ] 3.4 files (`FileManagerView.vue`). → **Commit 6** `refactor(ui): align file manager with shell`
- [ ] 3.5 storage (`StorageView.vue`). → **Commit 7** `refactor(ui): align storage page with shell`
- [ ] 3.6 settings (`SettingsView.vue`). → **Commit 8** `refactor(ui): align settings page with shell`
- [ ] 3.7 modals: `Modal.vue` / `RunDetail.vue` / `JobEditor.vue` / `PathPicker.vue` radius + padding.
      → **Commit 9** `refactor(ui): normalise dialog surfaces`

### Phase 4 — verification
- [ ] 4.1 Append the layout assertions to `scripts/check-browser.mjs` (one contiguous block, design §6).
- [ ] 4.2 Full four-command run; inspect every screenshot at 1440 / 768 / 390 / 360.
- [ ] 4.3 Dark theme pass: every page, plus collapsed rail.
- [ ] **Commit 10** `test(ui): assert newapi layout geometry`

### Phase 5 — docs / spec
- [ ] 5.1 `.trellis/spec/frontend/ui-api.md`: layout architecture section (header/rail/workspace
      geometry, panel system, radius ledger, sticky header rule).
- [ ] **Commit 11** `docs(spec): record inset shell layout contracts`

---

## 1. Review gates

| Gate | Requirement |
|---|---|
| G1 | After commit 1: header is a sibling of `.workspace`; sidebar 208/44px; workspace margin-left = sidebar+8; no horizontal overflow at 360px; collapse animates; `npm run check` + `build` green |
| G2 | After commit 2: no page regressed visually (primitives added, none removed yet) |
| G3 | Each page commit: `check:browser` still green, and that page shows exactly one `<h1>` and no duplicated metric |
| G4 | After commit 9: `grep -rn "page-band\|section-heading\|overview-columns\|class=\"metrics\"" web/src` returns **nothing** |
| G5 | Final: four commands green + `ui-radius-audit` green + dark theme verified |
| G6 | `git diff` on `style.css` shows **zero** changed colour-token values (only new geometry tokens) |

## 2. Rollback points

Every commit is independently revertible. Commit 1 is the structural one — reverting it restores the
flat shell without touching any page content. Page commits are cosmetic class swaps.

## 3. Board protocol

Append at START, after commit 1 (PROGRESS), after commit 9 (PROGRESS), and at DONE. If a decision is
needed, append `BLOCKED` with the chosen default and continue.

Known decision already defaulted in `design.md` §4: `--workspace-radius` = 11.2px (newapi
`rounded-xl` proportion) for the single outermost shell surface only; every inner container stays
≤8px.
