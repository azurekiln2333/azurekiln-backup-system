# Server nodes: backend implementation plan

- [x] Load parent/task PRDs and applicable backend/shared-contract guidelines.
- [x] Add node/sync contracts and additive SQLite persistence with sealed tokens and durable incoming identities.
- [x] Add the synchronization service, conservative path-mapper integration and bounded authenticated transport.
- [x] Wire session-protected node CRUD/test/sync routes and scoped Bearer receiver routes.
- [x] Verify isolated HTTP/SQLite scenarios, path overrides/skips, secret boundaries and idempotent updates.
- [x] Run `npm test`, `npm run check`, `npm run build` and scoped code review; fix backend findings.
- [x] Write backend file changes, API handoff, validation evidence and remaining integration dependencies to `done.md`.

Implementation and review must stay within the backend ownership in `design.md`. Keep other agents' edits intact. Do not commit or archive the shared task.

## November 7, 2026: deployment filename follow-up

- [x] Rename the root Compose files to `.yml` and update current deployment, release/CI and runtime-discovery references, retaining legacy deployment/archive compatibility.
- [x] Review the rename, run appropriate tests and update `done.md`; do not stage, commit or push.

## November 7, 2026: requested `docker-compose` prefix and submission

- [x] Rename the root deployment files to `docker-compose.yml` and `docker-compose.build.yml`; update deployment/release/CI references and ordered discovery with legacy compatibility.
- [x] Independently review the final rename, verify the affected behavior and update specs plus `done.md`.
- [ ] Commit this assignment's changes using Conventional Commits and push the current branch, preserving other lanes' uncommitted work (new user authorization supersedes earlier no-commit instructions).
