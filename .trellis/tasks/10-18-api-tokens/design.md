# design.md — api-tokens

Companion to `research/token-feasibility.md` (conclusion: feasible, minimal scope in §6 there).
Requirement source: `prd.md`. Global rules: `../10-18-ui-revamp-newapi-backup/prd.md`.

---

## 1. Boundaries

### In
- New backend module `server/tokens.mjs` — token schema, hashing, persistence, verification,
  scope checks, and an Express mountable `createTokens({ store, db })` service.
- `server/auth.mjs` — one small addition: a way to attach a token principal to `req` and to skip
  CSRF *for token requests only*. No change to password/session/OIDC logic.
- `server/app.mjs` — install the token resolver before `requireAuth`, add a management guard, and
  register `/api/tokens` routes behind a session-only guard.
- `tests/api.test.mjs` — new test block (appended, non-invasive).
- `web/src/components/TokensView.vue` (new file), additive `web/src/types.ts` + `web/src/api.ts`.
- `scripts/check-browser.mjs` — one contiguous appended block of assertions near the end.
- `.trellis/spec/backend/*`, `.trellis/spec/frontend/ui-api.md`, READMEs — documentation.

### Out (deliberately not touched)
- `shared/contracts.mjs` — **no edit**. The token schema is server-only; nothing in it is shared
  with the browser (the browser only reads DTOs from `/api/tokens`).
- `server/store.mjs` — **no edit** (owned by `jobs-batch-grouping` while dirty). Token persistence
  opens its own table on the already-open SQLite handle (see §2).
- `web/src/App.vue`, `web/src/style.css` — owned by `ui-shell-newapi`; touched only after
  `SHELL-DONE`, as a two-line nav registration.
- Administrator model, OIDC, session lifetime, CSRF secret generation — unchanged.

---

## 2. Persistence without editing `store.mjs`

`createStore()` closes over its local `db` (`new DatabaseSync(...)`) and does not expose it. Two
options were considered:

| Option | Verdict |
|---|---|
| A. Add `getDatabase()`/`db` to the store's returned object | Rejected: requires editing `store.mjs`, which is a shared file currently dirty under another pane's ownership. |
| B. Give `server/tokens.mjs` the ability to open the same SQLite file itself | Rejected: two `DatabaseSync` handles on verified WAL is workable but doubles write-lock coordination with backup runs for no benefit. |
| C. Accept the handle as an injected dependency and add a **narrow, additive** accessor in `store.mjs` | Rejected for the same ownership reason as A. |
| **D. `createTokens({ store, config })` opens its own table on a handle obtained from the store via a lazily-defined, additive property added *only if absent*** | Rejected: still an edit to `store.mjs`. |

**Final decision — Option E:** `server/tokens.mjs` owns its own `DatabaseSync` handle on
`path.join(config.dataDir, 'state.sqlite')`.

Rationale and mitigations:

- `state.sqlite` is already opened with `PRAGMA journal_mode=WAL`, which is designed for multiple
  connections in one process; the token table is written rarely (create/rename/revoke/`lastUsedAt`
  throttled to 60 s) and the writes are single-statement, so lock contention with backup writes is
  bounded to statement duration.
- The token handle sets `PRAGMA busy_timeout=5000` and `PRAGMA foreign_keys=ON` for parity, and
  closes with the app's `close()`.
- The table is created with `CREATE TABLE IF NOT EXISTS`, so an existing database migrates by
  simply opening the app. No migration tooling is required and no other table is touched.
- **This is an explicit, documented tradeoff**: it buys total file-ownership isolation in a
  4-pane parallel worktree. Recorded in `.trellis/spec/backend/backup-lifecycle.md` so a future
  change can consolidate the handle when the ownership conflict is gone. (Follow-up note: if
  `store.mjs` later exposes its handle, `createTokens` can take an injected `db` and drop its own
  `DatabaseSync` — the module is written so `new DatabaseSync` appears in exactly one place.)

