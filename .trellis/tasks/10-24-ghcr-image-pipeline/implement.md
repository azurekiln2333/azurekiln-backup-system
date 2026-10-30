# Execution plan

Status: planning. Do not edit product files or run task.py start until the user approves the revised final summary.

## Planning and review

- [x] Reuse the task whose creation was approved on 2026-10-24; incorporate the 2026-10-26 expanded request.
- [x] Locate the local cnb2api-panel reference and inspect its delivery files read-only.
- [x] Locate the correct Herdr workspace by repository cwd rather than inherited stale workspace IDs.
- [x] Restore the two exited Pi processes in their existing shell panes; keep the four existing panes and models.
- [x] Assign read-only GitHub, CNB, Compose/update, and integration research to the four Pi agents.
- [x] Confirm current remote/main ancestry (68 existing outgoing commits) and preserve uncommitted repository-host fallback edits.
- [ ] Integrate all available Pi findings, resolve technical contradictions, and record research evidence.
- [ ] Curate and validate both context manifests, perform PRD convergence, and present the final planning summary.
- [ ] Obtain subsequent user approval, then run task.py start. This check is a phase gate, not a task-creation question.

## Pi ownership after approval

Every dispatch begins with `Active task: .trellis/tasks/10-24-ghcr-image-pipeline`. Each Pi loads manifests, PRD, design, implementation plan, and applicable before-dev specs. All share one worktree, must preserve others' edits, and cannot commit/push/publish/deploy on their own.

1. Pi in `w1H:p8`: own `.github/workflows/build-and-release.yml`, `scripts/prepare-release.mjs`, and meaningful release-helper tests. Establish shared metadata and asset interfaces before the other workflow consumes them.
2. Pi in `w1H:p6`: own `.cnb.yml`. Consume agreed shared interfaces; validate official selectors, variables, Release/attachment facilities, Docker credentials, concurrency, and multi-architecture support. No separate publish path may bypass checks.
3. Pi in `w1H:p4`: own `compose.yaml`, `compose.build.yaml`, `.env.docker.example`, `.dockerignore`, and the three README files. Retain existing README repository-link edits. Confirm actual updater upstream/version/credential contract before pinning it.
4. Pi in `w1H:p7`: own `scripts/ci-verify.sh` and `scripts/check-image.sh`, then perform independent integration review of the other three lanes under trellis-check. A different Pi reviews these verification scripts. Reviewers coordinate fixes with file owners to prevent overlapping writes.

The main session owns integration decisions, task artifacts, spec updates, verification scheduling, and the final approval/commit gate. Use existing Pi agents rather than silently substituting native Codex agents. Rediscover live IDs after any Herdr session reload.

## Ordered implementation

- [ ] Capture current scoped diffs and file ownership. Do not stage/reset old task, journal, auth, agent, or user archive paths.
- [ ] Finalize shared release metadata/output and verification helper interfaces; announce them to all four lanes.
- [ ] Add version/tag validation, stable/prerelease/channel handling, deployment bundle/checksum generation, and exclusion tests as warranted.
- [ ] Add shared real-tool verification and disposable image smoke commands; define environment/output contracts for both workflow callers.
- [ ] Implement GitHub verification, tag-only publication, minimal permissions, version/revision images, Releases/assets, and guarded stable promotion.
- [ ] Implement matching CNB behavior in ordered stages, deriving the receiving repository registry path and using verified build facilities.
- [ ] Switch base Compose to prebuilt images; add the explicit local-build model, scoped updater, defaults/disable/monitor controls, and safe persistence-preserving migration.
- [ ] Finish consistent documentation for both registries, first publication/access, pull deployment, automatic/manual updates, interruptions, pinning, rollback, and local builds.
- [ ] Perform cross-lane review and fix task-owned defects. Verify no product/API backup behavior was unintentionally changed.
- [ ] Update the reusable deployment/CI contract in .trellis/spec/backend/backup-lifecycle.md while retaining the host-fallback edits.
- [ ] Prepare a path-limited commit plan and exact outgoing history disclosure. Obtain the required batched user confirmation before commit/upload.
- [ ] Observe remote runs/publication if subsequently approved and available; report actual image references/digests and remaining owner-only operations. Finish/archive only after actual completion.

## Validation

- Release helpers: strict/mismatched tags, prereleases, older stable reruns, package version consistency, deterministic metadata, checksum correctness, and exclusion of private/local content.
- Workflow: actionlint or an appropriate equivalent; YAML structure; platform event selectors; verification dependencies; least permissions; no PR/manual-branch publish escape; stable promotion and rerun behavior. Official CNB facilities must be checked rather than treating generic YAML parsing as platform validation.
- Compose: resolve the default and explicit local-build models using a throwaway environment. Assert image/no-build defaults, all preserved mounts/volume/port/grace contracts, unique effective scope, updater exclusion rules, local update label false, and explicit handling of an already-running updater.
- Application: npm run check, npm test with real tools/integration enabled, npm run build. Report the existing executor full-suite concern honestly if reproduced; investigate task regressions without silently broadening unrelated scope.
- Browser: npm run check:browser followed by npm run check:layout, with matching Chromium path. Run sequentially and inspect relevant regression output.
- Image: disposable build/start/HTTP/tool checks, no production mounts. Multi-platform build output and per-architecture execution results are separate claims.
- Updater when Docker is available: enabled-container selection, project-scope isolation, updater-self exclusion, no-build disable, persistence through recreation, interruption behavior, and pinned rollback. Record unavailable tests rather than claiming they passed.
- Final: git diff --check, path-limited status/diff review, task/context consistency, and actual remote evidence if any publication was authorized and performed.

## Rollback boundaries

Restore only task-owned deployment/workflow changes when needed. Never delete persistent volumes, change the deployment project identity, overwrite operator mount choices, or revert unrelated edits. A server rollback selects an earlier image after disabling automatic updates; it does not restore application data by itself.
