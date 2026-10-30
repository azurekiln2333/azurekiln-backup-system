# Research: can this system issue multiple API tokens? (可行性调研)

Owner: pane `w1H:p4` (pi-tokens). Related: `../prd.md`, parent task `10-18-ui-revamp-newapi-backup`.

**Conclusion up front: FEASIBLE and valuable. Implement with a deliberately small scope.**
See §5 for the decision and §6 for the minimal range that will be built.

---

## 1. Current authentication in this system (as of commit `486bc91`)

Files read: `server/auth.mjs`, `server/app.mjs`, `server/config.mjs`, `server/store.mjs`,
`shared/contracts.mjs`, `tests/api.test.mjs`, `scripts/check-browser.mjs`.

### 1.1 What exists today

| Concern | Implementation | Notes |
|---|---|---|
| Primary credential | Single administrator record: `admin(id=1, username, password_hash)` in `state.sqlite` | Password hashed with `scrypt` (`hashPassword` / `verifyPassword`) |
| Session | Opaque 32-byte hex cookie `backup_session`, stored **hashed** (SHA-256) in `sessions(hash, csrf, expires)` | 24 h absolute max age, no sliding renewal |
| CSRF | Per-session 32-byte hex `csrf` secret; `auth.csrf` requires `x-csrf-token` matching it on every non-`GET/HEAD/OPTIONS` `/api` request | Compared with `timingSafeEqual` over SHA-256 digests |
| Origin | `auth.checkOrigin` rejects a mismatching `Origin` header against `config.publicUrl` | |
| OIDC | `openid-client` v6, nonce+state+PKCE, still binds to the **single** administrator subject | |
| Bearer / API key | **None.** `app.use('/api', auth.requireAuth, ...)` where `requireAuth` only checks `req.session` | |
| Per-token state table | None | |
| Audit log | None (no `audit`/`events` table). Only per-run execution logs (`logs(run_id, ...)`) | |
| Secret at rest | AES-256-GCM `seal`/`unseal` with `secret.key`, used for SMTP/OIDC/rclone secrets and job passwords | |
| Rate limiting | Login rate limit only (`loginAttempts` in memory) | API surface is unthrottled |
| Redaction | `store.redact()` scrubs configured secrets from run errors, logs and HTTP error messages | |

Key structural fact: **everything under `/api` after the auth routes is gated by exactly one
middleware chain** — `auth.requireAuth → auth.checkOrigin → auth.csrf`. That makes "add a second
authentication scheme" a single-point change (see design.md), not a scattergun edit.

### 1.2 Implication

The system has no notion of "a caller". Adding named tokens is not retrofitting an existing
credential model — it introduces a second principal type. That means the scope decision is the
whole design decision, and the smallest scope that is still honest is: *one caller type (a token),
one administrator (unchanged), no ACL graph.*

---

## 2. Reference: newapi's token management (`D:\My2KProjects\new-api`)

### 2.1 Backend model (`model/user_access_token.go`)

```go
const AccessTokenPrefix = "nap_"
// Only the SHA-256 fingerprint of the plaintext is stored; it doubles as the audit token_ref.
type UserAccessToken struct {
    Id, UserId     int
    Name           string // <= 64 chars, user-facing
    TokenHash      string // varchar(64), unique index — SHA-256 hex
    TokenHint      string // varchar(8)  — last characters, for masked display
    Scopes         string // varch(2048) — JSON array, malformed => grants nothing
    ExpiresAt      int64  // 0 = never
    LastUsedAt     int64
    LastUsedIp     string
    CreatedAt      int64
}
func (t UserAccessToken) Expired(now) bool { return t.ExpiresAt > 0 && t.ExpiresAt <= now }
```

Observations worth copying:

- **Prefix convention** (`nap_`) so a leaked string is recognisable/greppable.
- **Hash-only storage**, SHA-256, *not* a slow hash — correct because the secret is high-entropy
  random, so offline brute force is not the threat model; a slow KDF would only cost latency on
  every API call.
- **`TokenHint`** (short suffix) is stored in the clear purely for the UI mask.
- **Malformed scopes grant nothing** (fail-closed parse).
- `LastUsedAt` is written on a throttle (`userAccessTokenTouchIntervalSecs = 60`) — avoids a DB write
  per request.

### 2.2 Backend hardening around it (`model/user_access_token.go` header + schema notes)

- `LegacyAccessTokenRetireAt` + `legacyAccessTokenTransitionDays = 30`: a *deprecation window*,
  i.e. the project treats token formats as something that migrates, not something that silently
  changes meaning.
