# Backend integration notes

## Ownership

Backend API/store/sync is codex p9's assignment. `server/node-paths.mjs`, `tests/node-paths.test.mjs` and the READMEs belong to pi p7; `web/` belongs to pi p4. This note records observed cross-worker contracts without changing their files.

## Token dependency

The current branch has session authentication only. The receiver will use the planned `api_tokens` storage/authenticator contract from `10-18-api-tokens/design.md` and require an explicit `sync` scope. The token-management workstream must expose/issue this scope when it lands. Existing `read`/`run` scopes retain their current privileges. No outbound node token becomes an inbound credential automatically.

## Path-mapping observations

The current mapper accepts `{sources: [{from,to}]}` as its optional third argument, while the PRD and UI use `jobOverrides[jobId].sources: string[]`. Backend applies these string overrides as final source paths and uses `mapPath(path, rules)` for paths without an override.

The initial module currently ignores volume identity during prefix matching. These observed probes incorrectly return `{path:'/backup/data', mapped:true}`:

```js
mapPath('D:/srv/data', [{from:'C:/srv',to:'/backup'}]);
mapPath('//other/share/srv/data', [{from:'//host/share/srv',to:'/backup'}]);
```

They should remain unmapped and require mapping. This defect belongs to pi p7's module and is not repaired in backend-owned files. Recheck against its final version before final integration.

The Windows comparison form also currently lowercases the unmatched suffix: `mapPath('C:/Data/CaseKeep/Sub', [{from:'C:/Data',to:'/dest'}])` returns `/dest/casekeep/sub`. Matching may ignore case, but the suffix must retain `CaseKeep/Sub` when the destination is case-sensitive. This is another mapper-owned correction.

## UI response vocabulary

The currently added UI types consume per-task `synced | unmapped | failed` and node summaries `succeeded | partial | failed`. Backend will use these spellings and include a `jobs` array with the sync counts, keeping the shared node input fields unchanged.

## Implemented HTTP contract

Node administration requires an administrator session, same-origin requests and CSRF on mutations:

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/nodes` | Public node array |
| POST | `/api/nodes` | 201 public node |
| GET / PATCH | `/api/nodes/:id` | Public node |
| DELETE | `/api/nodes/:id` | 204 |
| POST | `/api/nodes/:id/test` | `{ok:true, version:'azurekiln-sync-v1', jobs, message}` |
| POST | `/api/nodes/:id/sync` | Sync summary |

Public nodes include `tokenSet`, `lastSyncAt`, `lastStatus` and `lastSync`; never `token`. Omitted/empty token updates preserve the configured value. `pathRules` and `jobOverrides` replace as whole collections, so `[]` and `{}` clear them. Sync summary is `{at,status,total,synced,unmapped,failed,jobs}`. Each result has `jobId`, `status` and optional `jobName`, `sources`, `unmapped`, `remoteJobId`, `code`, `message`, `paused`.

Receiver routes use `Authorization: Bearer <API token>` with `sync` scope, independently of administrator cookies:

| Method | Route | Request / response |
| --- | --- | --- |
| GET | `/api/sync/status` | `{ok:true, version:'azurekiln-sync-v1', jobs}` |
| PUT | `/api/sync/jobs` | `{jobs:[{syncKey,job}]}` → Sync summary |

The receiver validates each definition independently; invalid definitions appear as failed jobs in a successful summary response. Invalid batch envelopes fail validation. Incoming credentials are rejected; new definitions missing node-local credentials synchronize as paused jobs. System tasks are excluded, and already-received tasks are not pushed onward. This prevents self-sync and peer-sync loops.
