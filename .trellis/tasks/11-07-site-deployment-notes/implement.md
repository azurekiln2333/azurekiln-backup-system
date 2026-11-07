# Implementation checklist

- [x] Inspect cloud-build config, site schema/store/editor, existing tests and backend/frontend specs; record the metadata-only boundary.
- [x] Implement cloudImages/watchtowerAutoUpdate in shared validation and explicit persistence/projection with backward-compatible defaults.
- [x] Add image-list and Watchtower-note controls to the site editor using existing components/styles.
- [x] Add meaningful HTTP/SQLite/restore and focused browser regression checks.
- [x] Independent feature review; run appropriate full tests, check/build and browser/layout checks sequentially; inspect screenshots.
- [ ] Repair confirmed CI rclone provisioning/capability and numeric environment-key discovery, cover invalid installer inputs and verify a subsequent cloud run.
- [x] Update backend/frontend executable contracts and task done.md with results/limits.
- [ ] Commit only this task's changes and push/merge the authorized branch without altering parallel WIP.

The previously submitted nodes/deployment commits were fast-forward merged into remote main at `fa233a7` on November 7, 2026. This feature follows that merge and does not archive the still-shared nodes task.