- `ErrAccessTokenLimit` — a per-user cap on how many tokens may exist.

### 2.3 Frontend (`web/src/features/security/...`)

- `access-tokens-card.tsx` — list; each row (`access-token-item.tsx`) shows
  **name**, `nap_…<hint>` in `<code>`, scope badges (max 3 + `+n`), `Created …`, expiry
  (`Never expires` / `Expires …` / red `Expired`), `Last used …` (+ IP), and a row menu with
  **Edit / Access records / Revoke**.
- `access-token-create-dialog.tsx` — name + expiry preset (`30d / 90d / 180d / 1y / custom / never`,
  custom must be ≥ 1 hour ahead) + a permissions matrix (`permissionMatrixToScopes`); the form
  rejects an empty permission set.
- `access-token-dialog.tsx` — the **one-time reveal**: "Copy this token now. It will not be shown
  again.", read-only mono input + copy button, single Close action.
- `access-token-edit-dialog.tsx` — rename / re-scope / re-expire. The plaintext never returns.

### 2.4 What is *not* worth copying here

| newapi feature | Why it doesn't fit us |
|---|---|
| Per-user multi-tenancy (`UserId`) | This system has exactly one administrator, by design (`admin CHECK(id=1)`) |
| A permission **matrix** over many resources | We have ~5 meaningful operation groups; a matrix would be over-engineering and multiplies the chance of an ACL hole |
| "Access records" per token history page | We have no audit store; a full request log is out of scope. A lighter "last used" + optional audit table is enough (see design) |
| Token usage **quotas** / rate widgets | Nothing to quota — a manual backup trigger is not a billable resource |

---

## 3. Does this system have a legitimate use for tokens?

Yes. Concretely, from what the API already exposes:

1. **Scripted/automated backup trigger** — `POST /api/jobs/:id/run` and then `GET /api/runs/:id`
   to wait for `succeeded`. Today the only way is to keep an administrator session cookie and pass
   `x-csrf-token`, i.e. reimplement the login flow in a shell script and store an admin password
   there. That is both awkward and the worst possible secret to spread around.
2. **External monitoring / health checks** — `GET /api/overview`, `GET /api/runs?status=failed`.
   A read-only token for a dashboard/scraper is strictly better than an administrator cookie.
3. **Post-backup glue on other machines** — e.g. a cron entry on the NAS that fires
   `.../run` after a database dump, or uploads nothing but checks the last run's status. Very
   common pairing with this project's `crontab_backup` use case in the parent task.
4. **CI** — a smoke test that creates/executes a task against a throwaway instance.

All four need **no** configuration mutation, no token management, no settings edits. That directly
determines the scope split below.

Counter-case (why not just keep using the cookie): a cookie session is bound to `httpOnly`,
`sameSite=lax`, a 24 h expiry, a CSRF round-trip, and rotating it means logging in as the human
administrator. Any of those is fine for a browser, wrong for a cron job.

---

## 4. Feasibility risks found while reading the code