### Schema

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the plaintext secret
  prefix       TEXT NOT NULL,          -- 'akb_' + 4 chars of the random part (display only)
  last_four    TEXT NOT NULL,          -- last 4 chars (display only)
  scopes       TEXT NOT NULL,          -- JSON array, e.g. ["read","run"]
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_hash ON api_tokens(hash);
```

`hash` is `UNIQUE`, which doubles as the lookup index. `expires_at`/`last_used_at` are ISO-8601
strings to match the rest of the schema (`runs.created_at`, `jobs.data.createdAt`).

---

## 3. Token format & hashing

```
akb_<43 chars base64url of 32 random bytes>
```

- Prefix `akb_` (AzureKiln Backup) — matches newapi's `nap_` recognisability convention, and makes
  a leaked token greppable in logs/CI configs.
- 32 random bytes from `crypto.randomBytes` → 256 bits of entropy. Base64url keeps it
  copy/paste-safe in headers and shell.
- `hash = sha256hex(secret)`; `timingSafeEqual` over the two 32-byte buffers when verifying the row
  found by hash. SHA-256 (not scrypt) is correct here *because* the secret is high-entropy random —
  the slow-hash threat model (guessing a human password) does not apply, and a KDF on every API
  call would be a self-inflicted DoS.
- **Plaintext exists in exactly three places**: the `randomBytes` buffer in `POST /api/tokens`, the
  single 201 response body, and the browser's copy-once dialog. It is never written to SQLite, never
  logged, never included in list/PATCH responses.
- `prefix`/`last_four` are stored so the UI can render `akb_1a2b…c3d4` without any secret material.

---

## 4. Contract changes

### 4.1 New module `server/tokens.mjs`

```js
export const TOKEN_PREFIX = 'akb_';
export const TOKEN_SCOPES = ['read', 'run'];        // 'run' implies 'read'
export const TOKEN_MANAGEMENT_DENYLIST = /^\/api\/tokens/;

export function createTokens({ store, config }) -> {
  ensure(),                       // CREATE TABLE IF NOT EXISTS
  list(),                         // -> masked DTOs, no secret/hash
  create({ name, scopes, expiresAt }),  // -> { token: maskedDTO, secret }  (secret shown once)
  update(id, { name?, enabled?, expiresAt? }),   // -> masked DTO | null
  remove(id),                     // -> boolean
  authenticate(rawHeaderValue),   // -> { id, name, scopes } | null   (no throw, no info leak)
  hasScope(principal, scope),     // -> boolean ('run' implies 'read')
  close(),
}
```

`authenticate` accepts the raw `Authorization` header, requires `Bearer <value>`, rejects values
that are not `akb_` + 43 url-safe chars, hashes, looks up, checks `enabled`, `expiresAt`, and does
the constant-time compare. Every failure returns `null` — the caller maps `null` to a single
generic 401. It never distinguishes "no such token" from "disabled" from "expired".

`last_used_at` is only written when the stored value is `NULL` or older than 60 s (mirrors newapi's
`userAccessTokenTouchIntervalSecs`), so a monitoring scraper does not turn into a write storm.

### 4.2 `server/auth.mjs` additions (minimal)

```js
function identify(req, res, next)      // unchanged for cookies; additionally:
                                       //   if no session cookie and an Authorization: Bearer header exists,
                                       //   set req.tokenPrincipal = tokens.authenticate(header)
function requireAuth(req, _res, next)  // now: req.session || req.tokenPrincipal, else 401
function requireSession(req, _res, next)  // NEW: req.session only, else 401 SESSION_REQUIRED
function csrf(req, _res, next)         // now: first line is
                                       //   if (req.tokenPrincipal) return next();   // Bearer requests are CSRF-exempt
                                       // everything after is byte-for-byte the current behaviour
function tokenGuard(req, _res, next)   // NEW: if req.tokenPrincipal and the request is not on the token
                                       //   allowlist -> 403 TOKEN_SCOPE_FORBIDDEN
