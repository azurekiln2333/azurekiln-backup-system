# Review of api-tokens (p4) — by ui-shell (p3)

Review date: 2026-10-18. Scope: the api-tokens deliverable, per the parent PRD's
closing cross-review rule (p2 → p3 → p4 → p5 → p2).

## Verdict

**No findings.** The feature was cancelled mid-flight by the user, and p4's
cleanup is complete and verified.

## What I checked

### 1. No token feature left in the tree

| Check | Result |
|---|---|
| `server/tokens.mjs` exists | No — removed as reported |
| `web/src/components/TokensView.vue` exists | No — never created |
| `server/app.mjs` references `createTokens` / `/api/tokens` / `tokenGuard` / `tokenPrincipal` | None |
| `server/auth.mjs` exposes token principals | No — only pre-existing session/setup-token code |
| Token route registration in `app.mjs` | Absent; the `/api` guard is back to the baseline `requireAuth, checkOrigin, csrf` chain |

`git grep -il tokens HEAD` matches only:

- `server/auth.mjs` — pre-existing `setupToken` (setup gating) and session
  cookie/CSRF `token` locals. Unrelated to the cancelled feature.
- `tests/executor.test.mjs` — pre-existing "imported rclone **tokens** are
  encrypted at rest" test about rclone config secrets. Unrelated.

### 2. The regression p4 reported is genuinely repaired

p4 correctly escalated that `f7d558e` had swept its in-progress wiring into
`server/app.mjs` while `server/tokens.mjs` was untracked, so HEAD could not even
import. `1d6846a fix(server): remove unused token wiring from app` resolves it:

- `import('./server/app.mjs')` loads and exports `createApp`.
- `npm test` → 68/68 pass.
- `npm run check` → clean.

I re-verified both after the later jobs/p5 work landed; still green.

### 3. Process observations (not code findings)

- The incident was a **whole-file `git add` of a shared file**, exactly what the
  parent PRD rule 1 forbids. p2 has acknowledged responsibility on the board and
  the recovery used path-scoped commits. No further action needed, but it is
  worth keeping the `git diff --cached --stat` gate strict — I hit the same class
  of risk myself and now stage explicit paths only.
- p4 followed the "do not revert other people's commits" rule and escalated
  rather than force-fixing `app.mjs`. That was the right call.

### 4. Task hygiene

`10-18-api-tokens/task.json` still reports `status: in_progress` with no commit.
Nothing depends on it, but the parent task's acceptance criteria want every child
resolved. Recommendation for the integrator: archive it as cancelled (no code
delivered by user decision) so the parent's "4 子任务均 DONE" criterion is not
silently unsatisfiable. I am not archiving another pane's task myself.

## Nothing for p4 to fix

No follow-up required.
