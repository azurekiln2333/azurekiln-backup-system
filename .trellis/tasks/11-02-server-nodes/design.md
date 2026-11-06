# Server nodes: backend design

This document covers the assigned backend API, storage and synchronization work only. The parent PRD and this task's PRD are the requirement sources; the UI, path-mapping module and README updates belong to other workers.

## Boundaries

The current runtime has no node inventory or task synchronization. Add the behavior at its existing owners: shared Zod contracts, the SQLite store, a focused node synchronization service and Express route wiring. Expected implementation files are `shared/contracts.mjs` (additive node/sync exports), `server/store.mjs` (node storage, secret redaction and durable sync identities), `server/app.mjs` (route/service wiring), new node backend modules, and `tests/nodes.test.mjs`. Do not edit frontend files, notification implementation, `server/node-paths.mjs`, its tests, READMEs, token management implementation or unrelated specs.

## Storage and identity

Create additive SQLite tables for nodes and incoming task sync identities. Nodes use existing AES-256-GCM helpers for `token`, expose only `tokenSet`, and preserve a configured token on omitted/blank updates. Node CRUD is independent of jobs and execution history. Runtime-owned sync timestamps/status cannot be set by a client patch. A stable incoming `syncKey` identifies one local job across repeated requests and restarts; imported tasks get local IDs and do not overwrite unrelated local jobs. Deleting a synced job must remove its sync identity through foreign-key cascading.

## Push and receive

Node management uses administrator sessions and the existing CSRF/origin boundary. Provide CRUD plus connection testing and `POST /api/nodes/:id/sync`. Return per-task `synced`, `unmapped` or `failed` results and persist the latest sanitized summary with node status `succeeded`, `partial` or `failed`, matching the UI types. Push only schema-projected task definitions, excluding runtime metadata and archive/database passwords; never send settings, runs, logs or other nodes. Exclude the built-in system job. Incoming `PUT /api/sync/jobs` validates local source roots, cron, task type and destinations before upserting each definition, preserving local credentials and runtime metadata. New encrypted definitions that need node-local credentials must remain paused and explicitly report the missing configuration; they must not become executable by silently dropping encryption.

Use `server/node-paths.mjs`'s `mapPath(path, rules, overrides?)` contract, with a test-injectable mapper while pi p7 implements the module. Do not create or change that module. The temporary default must fail closed for absolute paths when the module is absent. Source overrides are final node-local paths and take precedence over rules. Map all source-bearing fields relevant to the task type, including database TLS files, and any absolute destination paths. An unmapped absolute path skips the entire task. Relative remote destination paths remain relative. Existing destination validation remains authoritative; do not invent a new destination storage type.

## Transport and authentication

Allow validated explicit HTTP(S) node base URLs, including private addresses used by peer deployments, following the current administrator-configured network-service convention. Reject credentials, query/fragment and unsafe schemes; preserve a supported base path. Do not follow redirects with a Bearer token. Bound outbound requests and sanitize all remote failures without returning raw remote response text or credentials.

The current branch does not yet contain `server/tokens.mjs`; its planned `api_tokens` table and authentication contract live in `../10-18-api-tokens/design.md`. Receiver authentication must fail closed and must not accept a node's outbound token as an inbound credential. Use an existing token authenticator when supplied, or a narrow compatibility reader of that planned table without issuing/managing tokens. Task-definition writes require a dedicated `sync` scope, keeping existing `read` and `run` privileges unchanged. Document the token-management dependency and the new scope in the backend handoff; do not implement or modify the separate token-management workstream.

## Verification

Exercise real HTTP/SQLite CRUD and restart persistence, token sealing/redaction, auth/CSRF, URL rejection and redirect handling, two nodes mapping one task differently, overrides, whole-task skips, stable repeated receive/push, preservation of receiver credentials/history, and transport failures. Use isolated temporary state and injectable path mapping. Run the complete `npm test` suite, type check and production build; record external dependency limits in `done.md`. No git commit.

## November 7, 2026: deployment filename follow-up

The user additionally requested changing project YAML filenames from `.yaml` to `.yml` after asking whether work was committed/pushed. This explicitly extends the earlier backend-only boundary to deployment filename references. Rename root `compose.yaml` and `compose.build.yaml` to `compose.yml` and `compose.build.yml`; update their contents, current deployment instructions/examples, release packaging/CI checks and relevant tests. Prefer `compose.yml` in default runtime discovery, retaining discovery of an existing legacy `compose.yaml` deployment. Explicit `SYSTEM_COMPOSE_FILE` remains authoritative. Do not rename Trellis's fixed `.trellis/config.yaml`, rewrite archived task history, or change serialized backup-member names (`deployment-compose.yaml`, new-api `config/compose.yaml`) and existing restore output contracts. Preserve all earlier workers' edits. The status question does not revoke the earlier no-commit instruction; do not stage, commit, push or archive.

## November 7, 2026: final filename and commit authorization

The user clarified the requested filename as `docker-compose.yml`. This supersedes the shorter root filenames in the previous amendment: use `docker-compose.yml` and `docker-compose.build.yml`, updating the same deployment, README, release/CI, configuration and test files. Runtime discovery must prefer `docker-compose.yml`, then `docker-compose.yaml`, `compose.yml` and `compose.yaml`, while an explicit `SYSTEM_COMPOSE_FILE` remains authoritative. Preserve archive/restore names and Trellis framework configuration. No backup or notification implementation expansion is needed.

The user then explicitly requested standardized Git commit messages and submitting the work. This authorizes the main session to stage this assignment's changes, create Conventional Commits and push `feat/nodes-and-notify` to `github`. It supersedes this assignment's earlier no-commit restriction. Keep unrelated workers' files and shared-file hunks outside the commits, never discard them, and do not archive the shared task whose other lanes remain in progress.
