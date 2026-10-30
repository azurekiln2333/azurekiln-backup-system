# Design: two-platform releases and image deployment

## Boundary and reference

Reuse the existing application and Dockerfile. Change delivery configuration, small shared automation helpers, packaging exclusions, and operator docs. Do not change backup execution or expose Docker to the backup container. The old task remains one delivery unit: both workflow files, install assets, Compose, and the update channel must agree before any of them can be accepted independently.

Reference: `D:/My2KProjects/cnb2api-panel` (read-only). Reuse its tag-triggered Release/image delivery, image-first deployment, build override, and scoped updater shape. Correct reference weaknesses for this target: CNB publication must not bypass verification, stable updates must not follow main, previous images should remain available, and update interruption must be explicit.

## Events and publication sequence

1. Main pushes, PRs, and supported manual verification run Node 24 installation/check/test/build/browser/layout plus image smoke validation. PRs never enter publication.
2. A strict supported SemVer `v<version>` tag must match package metadata before any write operation. Resolve image repository, full revision, version, prerelease status, and channel eligibility through a shared release helper.
3. Validate the exact tag source. CNB must keep validation and publication in one ordered pipeline, rather than copying the reference's independently publishable image pipeline.
4. Build/push `linux/amd64,linux/arm64` version and revision images. Execute an amd64 candidate with disposable state before publication; do not equate an arm64 build with an arm64 runtime test.
5. Create/update the platform Release and deployment assets using platform APIs/actions. Rerun behavior must be explicit; mismatched tag/version fails, checksum verifies the actual uploaded archive, and an existing Release is updated without creating a second one.
6. Promote `latest` only for an eligible stable version after required checks and image delivery. Prereleases/main cannot move it. Check the stable version ordering immediately before promotion and serialize stable promotion where supported; test older-release reruns. Confirm CNB concurrency facilities during implementation rather than inventing syntax.

GitHub starts with `contents: read`. Image-writing jobs gain `packages: write`; Release-writing jobs gain `contents: write`; neither is available on PR paths. Authenticate GHCR through the repository's Actions token. Use official maintained Actions at verified versions/pins.

CNB uses branch/event selectors and sequential stages for verify, image build, release assets, and stable promotion. Use platform-issued credentials for the same repository. Derive the default image path from the official receiving-repository slug variable after verifying its contract; permit explicit registry/image overrides. Do not hardcode an unconfirmed `azurekiln` namespace. Confirm Docker/Buildx/QEMU or native multi-architecture runner support against primary CNB documentation and actual CI results.

## Shared files and installation assets

Expected paths:

- `.github/workflows/build-and-release.yml`, `.cnb.yml`: platform event/auth/orchestration only.
- `scripts/prepare-release.mjs`: shared version/tag/channel metadata and deployment-asset creation; meaningful version/package/secret-exclusion tests in `tests/release.test.mjs` when needed.
- `scripts/ci-verify.sh`, `scripts/check-image.sh`: Linux verification/tool-path setup and disposable Docker HTTP/tool smoke checks. Keep browser and layout commands sequential.
- `compose.yaml`, `compose.build.yaml`, `.env.docker.example`: deployment models and documented settings.
- `.dockerignore`: ensure all local agent directories, user archives, state, credentials, and generated artifacts are excluded; do not broaden runtime image contents.
- `README.md`, `README.en.md`, `README.zh-TW.md`: consistent operator procedures.

A versioned deployment archive contains Compose and the example environment plus the relevant operator instructions and release metadata. It contains no real `.env`, persistent state, node_modules, source archives, or credentials. Include a SHA-256 sidecar. The normal server path needs Docker Compose and the deployment files, not Node/npm or a local image build. Describe local building as a source-checkout operation so an installation-only archive is not mistaken for a complete build context.

## Compose and persistence

The base model has an image reference, defaulting to the confirmed GHCR repository with `:latest`, overridable by `BACKUP_IMAGE` for CNB, a version, or a digest. It has no `build`. Preserve service `backup`, volume key `backup-data`, no new top-level project name, port `127.0.0.1:16323:16323`, root execution, environment-file/system-config mounts, source/rclone mounts, and the existing 30-second application stop grace.

The explicit `compose.build.yaml` selects a local image/build/pull policy and forces the app updater label false. Its updater service is excluded from the ordinary local-build command. Switching an existing deployment to local build also explicitly stops any already-running updater; changing profiles alone is not a stop command.

Existing operators retain their actual paths and Compose project identity. Instructions modify image/build selection and add updater configuration, rather than replace customized deployment files wholesale. Never use `down -v` or rename the persistent volume for installation migration, update, or rollback.

## Automatic updates

Follow the requested reference behavior: the base server deployment starts a pinned, verified maintained Watchtower implementation. Default polling is 600 seconds, configurable through the Docker environment example. Only the enabled backup container in this deployment is selected; the updater labels itself disabled. Derive a unique default scope from the actual Compose project identity where Compose supports it, without setting a new project name. Verify `-p`, directory names, and explicit scope overrides so multiple deployments do not update one another.

The updater alone mounts the Docker socket. `backup` does not gain it. Do not add updater access to the application API. Default old-image cleanup off to preserve local rollback images. Match the updater's stop timeout to the application's existing stop grace after verifying upstream semantics. Document disabling the app's update label, pausing/stopping the updater, monitoring only, and restarting it deliberately.

A private registry does not automatically share host Docker CLI credentials with the updater. Verify supported credential injection and document an explicit optional credential configuration without committing secrets or mounting host credentials by default. Public default pulls must be tested after first publication.

Updates recreate the current container using its configured mounts; they do not apply new Compose configuration. Current SIGTERM behavior aborts active backups and queued work may become interrupted. Do not claim draining, automatic retry, or zero downtime. Operators can pause updates around long backups or pin a tested version/digest. A future idle-aware update feature is separate scope.

## Deployment, rollback, and publication boundaries

Normal commands are `docker compose pull` followed by `docker compose up -d --no-build`. First publication/package access must be established before those commands can succeed. Both registry choices and stable/prerelease references are documented.

Rollback disables automatic updates, selects a recorded previous version/digest, and pulls/recreates with the same project and data volume. Keep the previous image available by default. Do not promise data-downgrade compatibility for future application migrations.

This task prepares reviewed changes and workflows. Actual commits/pushes follow the project's batched approval gate, including disclosure that current HEAD is ahead of GitHub main by 68 commits. Repository creation, package visibility changes, and production deployment are outside this request's implementation boundary; report owner-only actions and observed remote results accurately.

## Verification and limits

Set absolute executable paths for rclone/7-Zip, check that they exist and execute, and enable real integration tests to avoid `existsSync` skips. Require evidence that the critical archive/integration cases executed; do not reject every intentional platform-specific skip indiscriminately. Install the Chromium version corresponding to locked playwright-core and pass its executable explicitly. Check types, tests, frontend build, then browser and layout sequentially.

Validate workflow syntax/expressions and permissions, both resolved Compose models, release version/channel logic, checksums/exclusions, and image startup plus rclone/7zz/tar/sqlite3/pg_dump/mariadb-dump. Use test-only environment files and source directories, never the real `.env`. Exercise updater label/scope selection, version pinning, and storage persistence in Docker when available.

No Docker/gh/actionlint command is currently on PATH. Record static and runtime evidence separately. Preserve the prior executor full-suite failure disclosure; a targeted passing rerun does not establish a green full suite.
