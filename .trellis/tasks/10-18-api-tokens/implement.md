# implement.md — api-tokens

Execution plan. Requirements: `prd.md`. Technical design: `design.md`.
Feasibility conclusion: `research/token-feasibility.md`.

Validation commands (run from repo root; shared worktree with 3 other panes):

```bash
npm run check          # vue-tsc --noEmit
npm test               # node --test tests/*.test.mjs
npm run build          # vite build
npm run check:browser  # playwright; needs web/dist + Chrome + real rclone/7z
```

Commit discipline (parent prd §1–§4): path-limited `git add <files>` / `git commit -m "…" -- <files>`
only, never `git add .`/`-A`, never `--amend`, never push. Immediately after each验证过的 step.

Dev server for manual inspection: **port 16403**, data in a temp dir, never `.data/`.

---

## 0. Ordered checklist

### Phase A — backend (no shared-file contention)
- [ ] A1 `server/tokens.mjs` — schema/DDL, `akb_` secret generation, SHA-256 hashing, masked DTOs,
      create/update/remove/list, `authenticate`, `hasScope`, `TOKEN_ALLOWLIST` matcher,
      `logSecurity`, zod validation, `close()`.
- [ ] A2 `server/auth.mjs` — add optional `tokens` dep; `identify` resolves Bearer;
      `requireAuth` accepts either principal; new `requireSession`; `csrf` self-exempts token
      requests; new `tokenGuard`.
- [ ] A3 `server/app.mjs` — create `tokens`, mount `/api/tokens` behind `requireSession` **before**
      the blanket guard, insert `tokenGuard`, close tokens on shutdown.
- [ ] A4 `tests/api.test.mjs` — append the token test block (design §9.1, 9 assertions).
      → gate: `npm test` green, including the pre-existing CSRF/session assertions.
- [ ] **Commit 1**: `feat(api): add scoped bearer API tokens`

### Phase B — frontend component (self-contained, pre-`SHELL-DONE`)
- [ ] B1 `web/src/types.ts` — additive `TokenScope` / `ApiToken` / `ApiTokenCreated`.
- [ ] B2 `web/src/api.ts` — no change expected (existing `api`/`write` suffice). Verify only.
- [ ] B3 `web/src/components/TokensView.vue` — list + create + reveal + rename + enable/disable +
      delete, existing utility classes only.
      → gate: `npm run check` and `npm run build` green.
- [ ] **Commit 2**: `feat(web): add token management view`

### Phase C — nav wiring (blocked on `SHELL-DONE`)
- [ ] C1 wait for `SHELL-DONE` in `board.md`, re-read `web/src/App.vue` for the nav registry shape.
- [ ] C2 register the `tokens` page + one `v-else-if` branch. Minimal diff, nothing else.
- [ ] **Commit 3**: `feat(web): register token management page in navigation`

### Phase D — browser verification
- [ ] D1 `scripts/check-browser.mjs` — ONE contiguous append near the end of the `try` block
      (before the final `assert.deepEqual(errors, [])`), per design §9.2.
- [ ] D2 `npm run build && npm run check:browser`; inspect
      `.artifacts/screenshots/desktop-tokens.png` / `mobile-tokens.png` by eye.
- [ ] **Commit 4**: `test(browser): cover token management flow`

### Phase E — docs & spec (Phase 3.3)
- [ ] E1 `.trellis/spec/backend/backup-lifecycle.md` — token contracts, allowlist, the
      "own SQLite handle" tradeoff, CSRF exemption reasoning, test matrix row.
- [ ] E2 `.trellis/spec/frontend/ui-api.md` — TokensView contract, nav registration, copy-once rule.
- [ ] E3 `README.md` / `README.en.md` / `README.zh-TW.md` — a short "API 令牌" section with a
      `curl` example (Bearer, no CSRF).
- [ ] **Commit 5**: `docs: document scoped API tokens`

---

## 1. Review gates

| Gate | Must hold before proceeding |
|---|---|
| G1 after A4 | `npm test` green; the pre-existing `csrf: false → 403` assertion untouched and passing; a token request to `/api/tokens` is rejected by **two** independent guards |
| G2 after B3 | `npm run check` + `npm run build` green; `git status` shows **no** change to `App.vue`, `style.css`, `shared/contracts.mjs`, `server/store.mjs` |
| G3 after C2 | `git diff` for the wiring is ≤ ~5 lines; `SHELL-DONE` was actually present |
| G4 after D2 | 4 commands green; screenshots inspected; no new browser console errors |
| G5 before commit 5 | spec + READMEs mention: prefixes, scopes, one-time display, revoked = 401, CSRF exemption only for Bearer |

## 2. Rollback points

- After commit 1: revert commit 1 → the app behaves exactly as before; `api_tokens` table is inert.
- After commit 2/3: revert those → the page is unreachable but harmless.
- After commit 4: revert → `check:browser` returns to the pre-existing flow.
- No data migration anywhere, so there is nothing to un-migrate. Dropping `api_tokens` is safe at
  any time.

## 3. BLOCKED handling

Per the parent prd, decisions are not escalated to the user: record `BLOCKED` in
`.trellis/tasks/10-18-ui-revamp-newapi-backup/board.md` with the chosen default and continue.
Defaults already chosen are listed in `design.md` §10.

Known waits:
- Phase C waits on `ui-shell-newapi` publishing `SHELL-DONE`. If it does not appear, poll the board
  between other work and keep Phase A/B/E complete; the token feature is fully functional and
  testable via API and via a temporary local hash route… **no** — do not add a temporary route.
  Instead: complete Phase A/B/D-API-level tests, and write `BLOCKED` on the board stating the page
  is built but not reachable until the shell publishes its registry.
