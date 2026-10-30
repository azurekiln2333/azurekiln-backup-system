# GitHub/CNB releases, container delivery, and automatic updates

## Goal

Build and publish the application outside the production server. The same source supports GitHub and CNB verification, automatic versioned Releases and ready-to-run container images. Operators install with Compose pull/up and can automatically follow published stable images.

Task creation was approved on 2026-10-24. On 2026-10-26 the user expanded the request to CNB, automatic Releases, automatic image updates, and coordination of the four existing Pi panes, using `D:/My2KProjects/cnb2api-panel` as the reference. This supersedes the old exclusion of unattended updates. The revised planning summary requires approval before implementation.

## Confirmed background

- `compose.yaml:3` builds on the server. Its `backup` service, `backup-data` volume, deployment-file mounts, source/rclone read-only mounts, loopback port, and project-derived volume identity are compatibility requirements.
- `Dockerfile:1-23` builds the frontend and packages Node 24 plus rclone, 7-Zip, tar, SQLite, PostgreSQL, and MariaDB clients. `package.json:7-19` provides the current validation scripts.
- No target GitHub or CNB workflow exists. The reference has `.github/workflows/build-and-release.yml`, `.cnb.yml`, image-based Compose, an explicit build override, and Watchtower. Its implementation is reference evidence, not proof of correct target behavior.
- On 2026-10-26, `git ls-remote` reports GitHub main `c30845e4b94f5b1484a04a85fa18387a53007667`; HEAD `95a5566` is ahead 68 / behind 0. The only remote is `github`, for `azurekiln2333/azurekiln-backup-system`. A target CNB repository has not been established by the evidence.
- `server/app.mjs:362,378-380` stops schedulers and invokes shutdown on SIGTERM. `server/backup.mjs:845-855` aborts active operations and marks queued work interrupted. Automatic replacement can interrupt a backup; this task does not introduce execution draining or automatic retries.
- Existing repository-host fallback edits are uncommitted and must be preserved. The prior full test run had one suite-sensitive executor failure; do not report an entirely green baseline without fresh evidence.

## Requirements

- R1: Both platforms validate ordinary changes and pull requests. Publication depends on successful required verification of the exact publishing source; PR verification cannot publish Releases or images.
- R2: A valid `v<package-version>` tag automatically publishes a Release and image on the receiving platform. Stable releases may advance `latest`; prereleases and older-version reruns cannot replace a newer stable `latest`. Main verification cannot advance the production channel. Automatic version increments are not required.
- R3: Publish GitHub images to GHCR and CNB images to the receiving repository's CNB registry path with platform-issued, minimally scoped credentials. Support `linux/amd64` and `linux/arm64`, source identification, and explicit image overrides. Do not assume a CNB namespace/repository already exists.
- R4: Releases provide a deployment bundle and SHA-256 checksum sufficient to obtain Compose and example configuration without building the app. Reruns handle existing Releases/assets predictably. Exclude private configuration, state, local agents, and user archives.
- R5: Default deployment uses a prebuilt image and no implicit build. Retain `backup`, `backup-data`, project identity, mounts, root execution, loopback exposure, and shutdown behavior. Keep local builds through an explicitly selected override.
- R6: Provide automatic polling/replacement scoped to this application's enabled container. Proposed defaults follow the reference: stable automatic updates enabled, configurable 600-second polling, explicit disable/monitor/pin/rollback instructions. Local builds disable updates. Retain previous images for rollback by default.
- R7: Consistently document update interruption, the updater's Docker-socket requirement, registry access, first publication, installation, migration, manual/automatic updates, pinning, and rollback in all three READMEs. Preserve operator mount choices. Never delete volumes to update.
- R8: Validate workflows, version/channel selection, Compose models, packaging exclusions, real backup-tool tests, and image startup/tools. Distinguish local static checks, actual Docker execution, architecture builds, and observed remote publication.
- R9: Coordinate the four existing Pi panes with explicit ownership and integration review. Preserve unrelated work. Review outgoing commits and obtain the project's commit/publish approval before upload; a normal current-branch push includes 68 existing commits in addition to the new change.

## Acceptance criteria

- [ ] AC1 (R1): GitHub/CNB PR and branch paths run required checks without publishing; failed tag verification prevents Release and image publication.
- [ ] AC2 (R2, R3): Matching stable tags produce versioned, traceable amd64/arm64 images; prereleases stay separate; main and older-tag reruns cannot downgrade `latest`. Invalid/mismatched tags fail before publication.
- [ ] AC3 (R3, R4): Workflows derive correct metadata, use appropriate credentials/permissions, and attach an installation bundle with a verifiable checksum. Reruns have a defined result.
- [ ] AC4 (R5): Default Compose resolves to an image without build and preserves storage/mount/port contracts. Pull/up --no-build deploys it. The explicit build model builds locally and disables app updates.
- [ ] AC5 (R6): Updates select only the enabled `backup` container in this deployment's scope. The updater and unrelated containers are excluded. Poll/disable behavior works; old-image cleanup defaults off.
- [ ] AC6 (R7): Three READMEs and Docker environment examples agree on image names/tags, mount-preserving migration, access, interruption, and rollback. Updating retains persistent data.
- [ ] AC7 (R8): Verification records actual results and limits, including the existing executor concern. CI runs real archive/tools and container smoke checks. No arm64 runtime claim is made without execution evidence.
- [ ] AC8 (R9): Pi ownership/review is recorded; prior work is intact; any commit/upload/publication is tied to reviewed paths and observed evidence.

## Scope boundaries

Included: two-platform CI/release/image configuration, shared release/verification helpers where useful, image-first Compose, automatic updates, explicit local builds, installation assets, three-language operator documentation, and verification.

Excluded: automatic SSH deployment, production-server access, automatic version bumps, creating platform repositories/changing package visibility, a Docker socket in the backup application, backup draining/retry feature changes, schema migrations, unrelated new-api export defects, and unrelated task cleanup.

## Risks and deferred operational evidence

- `docker`, `gh`, and `actionlint` were absent from PATH on 2026-10-26. Prepare static checks locally; report runtime and first remote-run results as unverified until actually executed.
- Public anonymous GHCR access needs first-publication evidence. CNB repository location and enabled CI/package permissions need platform evidence; workflow configuration can derive the receiving repository path.
- The updater recreates a container; it cannot deploy Compose mount/config changes. It can interrupt backups. Image rollback retains volumes but cannot guarantee compatibility with future data migrations.
- Verify upstream updater/action versions, CNB syntax, and multi-platform facilities against primary sources during implementation. Unverified reference versions are not an acceptance shortcut.
- Real new-api PostgreSQL export/restore remains outside this delivery change; retain `research/newapi-container-backup.md` and do not imply the image pipeline fixes it.

## Planning status

The expanded request has revised PRD/design/implementation ownership/research/context artifacts. No product code has been changed for this task. Approval of the final summary is pending.
