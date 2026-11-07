# feat(sites): cloud image references and Watchtower notes

## Goal

Record each site's cloud container images and whether Watchtower auto-pulls updates, without controlling deployments.

## Requirements

- Extend each site's settings with an editable cloud container-image list (`cloudImages: string[]`) and a checkbox labelled `该站点通过 Watchtower 自动拉取更新` (`watchtowerAutoUpdate: boolean`). These fields record the operator's deployment notes only.
- Reuse the existing site create/edit dialog and session-protected CRUD API. Allow adding/removing image rows, optional tag/digest references, and an empty list. Trim references, reject embedded whitespace/control characters, cap the list at 20 entries of 1024 characters and deduplicate exact strings in first-entry order. Preserve case and do not probe registries or store credentials.
- Persist both fields in site metadata, project them in every site read, and retain them through restart and whole-database system backup/restore. Legacy sites default to `[]` and `false` without a bulk rewrite.
- PATCH omission preserves values; `cloudImages: []` clears the list and `watchtowerAutoUpdate: false` clears the note independently. Invalid input rejects the whole site update. Job associations, execution settings and history remain independent.
- Keep editor drafts after validation/server failures and retain the existing accessibility, responsive modal and visual conventions. Add a brief note that the checkbox records an existing deployment arrangement; it does not configure Watchtower.
- Answer the user's CI question from repository evidence: GitHub Actions (`.github/workflows/build-and-release.yml`) and CNB (`.cnb.yml`) verification/tag-release pipelines exist. Do not claim a remote build passed without run evidence.
- Follow up the authorized main merge's confirmed CI failure: use one checksum-pinned compatible rclone installer in GitHub, CNB's shared verification script and the Docker runtime image. Enable the skipped real-tool GitHub cases, reject unsupported encryption CLIs early, and fix the verified numeric environment-key Bash expansion in tool discovery. Keep release triggers and application encryption behavior unchanged.

## Acceptance Criteria

- [x] A site with multiple image references and Watchtower selected saves and reopens with the same normalized list and boolean.
- [x] A site can be saved without image references or Watchtower; older sites remain readable/editable with empty defaults.
- [x] Partial updates preserve omitted values and independently clear either field. Rejected input changes neither metadata nor job links.
- [x] Toggling the note performs only the ordinary site metadata save; it makes no registry/Docker/Watchtower calls or job changes.
- [x] Tests cover HTTP/SQLite persistence, limits/types/normalization, legacy records and restore. Browser verification covers add/remove/save/reopen/clear and desktop/mobile presentation.
- [x] Run appropriate full tests, type-check, build, browser/layout checks and write task `done.md`; preserve unrelated workers' current edits.

## Scope and authorization

The user directly requested implementing these informational site fields. Use the existing deployment and site model; do not add registry authentication, image discovery, build triggers, update scheduling, Docker socket access or deployment control. Keep the shared nodes/notification work separate. Existing session authorization permits standardized commits/pushes; the subsequent request authorizes merging already submitted branch commits into the default branch. No force push or deletion is required.
