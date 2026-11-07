# Implementation plan

- [x] Read parent/child PRDs, template interface, backend runtime contracts, and shared guides.
- [x] Add validated aggregation defaults while preserving template fields and old stored settings.
- [x] Implement the store-backed batch coordinator with quiet-window/deadline scheduling, recovery, default/template rendering, serialized delivery, and shutdown.
- [x] Route completion delivery through the coordinator and retain immediate start notifications / window-zero behavior.
- [x] Add meaningful notification tests and adapt legacy immediate SMTP fixtures if necessary (19 focused tests passed).
- [x] Run focused tests, `npm test`, `npm run check`, and `npm run build`; review changes against task boundaries. Independent Trellis review found no remaining issues.
- [x] Write `done.md` with the owned changed files, behavior, validation, limitations, and remaining items. Do not commit, archive the task, or edit another task's artifacts.

Rollback is limited to this task's owned hunks and new files; never revert other agents' edits.
