# design.md — newapi-layout-shell

Requirements: `prd.md`. Authority: newapi `web/src/components/ui/sidebar.tsx` +
`authenticated-layout.tsx`; validated against the working `codebuddy2api-ui_template`
(`src/ui.module.scss`, `src/theme.scss`).

---

## 1. Boundary

### In
- `web/src/style.css` — layout tokens + `.app` / `.header` / `.sidebar` / `.workspace` / `.main`
  geometry, `.panel` / `.stats` / `.content-grid` systems, and page-level class migration.
- `web/src/App.vue` — DOM restructure (header spans full width; sidebar starts below it;
  workspace is a floating card wrapping `.main`).
- Minimal class-name substitutions in `JobsView.vue` / `StorageView.vue` / `SettingsView.vue` /
  `FileManagerView.vue` / `RunDetail.vue` / `Modal.vue` / `JobEditor.vue` **only** where the old
  `.page-band` / `.section-heading` classes must become `.panel` / `.panel-heading`.

### Out
- Colour tokens (`--blue`, `--green`, `--surface`, `--page`, `--text`, `--muted`, `--border`,
  `--blue-soft`, `--surface-soft`, `--red`, …) — **values unchanged**.
- Component logic, props/events, API calls, store, contracts, tests' semantics.
- `nav.ts` registry shape (already correct).
- Dark theme palette (only layout rules change; dark values stay as-is).

---

## 2. Geometry — the one table that matters

```
--app-header-height: 48px      /* newapi --app-header-height */
--sidebar-width: 208px         /* newapi SIDEBAR_WIDTH 13rem */
--sidebar-width-icon: 44px     /* newapi SIDEBAR_WIDTH_ICON 2.75rem */
--sidebar-width-mobile: 272px  /* newapi 17rem */
--sidebar-motion: 200ms cubic-bezier(0.33, 1, 0.68, 1)   /* newapi duration-200 ease-linear */
--shell-gap: 8px               /* newapi inset m-2 */
--shell-max-width: 1600px
```

### 2.1 DOM target

```
.app                                  ← min-height:100dvh; padding-bottom:8px; background:var(--page)
├── header.header                     ← sticky top:0; height:48px; full width; z-index:30
│   ├── .header-brand  (toggle + brand)
│   ├── .breadcrumb    (page context)
│   └── .header-actions (live indicator, theme, AccountMenu)
├── aside.sidebar                     ← fixed; inset:48px auto 0 0; width:var(--sidebar-width)
│   └── nav.main-nav → .nav-group + .nav-item
└── .workspace                        ← margin: 8px 8px 0 calc(sidebar + 8px)
    └── main.main                     ← max-width:1600px; margin:0 auto; padding:20px 24px 28px
        ├── header.page-heading       ← the ONLY <h1>
        └── …page content (.stats / .panel / .content-grid)
```

Key change vs today: the top bar currently lives **inside** `.workspace`, and the sidebar is
`position: fixed` with the workspace offset by `margin-left`. Newapi's inset shell puts the header
**outside** and **above** both, so the sidebar begins at `top: var(--app-header-height)` and the
workspace card floats inside the remaining area with a visible 8px gutter on all three sides.

### 2.2 CSS

```css
.app { --sidebar-width: 208px; min-height: 100dvh; padding-bottom: 8px; background: var(--bg); }
.app.sidebar-collapsed { --sidebar-width: 44px; }

.header { position: sticky; top: 0; z-index: 30; display: flex; align-items: center;
          justify-content: space-between; gap: 12px; height: 48px; padding: 0 12px 0 6px;
          background: var(--bg); color: var(--muted); font-size: 12px; }

.sidebar { position: fixed; inset: 48px auto 0 0; z-index: 20; display: flex;
           flex-direction: column; width: var(--sidebar-width); padding: 12px 8px;
           background: var(--bg); overflow-x: hidden;
           transition: width var(--sidebar-motion), padding var(--sidebar-motion); }

.workspace { display: flex; flex-direction: column; min-width: 0;
             min-height: calc(100dvh - 64px);
             margin: 8px 8px 0 calc(var(--sidebar-width) + 8px);
             border: 1px solid var(--border); border-radius: var(--radius-lg);
             background: var(--surface); box-shadow: 0 1px 3px var(--shadow);
             transition: margin var(--sidebar-motion); }

.main { flex: 1; width: 100%; min-width: 0; max-width: 1600px;
        margin: 0 auto; padding: 20px 24px 28px; }
```

**Token names are this project's, not newapi's.** The reference uses `--page` / `--soft` / `--strong` /
`--line`; the equivalents here are `--bg` / `--surface-soft` / `--text` / `--border`. Newapi token
names must never be pasted into this stylesheet — an undefined custom property silently computes to
`transparent`, which is how the sticky header can end up see-through while scrolling.

