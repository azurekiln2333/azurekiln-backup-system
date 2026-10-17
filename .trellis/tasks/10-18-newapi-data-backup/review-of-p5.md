# Review of newapi-data-backup (p5) — by ui-shell (p3)

Review date: 2026-10-18. Reviewer pane: **w1H:p3**. Author pane: **w1H:p5**.

Commits reviewed:

| Commit | Scope |
|---|---|
| `1ca08e1` | research ×2, design.md, implement.md, jsonl |
| `844cf6c` | `shared/contracts.mjs` newapi type + block; `server/store.mjs` secrets |
| `fde4f02` | `server/newapi.mjs` (456 lines), `app.mjs` validation hook, `backup.mjs` integration |
| `41dc97f` | `tests/newapi.test.mjs` (324 lines, 8 tests) |
| `8f97fc6` | `NewApiFields.vue`, `JobEditor.vue`, `types.ts` |
| `23993c6` | README ×3 + `backlog-lifecycle.md` |
| `68c35c0` | `sourcePath` contract comment + review of p2 |

## Verdict

**The core data path is genuinely good — but there are 4 real defects and 3 documentation/coverage gaps that must be fixed before this can be called a faithful "restore to an identical machine" backup.**

What is right (and I verified by reading + probing, not by trusting the tests):

- **SQLite really does use the online backup API**, not a file copy: `snapshotSqlite()` drives `sqliteBackup(database, targetPath, {rate: 128, …})` on a `readOnly` connection, then re-opens the target, forces `journal_mode=DELETE`, and runs `PRAGMA integrity_check` before accepting it. This is the correct way to snapshot a live WAL database, and it is the single most important design decision in the task. ✅
- **Path sandboxing is real.** Every path (`dataDir`, `sqlitePath`, `envFilePath`, `composeFilePath`, `serviceFilePath`, `proxyConfigPath`, `pluginsPath`, `logsPath`, TLS files) goes through `resolveSourcePath`, which rejects relative paths and anything outside `SOURCE_ROOTS`; symlinked data dirs are rejected (`SOURCE_SYMLINK_FORBIDDEN`). ✅
- **Secrets do not leak.** DB passwords are registered in `store.mjs` `jobSecrets`, so they are encrypted at rest and stripped from API responses; `newApiSecrets()` feeds the shared `redact()` for every log line; the MySQL password travels via a `--defaults-extra-file` (deleted in `finally`) and the PG password via `PGPASSWORD` env, never argv. I scanned **every archived file** for the archive/main/log passwords — only `config/env` matched, which is by design (`.env` must be restored verbatim). ✅
- **Source code and images are never archived.** The payload is purpose-built (`db/`, `config/`, `data/`, optional `logs/`, `plugins/`, `proxy/`); the new-api source tree is never walked, and `docker-image` is only a declarative `excluded` entry. ✅
- Plaintext / non-encrypted archives are refused (`NEWAPI_ARCHIVE_REQUIRED`), which is correct given `.env` carries `CRYPTO_SECRET`. ✅

---

## Defects to fix

### D1 (must fix) — `includeLogTable=false` is silently ignored for SQLite, and the warning states the opposite

`sqliteTableDigests()`/`snapshotSqlite()` always snapshot the whole file. The `includeLogTable` flag is only implemented for MySQL, via `--ignore-table=<db>.logs` in `mysqlDumpArguments()`. Yet:

- `mainDatabase.logsIncluded` is set from `api.includeLogTable` regardless of dialect, so the manifest **claims** `logsIncluded: false`;
- `newApiScopeWarnings()` pushes `"The logs table is excluded; consumption and token history will be missing after restore."` regardless of dialect;
- `NewApiFields.vue:97` renders the "包含 logs 表" checkbox for **every** dialect including SQLite.

Reproduced with my own probe:

```
includeLogTable=false + sqlite -> snapshot still has logs rows = 1
manifest.mainDatabase.logsIncluded = false
manifest.warnings = ["The logs table is excluded; ...", "LOG_SQL_DSN is unset, ..."]
=> contradiction: warning claims logs excluded, but 1 log rows are archived
```

Why it matters: the manifest is the contract a restorer trusts. Here it is factually wrong, and it produces two mutually contradictory warnings on the same run. A user who ticked "exclude logs" gets the logs anyway while being told they are gone.

**Required fix** — pick one and make manifest, warning and UI agree:
- *(preferred)* Reject the combination at validation time: if `dbType === 'sqlite'` and `!includeLogTable`, throw `NEWAPI_RESTRICTION`-style 400 explaining that a SQLite snapshot cannot drop a single table, and hide/disable the checkbox in `NewApiFields.vue` for SQLite.
- *or* actually delete the `logs` rows from the snapshot (open the copied snapshot read-write, `DELETE FROM logs`), and keep the warning.
- *or* keep archiving them, but force `logsIncluded: true` in the manifest and drop the "excluded" warning when the dialect is SQLite.

Also: the two warnings contradict each other when `logDbType === 'same'` (one says logs are excluded, the other says they are archived with the main DB). Only one may be emitted.

### D2 (must fix) — `tableDigest()` crashes on `WITHOUT ROWID` tables; the manifest then silently loses its content hash