| # | Risk | Finding | Mitigation |
|---|---|---|---|
| R1 | Bearer requests would be rejected by the existing CSRF middleware, or worse, CSRF would be weakened | `auth.csrf` runs for all non-GET `/api` routes after `requireAuth`; it requires `req.session`. | Branch at the **auth layer**: if a valid Bearer token authenticated the request, mark the request as token-authenticated (`req.token`) and have `csrf` skip *only* for that request. Session requests keep the exact current behaviour; the test suite already asserts `csrf:false → 403`, so a regression is caught. |
| R2 | Token → administrator escalation | If a token could call `/api/tokens`, `/api/settings`, `/api/jobs` (create/patch/delete), `/api/system/import`, `/api/rclone/import`, `/api/auth/logout`, it would be a full takeover. | Hard-coded **deny-by-default** management guard: token principals may only reach an explicit allowlist of routes, and the token endpoints are administrator-session-only (`requireSession`). Test asserts `token → /api/tokens = 403`. |
| R3 | Secret leakage in logs/errors/responses | `store.redact()` scrubs only *configured* secrets; a token plaintext is not one of them. | (a) Plaintext is returned exactly once from `POST /api/tokens` and never persisted. (b) Bearer values never enter logs: failures return a generic 401 with a stable code and no echo of the header. (c) Add token hash values to the redaction set so an accidental hash echo is scrubbed. |
| R4 | Timing / enumeration on lookup | `store.getSession` looks up by hash; a `Map`/SQL lookup keyed by hash leaks nothing about *which* token exists. | Lookup by SHA-256 hash (fixed-length), then constant-time compare of the presented token hash against the stored one; a miss returns the same 401 body/status as an expired/disabled/invalid token. |
| R5 | Write amplification from `lastUsedAt` | One DB write per API call would be worse here than in newapi (SQLite WAL, single writer, backup runs compete for it). | Throttle: only update when the stored `lastUsedAt` is older than 60 s (mirrors newapi's `touchInterval`). |
| R6 | Scope creep into `shared/contracts.mjs` / `server/store.mjs` — both are owned by other panes right now | Parent rules §5 put jobs/batch parts of `contracts.mjs` and `store.mjs` under `jobs-batch-grouping`, and those files are currently dirty in the shared worktree. | **Zero edits** to `shared/contracts.mjs`. Token schema lives in the new module `server/tokens.mjs`; token persistence uses its **own** table created inside that module against the existing `DatabaseSync` handle — no `store.mjs` edit. (See design.md §2 for how the handle is reached.) |
| R7 | Frontend wiring conflicts with `ui-shell-newapi` | `web/src/App.vue` + `style.css` are ui-shell's, until `SHELL-DONE`. | Build `TokensView.vue` as a self-contained new file + additive `types.ts`/`api.ts` helpers now; wire the nav row only after `SHELL-DONE`. |
| R8 | `check-browser.mjs` is shared and currently dirty (another pane added the batch/tag flow) | Editing it risks clobbering a concurrent edit. | Add the token browser assertions in **one contiguous append near the end of the `try` block** (before the final `errors` assertion), and load it lazily so the existing flow is untouched. Re-read the file immediately before editing. |

---

## 5. Conclusion

**Feasible, and worth doing.** Nothing in the current architecture blocks it; in fact the single
`/api` middleware chain makes it a clean insertion. The value is real (§3) and the risk is
containable with deny-by-default authorisation (§4 R2) plus one-time plaintext (§4 R3).

**Not** copying from newapi: multi-tenancy, the permission matrix, per-token usage quotas, and a
full request-history page. Those add attack surface and code for no operator benefit in a
single-administrator backup appliance.

---

## 6. Minimal scope that will be implemented

### Scope tokens
- Exactly two: `read` (inspect state) and `run` (trigger/cancel work). `run` implies `read`.
- Two scopes, not a matrix: every route the product needs is either "look at something" or "make
  the machine do something". Anything that *changes configuration* is neither — it is forbidden to
  tokens entirely (administrator session only).

### Fields (mirrors newapi minus what we don't need)
`id` (UUID), `name`, `hash` (SHA-256 hex, unique), `prefix` (`akb_` + first 4 chars),
`lastFour`, `scopes` (`['read'|'run']`), `createdAt`, `lastUsedAt`, `expiresAt` (null = never),
`enabled`.

`lastUsedIp` is intentionally **omitted**: the app may sit behind a proxy and we have no trusted
proxy configuration, so an attacker-controlled `X-Forwarded-For` would make the field misleading.

### Endpoints
- `GET    /api/tokens` — list (masked), administrator session only.
- `POST   /api/tokens` `{name, scopes, expiresAt?}` → `201` with `{...token, secret}` **once**.
- `PATCH  /api/tokens/:id` `{name?, enabled?, expiresAt?}` — rename / enable-disable / re-expire.
- `DELETE /api/tokens/:id` — revoke (hard delete; the hash is the credential, nothing to keep).

### Bearer surface (`Authorization: Bearer akb_…`)
| Route | Scope |
|---|---|
| `GET /api/auth/status` | — (stays public/session-only; tokens are not a login) |
| `GET /api/overview` | `read` |
| `GET /api/jobs`, `GET /api/jobs/:id` | `read` |
| `GET /api/runs`, `GET /api/runs/:id` | `read` |
| `GET /api/storage` | `read` |
| `POST /api/jobs/:id/run` | `run` |
| `POST /api/runs/:id/cancel` | `run` |

Everything else — jobs CRUD, settings, `/api/tokens*`, `/api/system/import`, `/api/rclone/*`,
`/api/sources`, archive download, `/api/auth/logout` — **denied for tokens** with
`403 TOKEN_SCOPE_FORBIDDEN`. This allowlist is `read`-only + `run`-only on purpose: it is the whole
value proposition from §3 and nothing more.

### Frontend
One new page: token list (name, mask, scopes, status, created/last-used/expires, copy-once dialog,
rename, enable/disable, delete). Nav row added after `SHELL-DONE`.

### Out of scope (explicit, so review does not ask for it)
Token-based login/OIDC interaction, per-token rate limits, per-token audit history pages,
scoped-by-job restrictions, IP allowlists, token rotation UI, and any change to the single
administrator model.