Sidebar background is `var(--page)` (same as the app shell), **not** `var(--surface)` — that is what
makes the inset card read as a raised panel against a recessed rail, exactly like newapi. Today the
sidebar is `var(--surface)` with a `border-right`, which is the old flat look.

### 2.3 Collapse mechanics

Width animates via the `--sidebar-width` custom property on `.app`, so **one** transition on
`.sidebar { width }` and `.workspace { margin-left }` covers both surfaces. Text uses
`opacity + max-width` (not `display:none`) so icons never shift — newapi's `.navText` trick:

```css
.nav-item > .nav-text { overflow: hidden; white-space: nowrap;
                        transition: opacity var(--sidebar-motion), max-width var(--sidebar-motion); }
.sidebar.collapsed .nav-item > .nav-text { opacity: 0; max-width: 0; }
.sidebar.collapsed .nav-item { justify-content: center; padding-inline: 0; width: 40px; margin: 0 auto; }
```

`@media (prefers-reduced-motion: reduce) { :root { --sidebar-motion: 0ms; } }`

### 2.4 Mobile (≤900px, matching the reference's `md` breakpoint)

The implementation breakpoint is **900px**. `check:browser` verifies 390 and 360 (drawer mode) and
768 (drawer mode is still active at 768 since 768 < 900 — see gate G1b), so the value must be the
single source of truth in one media query; no second breakpoint may re-introduce a flat layout.

```css
@media (max-width: 900px) {
  .app-shell { padding-bottom: 0; }
  .sidebar { inset: 0 auto 0 0; width: var(--sidebar-width-mobile); transform: translateX(-100%);
             z-index: 40; box-shadow: 0 12px 40px #07142626; }
  .sidebar.open { transform: none; }
  .workspace { margin: var(--shell-gap) var(--shell-gap) 0; }   /* both sides, no flat margin-left */
  .sidebar.collapsed { padding: 12px 8px; }                     /* collapse never applies here */
}
```

All legacy flat-layout declarations at this breakpoint (`.workspace { margin-left: 0 }`,
`.sidebar { width: 226px }`, `.topbar { ... }`, `.brand > div`, `.workspace-label`) are deleted, not
overridden — leaving them would mean two competing layout models in the same stylesheet.

---

## 3. Panel / stats / grid systems

### 3.1 Panel
```css
/* No `overflow: hidden` on .panel: clipping the panel would hide a toolbar that
   overflows instead of revealing it. Only the first/last child radii are
   rounded, and .table-wrap owns horizontal scrolling. */
.panel { min-width: 0; background: var(--surface); border: 1px solid var(--border);
         border-radius: var(--radius-lg); }
.panel > .panel-heading:first-child { border-top-left-radius: var(--radius-lg);
                                      border-top-right-radius: var(--radius-lg); }
.panel > :last-child { border-bottom-left-radius: var(--radius-lg);
                       border-bottom-right-radius: var(--radius-lg); }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                 min-height: 58px; padding: 16px 20px; }
.panel-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 0 20px 20px; }
```

Migration map (old → new), applied page by page:

| Old | New |
|---|---|
| `section.page-band` | `section.panel` (+ `.panel-body` wrapper for the content) |
| `div.section-heading` + `h2` | `div.panel-heading` + `h2` |
| `div.overview-columns` | `div.content-grid` |
| `section.metrics` > `div.metric` | `section.stats` > `div.stat` |

Both the old and new class names are **not** kept as aliases: keeping them would leave dead rules
that contradict the new look, and `ui-radius-audit` would keep reporting them. Each page is migrated
in its own commit so a half-migrated state is never committed.

### 3.2 Stats — borderless grid
```css
.stats { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 0; margin-bottom: 24px; }
.stat { min-width: 0; padding: 18px 20px; background: transparent; border: 0; }
.stat > div { display: flex; align-items: center; justify-content: space-between; gap: 8px;
              color: var(--muted); font-size: 12px; }
.stat strong { display: block; margin: 8px 0 6px; color: var(--text); font-size: 26px;
               font-weight: 550; line-height: 1.25; font-variant-numeric: tabular-nums; }
.stat small, .stat p { display: block; min-height: 18px; color: var(--muted); font-size: 12px; }
```
This directly kills the "four boxed cards" look. Note the parent prd's "no duplicate metrics" rule:
the overview currently renders `临时空间` in stats *and* in the environment panel's storage link —
the migration keeps exactly one occurrence (stats) and the panel link becomes a plain nav link.

### 3.3 Content grid
```css
.content-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 20px; }
@media (max-width: 1100px) { .content-grid { grid-template-columns: minmax(0, 1fr); } }
```