```js
const rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
```

`rowid` does not exist on `WITHOUT ROWID` tables or on views. `sqliteTableDigests()` catches the throw and degrades to `{ name, rows, sha256: null }`.

Reproduced:

```
2. WITHOUT ROWID table: tableDigest THROWS -> no such column: rowid
2b. sqliteTableDigests on WITHOUT ROWID -> [{"name":"options","rows":2,"sha256":null}]
```

Why it matters: the task's headline promise is "verify table by table, content hash included". A table with `sha256: null` passes the round-trip assertion in the test only because **both sides** compute the same `null` — the comparison is `assert.equal(actual.sha256, expected.sha256)`, so `null === null` succeeds. That defeats the check rather than reporting it.

**Required fix**: order by the declared primary key (read it from `PRAGMA table_info` / `sqlite_master.sql`), falling back to `ORDER BY rowid` only when a rowid exists. If no stable ordering is derivable, either hash a sorted projection of all columns or record an explicit `sha256: null` **and** surface a run warning so a null hash is never mistaken for a verified one. The round-trip test should additionally `assert.ok(expected.sha256, …)` so a null hash fails loudly.

### D3 (should fix) — the "round-trip" test never touches the archive

```js
// tests/newapi.test.mjs:277
await cp(path.join(payload, 'data'), restoredData, { recursive: true, force: true });
```

The test copies the **payload staging directory** into the simulated restored machine. It never creates a 7z archive and never extracts one. `grep` over the test file shows `7z` only ever appears as a *contract* string (`archive.format`) or in `RESTORE.md` assertions — no `7z` binary is invoked.

So the round trip proves "the files I wrote are the files I can read back", not "the encrypted archive written by `backup.mjs` extracts into a restorable state". Since the archive step is where a wrong `targz`/`7z` working directory, a missed payload entry, or a bad password flag would actually bite, this is the gap between the test's name and what it tests.

**Required fix**: add a test that runs the real 7z binary over the payload (the repo already depends on it in `check-browser.mjs` fixture setup and `.artifacts/tools/7zip`), extracts to a fresh dir with the archive password, and *then* runs the table-by-table comparison. Skip with the existing `skip: !liveTools` convention when 7z is absent.

### D4 (should fix) — `sqlitePath` is sandboxed to `SOURCE_ROOTS` but not to `dataDir`

Reproduced: a `sqlitePath` pointing at a *different* file that happens to live inside a source root is accepted:

```
8. sqlitePath pointing OUTSIDE dataDir but inside source root accepted? ACCEPTED
```

This is defensible (an operator may legitimately keep the DB elsewhere) but it is unvalidated intent: the manifest then archives a database unrelated to the configured `dataDir`, and `mainDatabase.database = path.basename(source)` gives no hint that the DB lived outside the data directory. At minimum this should emit a run warning; ideally the manifest should record the resolved absolute database path so a restorer can detect the divergence.

## Documentation / accuracy

### D5 — RESTORE.md prints an empty verification table for PostgreSQL/MySQL

For non-SQLite dialects `mainDatabase.tables = []`, but `buildRestoreDocument()` unconditionally emits:

```
逐表行数必须与下列清单一致(在库内执行 `SELECT count(*) FROM "<表名>"`):

| 表 | 行数 |
| --- | --- |
```

i.e. a header with zero rows. The restorer is instructed to verify against nothing. Should say that per-table digests are unavailable for this dialect and give the actual verification command instead.

### D6 — RESTORE.md log-database placeholders are not executable

For `log.type` of postgresql/mysql the guide emits:

```
docker compose exec -T <db> <restore-tool> restore/db/log.xxx mysql <placeholder-db>
```

`<db>` / `<restore-tool>` are literal angle-bracket placeholders. For a "restore to an identical machine" deliverable the concrete command (as already done for the main database) is expected.

### D7 — manifest `recoveryPoint` is a second `now()`, not the snapshot instant

```js
generatedAt: now(), recoveryPoint: now(),
```

Two separate clock reads, and neither is taken at the moment the database snapshot completed. `recoveryPoint` is the field a restorer uses to reason about data loss windows, so it should be captured immediately after the main-database snapshot and reused.

## Positive notes on process

- `1ca08e1` is a genuinely strong planning artifact (inventory + backup rules + design), better than the minimum the workflow asks for.
- `mysqlOptionFile()` escaping (quotes, backslashes, newlines → `\n`) and `mysqlDumpArguments()` terminating the identifier with `--` are the right defensive choices; the `--` terminator in particular prevents a database name being parsed as a flag.
- `MANUAL_LOG_TYPES`/`newApiScopeWarnings()` correctly refuses to pretend ClickHouse was exported.

## Requested action from p5

1. Fix **D1** and **D2** (these are correctness bugs in what the manifest promises).
2. Fix **D3** so the round-trip test goes through the real encrypted archive.
3. Fix **D4** with at least a warning.
4. Correct **D5**, **D6**, **D7** in `RESTORE.md`/manifest generation.
5. Add the missing assertions (`sha256` must be non-null; warnings must not contradict).
6. Re-run `npm test` and post `DONE`/`PROGRESS` on the board with the commit SHAs.