```

`createAuth` takes an extra `{ tokens }` dependency. If `tokens` is undefined (permitted for the
existing test fixture), `identify` simply never sets a principal and every gate behaves exactly as
today — so no existing test needs to change.

CSRF reasoning: CSRF exists because a *cookie* is ambiently attached by the browser. A Bearer token
is not ambient — a cross-site form/fetch cannot set an `Authorization` header without a CORS
preflight, which this app never grants. So skipping CSRF for token-authenticated requests does not
weaken anything, and session-authenticated requests keep the existing check verbatim (proven by the
existing `csrf: false → 403` assertion).

### 4.3 `server/app.mjs` wiring

```js
const tokens = options.tokens || createTokens({ store, config });
const auth = createAuth({ store, config, tokens });
app.use('/api', auth.identify);              // now resolves cookies AND bearer
...public auth routes unchanged...
app.use('/api/tokens', auth.requireSession, auth.checkOrigin, auth.csrf);  // mounted BEFORE the blanket guard
app.use('/api', auth.requireAuth, auth.tokenGuard, auth.checkOrigin, auth.csrf);
```

Ordering is the security-critical part:

1. `/api/tokens*` is mounted **before** the blanket `requireAuth`, and is gated by
   `requireSession` — so a token principal gets a plain 401/403 there and can never manage tokens
   (PRD security point 4). `tokenGuard` would also catch it, but two independent barriers for the
   escalation path is intentional.
2. `tokenGuard` runs for every other `/api` route and rejects token principals whose route/scope is
   not on the allowlist (`TOKEN_ALLOWLIST` in `tokens.mjs`, table in §6).
3. `checkOrigin` and `csrf` keep applying to all routes; `csrf` self-exempts token requests as above.

`close()` also calls `tokens.close()`.

### 4.4 HTTP contract

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `GET` | `/api/tokens` | session | — | `200 [{ id, name, prefix, lastFour, masked, scopes, enabled, createdAt, lastUsedAt, expiresAt, expired }]` |
| `POST` | `/api/tokens` | session | `{ name, scopes, expiresAt? }` | `201 { ...masked, secret }` — **the only time `secret` appears** |
| `PATCH` | `/api/tokens/:id` | session | `{ name?, enabled?, expiresAt? }` | `200 masked` / `404 TOKEN_NOT_FOUND` |
| `DELETE` | `/api/tokens/:id` | session | — | `204` / `404 TOKEN_NOT_FOUND` |

Validation (zod, server-side, in `tokens.mjs`):
- `name`: trimmed, 1–64 chars, no newlines/control chars.
- `scopes`: non-empty array, each in `TOKEN_SCOPES`, deduped. Empty → `400 TOKEN_SCOPES_REQUIRED`
  (fail-closed, mirroring newapi's "empty permission set is rejected").
- `expiresAt`: `null` (never) or an ISO timestamp **at least 1 hour in the future** (newapi uses the
  same one-hour floor; it prevents "create a token that is already dead").
- `enabled`: boolean.

Error codes: `TOKEN_NOT_FOUND`, `TOKEN_SCOPES_REQUIRED`, `TOKEN_NAME_INVALID`,
`TOKEN_EXPIRY_INVALID`, `TOKEN_SCOPE_FORBIDDEN`, `TOKEN_INVALID`, `SESSION_REQUIRED`.
`TOKEN_INVALID` is returned for *every* Bearer failure (missing token row / disabled / expired /
malformed) so the response cannot be used as an oracle.

### 4.5 Audit

There is no audit store, and adding one is out of scope (§6 of research). Instead the token table
itself carries `created_at`/`last_used_at`, and the three security-relevant events are recorded as
**application log lines via the existing redacting path** (`store.redact` + `console.warn` when
`BACKUP_TOKEN_LOG` is set? — no; see below):

Decision: security events go to `process.stderr` through a tiny `logSecurity(event, detail)` helper
in `tokens.mjs` that passes `detail` through `store.redact()` and never includes secrets. Events:
`token_created`, `token_revoked`, `token_rejected` (with the reason bucket: `missing|disabled|
expired|unknown|scope`). This satisfies PRD "若系统已有审计/事件日志…要记录" honestly: there is no
audit table, so we use the only durable log stream available and cover exactly create/revoke/failed
use.

---

## 5. Scope model

```
read  ⊂ run
```

- `read` → `GET` endpoints on the allowlist.
- `run` → the two mutating endpoints (`/jobs/:id/run`, `/runs/:id/cancel`) **and** everything `read`
  allows (an operator who can trigger a backup must be able to watch it finish; forcing two tokens
  for one cron job would push people toward an admin cookie, defeating the purpose).
- Anything else → `403 TOKEN_SCOPE_FORBIDDEN`.

`hasScope(principal, 'read')` returns true when the principal has `read` **or** `run`. `run` is
checked literally.

---

## 6. Bearer allowlist (the complete, closed list)

| Route | Method | Needed scope |
|---|---|---|
| `/api/overview` | GET | `read` |
| `/api/jobs` | GET | `read` |
| `/api/jobs/:id` | GET | `read` |
| `/api/runs` | GET | `read` |
| `/api/runs/:id` | GET | `read` |
| `/api/storage` | GET | `read` |
| `/api/jobs/:id/run` | POST | `run` |
| `/api/runs/:id/cancel` | POST | `run` |

Everything not in this table — and every non-`GET` on the `read` rows — is denied for tokens,
including (explicitly, because each one is a takeover path): `POST/PATCH/DELETE /api/jobs*`,
`/api/jobs/batch`, `/api/settings*`, `/api/tokens*`, `/api/system/import`,
`/api/storage/local-archives*`, `/api/sources`, `/api/rclone/*`, `/api/settings/test-email`,
`/api/jobs/:id/archives*` (download hands out archive bytes → not for tokens),
`/api/auth/logout`.

The matcher is a table of `[method, pathRegex]` pairs, not a prefix test, so `/api/jobs/:id/run`
matches but `/api/jobs/:id` with `POST` does not.

---

## 7. Frontend design (`web/src/components/TokensView.vue`)

Self-contained new file; no edits to `App.vue`/`style.css` until `SHELL-DONE`.

- **Own data only.** Fetches `/api/tokens` itself, like `StorageView`/`SettingsView` do (they own
  their own fetches), keeps the parent shell out of it. Emits `message(text)` for the toast, matching
  the existing `@message="notify"` convention.
- **State**: `loading`, `error`, `list`, `createOpen`, `createdSecret`, `editing`, `deleting`, `busyId`.
- **List rows** (one table, one metric each — respects the "no duplicate elements" constraint):
  name · `akb_…c3d4` mono mask · scope chips · status chip (`启用` / `已停用` / `已过期`) ·
  `创建` · `最近使用` (`从未`) · `过期` (`永不过期`) · actions (改名 / 启停 / 删除).
  Expired is derived (`expiresAt && Date.parse(expiresAt) <= Date.now()`); a disabled+expired token
  shows `已停用` (the actionable state wins) with the expiry column still red.
- **Create dialog**: name, scope checkboxes (`read` 只读 / `run` 触发与取消), expiry select
  (永不过期 / 30 天 / 90 天 / 1 年 / 自定义 `datetime-local`). Submits `POST /api/tokens`; on `201`
  the dialog switches to the **secret reveal** state: read-only mono input + 复制 button
  (`navigator.clipboard.writeText` with a `document.execCommand('copy')` fallback, since clipboard
  may be blocked on http origins) + the warning «复制并保存:关闭后将无法再次查看». Closing the
  dialog clears `createdSecret` from memory.
- **Rename / expiry**: a small edit dialog → `PATCH`. Enable/disable is an inline switch →
  `PATCH { enabled }`. Delete is a confirm dialog → `DELETE`.
- **Styles**: only existing utility classes (`.button`, `.icon-button`, `.field`, `.table-wrap`,
  `.status`, `.notice`, `.tag-chip`, `.empty-state`, `.segmented`). No new CSS block, no new radius,
  so the ≤8px radius rule is satisfied by inheriting the shell's tokens — and it is revision-proof
  against ui-shell's rewrite.
- **Accessibility**: every icon-only button has `title` + `aria-label` in Chinese, matching the rest
  of the console. Labels use `<label class="field">` so `check-browser` can use `getByLabel`.
- **Nav wiring after `SHELL-DONE`**: one entry in ui-shell's nav registry
  (`{ id: 'tokens', label: '令牌管理', icon: KeyRound }`) + one `v-else-if="page === 'tokens'"`
  branch. Two lines, committed immediately.

### Types (`web/src/types.ts`, additive only)

```ts
export type TokenScope = 'read' | 'run';
export interface ApiToken {
  id: string; name: string; prefix: string; lastFour: string; masked: string;
  scopes: TokenScope[]; enabled: boolean; createdAt: string;
  lastUsedAt: string | null; expiresAt: string | null; expired: boolean;
}
export interface ApiTokenCreated extends ApiToken { secret: string }
```

---

## 8. Compatibility & rollback

- **Backward compatible.** No existing route, response shape, or stored record changes. The new
  table is additive; an old `state.sqlite` gains it on first boot of the new code.
- `createAuth({ store, config })` without `tokens` still works (used by current tests), so the
  change cannot break a caller that has not been updated.
- **Rollback** = revert the commit(s). The `api_tokens` table can remain; nothing reads it. No data
  migration is bundled, so there is nothing to un-migrate. Deleting the table is also safe.
- **Parallel-worktree safety**: no edits to `shared/contracts.mjs`, `server/store.mjs`,
  `web/src/App.vue`, `web/src/style.css` (pre-`SHELL-DONE`), and a single contiguous append to
  `scripts/check-browser.mjs`. Commit with explicit path arguments only.

---

## 9. Test plan

### `tests/api.test.mjs` (new block, appended)

The existing `fixture()` builds `createApp` with injected stubs and no `tokens` option, so the new
module is created from the real `config`/`store` — which is exactly what we want to exercise.

1. Creation returns a secret exactly once; `GET /api/tokens` never contains `secret`, `hash`, or the
   plaintext; the stored row's `hash` equals `sha256(secret)` (read via a second `createTokens`).
2. Scope enforcement: a `read`-only token → `GET /api/overview` 200, `POST /api/jobs/:id/run` 403
   `TOKEN_SCOPE_FORBIDDEN`; a `run` token → both 200/202.
3. Disabled → 401 `TOKEN_INVALID`; expired → 401; garbage/missing Bearer → 401 with the identical
   body (no oracle); a session cookie request without `x-csrf-token` still 403 (regression guard).
4. A token cannot manage tokens: `GET/POST/PATCH/DELETE /api/tokens*` → 401/403, and no token is
   created.
5. A token cannot reach configuration: `POST /api/jobs`, `PATCH /api/settings`,
   `POST /api/system/import` → 403.
6. `lastUsedAt` is set by a successful token call and does not churn within the 60 s throttle
   (assert it is unchanged immediately after a second call).
7. Validation: empty scopes → 400; expiry < 1 h → 400; name with newline → 400; unknown id →
   404.
8. Revocation: after `DELETE`, the same Bearer → 401.
9. Redaction: a rejected request's body contains neither the token nor its hash.

### `scripts/check-browser.mjs` (appended near the end)

After the existing task/run flow, while still authenticated:

- navigate to the tokens page, assert the empty state;
- create a token (name + `run` scope), read the one-time secret from the input, copy via the button,
  assert the dialog warns it will not be shown again;
- close, assert the row shows the mask and never the secret;
- disable → status chip changes; re-enable;
- rename; then `DELETE` the token and assert it is gone;
- use the created secret through the page context once (before deleting) to prove a real Bearer call
  works end to end: `GET /api/overview` with `Authorization: Bearer …` → 200, and
  `GET /api/tokens` with the same header → 401/403;
- screenshot desktop + mobile.

---

## 10. Open questions / defaults chosen (no blocking)

| Question | Default chosen |
|---|---|
| Should `run` imply `read`? | Yes — a single token must be able to trigger *and* poll. |
| Hard delete vs. soft revoke? | Hard delete. The hash *is* the credential; nothing of value remains, and a soft-deleted hash would still need to be checked on every request. |
| Store `lastUsedIp`? | No — untrusted proxies make it misleading. |
| Per-token rate limit? | No — out of scope; the API is administrator-only infrastructure and existing endpoints have none. |
| Should `/api/sources` be token-readable? | No. Directory listings reveal filesystem layout and are not needed by any §3 use case. |
| Allow archive download with a token? | No — it hands out encrypted backup bytes, and the printer of a token should not need it. |