### 3.4 Table
```css
.table-wrap { width: 100%; min-width: 0; max-width: 100%; overflow: auto;
              overscroll-behavior-inline: contain; }
.table-wrap thead th { position: sticky; top: 0; z-index: 2; background: var(--surface-soft); }
```

---

## 4. Radius reconciliation

`prd.md` forbids container radius > 8px. newapi's base is 16px, so the scale is rebased and
**all containers, including the outermost workspace surface, stay at or below 8px**:

```
--radius: 8px;                      /* was 0.5rem = 8px — unchanged value, explicit px */
--radius-sm: calc(var(--radius) * 0.6);   /* 4.8px  */
--radius-md: calc(var(--radius) * 0.8);   /* 6.4px  */
--radius-lg: var(--radius);               /* 8px    */
--radius-pill: 999px;                     /* badges/switches/avatars/dots only */
```

Ledger:

| Surface | Token | px |
|---|---|---|
| `.workspace` (inset shell card) | `--radius-lg` | 8 |
| `.panel`, `.modal` | `--radius-lg` | 8 |
| `.main-nav button`, `.sidebar-collapse`, inputs, buttons | `--radius-lg` | 8 |
| `.nav-count`, `.status`, `.tag-chip` | `--radius-sm` | 4.8 |
| `.avatar`, `.switch`, dots | `--radius-pill` | round |

There is **no** `--workspace-radius` or `--panel-radius` alias: aliases invite drift and the audit
script only accepts `var(--radius-sm|md|lg|pill)`. `scripts/ui-radius-audit.mjs` is the enforcement
point and **must not be relaxed** to accommodate layout work.

> Corrected during review: an earlier draft of this document proposed `--workspace-radius: 11.2px`
> as an "outermost shell" exception. That contradicted the parent task's hard ≤8px container rule
> and had no user approval, so it was removed. The workspace now uses `--radius-lg` like every other
> container.

---

## 5. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| L1 | Moving `.header` out of `.workspace` breaks `check-browser`'s `.main-content h1` locator | Keep `.main-content` as the class on `<main>`; `<h1>` stays inside it. Verified by grep of `scripts/check-browser.mjs` before editing. |
| L2 | Sidebar `inset: 48px` plus `sticky` header double-counts height on mobile | Mobile overrides to `inset: 0 auto 0 0` with `translateX(-100%)` drawer + z-index above header. |
| L3 | `.page-band` removal breaks pages not yet migrated | One page per commit; the full `check:browser` run after each keeps the suite honest. Zero pages are left on old classes at the end. |
| L4 | `ui-radius-audit.mjs` fails on intermediate states | Run it before each commit; it is cheap and catches stray literals. |
| L5 | Colour drift while "modernising" | **No colour token is edited.** Diff review gate: `git diff web/src/style.css` must show no changed colour values. |
| L6 | Other panes editing `style.css`/`App.vue` | p3 published `ALL-DONE` and released both files; this task owns them. Board announces ownership at START. |
| L8 | **Undefined custom property copied from newapi** → computes to `transparent`; sticky header and drawer show content through while scrolling | Every colour must come from this project's tokens (`--bg`/`--surface`/`--surface-soft`/`--text`/`--border`/`--muted`). Gate: `node -e` script asserting every `var(--x)` in `style.css` has a matching definition. Verified after the first G1 pass, where `--page` was found undefined in 3 places and replaced with `--bg`. |
| L9 | Long-page scroll not exercised, so a translucent sticky header goes unnoticed | Browser check scrolls each page to the bottom and re-screenshots with the header pinned; asserts the header's computed `background-color` is opaque (alpha = 1). |

---

## 6. Verification

Per-commit: `npm run check` + `node scripts/ui-radius-audit.mjs`.
End of task: `npm run check` / `npm test` / `npm run build` / `npm run check:browser`.

`check:browser` already asserts, for every screenshot:
- `document.documentElement.scrollWidth <= innerWidth + 1` (no horizontal overflow),
- no visible control outside the viewport,
- browser console free of errors.

New assertions to append (one contiguous block):
- sidebar width is 208px expanded, 44px collapsed, and `.workspace` left margin equals
  `sidebarWidth + 8`;
- the header is a sibling of `.workspace`, not a descendant (`document.querySelector('.workspace .header') === null`);
- `.main` computed `max-width` is 1600px;
- `.stats` has `grid-template-columns` with 4 tracks and `.stat` has `border-width: 0px`;
- exactly one `<h1>` inside `.main-content`.

Screenshots: `layout-before/` (current, for comparison, not committed) then
`desktop-*`, `mobile-*`, `tablet-*` re-taken for every page.

---

## 7. Rollback

Layout is CSS + one DOM restructure, committed per page. Reverting the skeleton commit restores the
flat shell; reverting a page commit restores that page's `.page-band` markup. No data, API, or
persistence change anywhere in this task.
