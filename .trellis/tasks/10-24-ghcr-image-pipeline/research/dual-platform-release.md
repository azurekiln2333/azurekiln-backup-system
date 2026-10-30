# Expanded delivery research and Pi coordination

Inspected on 2026-10-26. This document supersedes the old GitHub-only/main-to-latest/unattended-updates-excluded policy in `ci-deployment.md`; retain that earlier file for historical repository/test-tool evidence.

## Confirmed reference and target behavior

- Reference `D:/My2KProjects/cnb2api-panel/.github/workflows/build-and-release.yml`: ordinary changes run checks; `v*` tags create a Release with archive/checksum and publish GHCR images. `needs: [test, console]` guards both publishing jobs. The stable image path is `ghcr.io/<lowercase repository>`. The reference's image job does not itself establish multi-platform or runtime-smoke coverage.
- Reference `.cnb.yml:1-49`: main push/API/PR validation and packaging. Tag selectors begin at line 51. `publish-release` validates package/tag metadata and executes validation before `git:release`/attachments. The separate `publish-image` pipeline beginning at line 108 validates the tag but does not depend on those application checks. Do not reproduce that publication bypass.
- Reference `docker-compose.yaml`: prebuilt CNB image, updater-enable/scope labels, default 600-second polling, Docker socket only in Watchtower, updater-self disabled. `docker-compose.build.yaml` selects a local image and disables application updates; the updater receives a profile.
- Target `compose.yaml:3` uses `build: .`; service `backup` and volume `backup-data` are existing identities. Preserve existing host mounts, environment/config exports, loopback port, root execution, and shutdown grace.
- Target `server/app.mjs:362,378-380` and `server/backup.mjs:845-855`: shutdown aborts running operations and marks queued runs interrupted. Container replacement is not an idle-aware update. Neither 30-second shutdown completion nor automatic retry is guaranteed by merely reading this path.
- Target `tests/newapi.test.mjs:18-20` and `tests/integration.test.mjs:18-20` inspect executable paths/flags. CI must export existing absolute rclone/7-Zip paths, check execution, enable live integration, and demonstrate that key real-tool cases actually ran. A global ban on all intentional platform skips is inappropriate.
- Target `.dockerignore` excludes many local folders but needs review for the user ZIP/newer agent folders. Excluding them from the final Docker COPY is not equivalent to excluding them from the uploaded build context. Use path-limited commits; existing dirty/untracked paths are not a failing cleanliness assertion.

## Verified updater identity

The Docker image namespace differs from the source repository owner:

- Source: `https://github.com/nicholas-fedor/watchtower`
- Release API: `https://api.github.com/repos/nicholas-fedor/watchtower/releases/latest` returned `v1.23.2`, published `2026-10-22T03:49:09Z`.
- Registry API: `https://hub.docker.com/v2/repositories/nickfedor/watchtower/tags/1.23.2` returned that tag and Linux amd64/arm64/386/arm/riscv64 manifests, last updated `2026-10-22T03:44:42.393928Z`.
- `nickfedor/watchtower` is the image name; attempting that owner/repository in GitHub returned 404. Do not infer that the maintained image is unavailable from the wrong GitHub path.

Inspect the actual upstream documentation for scope, stop timeout, and registry credential handling before implementing. Host `docker login` is not proof that the updater can access the same credential file. Default public pulls avoid an unsolicited host credential mount.

## Session and remote evidence

- The inherited Herdr environment pointed to an unrelated `w24`/`D:/obs`; do not control those panes. Matching the actual repository cwd located workspace `w1H`, with four existing right-hand panes `p8`, `p6`, `p4`, `p7`.
- Initially p4/p7 had exited with a Pi settings lock error. Starting Pi in those same available shell panes succeeded without deleting locks, changing models, killing processes, or changing topology. A subsequent Herdr reconnect changed terminal handles and the p4 session; live discovery was repeated before prompting.
- Herdr prompt acceptance alone is not completion evidence. Working activity was observed for all four roles; role responses are inspected through agent reads. If an idle agent's old alternate-screen response is unavailable even after a larger read, request only a temporary report file as the documented fallback.
- `git ls-remote --symref github HEAD refs/heads/main` returned `c30845e4b94f5b1484a04a85fa18387a53007667`. `git rev-list --left-right --count <remote>...HEAD` returned `0 68` for HEAD `95a5566`.
- No target CNB remote was configured. Do not hardcode the reference project's namespace as the target repository's location.
- No `docker`, `gh`, or `actionlint` command was found on PATH. No Docker test or platform publication has occurred during this planning turn.

## Four-Pi research and follow-up ownership

| Pane | Research | Proposed implementation ownership |
| --- | --- | --- |
| w1H:p8 | GitHub events, GHCR, Releases/assets, shared release metadata | GitHub workflow, release helper and its meaningful tests |
| w1H:p6 | CNB events, credentials, Release/image facilities, build platforms | CNB workflow using the agreed shared helpers |
| w1H:p4 | Compose, updater scope, local-build isolation, interruption/rollback | Compose models, Docker example/ignore, three README variants |
| w1H:p7 | Independent delivery/test/packaging/security integration review | CI/image validation helpers, then review the other lanes |

All research prompts prohibited product edits, commits, pushes, publication, deployment, full-suite tests, and child-agent creation. Workers were told they share the worktree and must preserve others' changes. The current repository-host fallback task remains pending its separate commit review.

## Planning decisions proposed for final approval

- Receive the same source on both platforms; ordinary changes verify, matching version tags produce Releases/images. Do not automatically bump versions.
- Stable tag releases advance `latest`; prereleases/main do not. Check stable version ordering and available serialization to prevent an old rerun from downgrading the update channel.
- Default image comes from the confirmed GHCR target. `BACKUP_IMAGE` also selects a CNB image, pinned version, or digest; derive the publishing CNB path from verified platform metadata rather than inventing a remote.
- Default automatic updates follow stable images every 600 seconds, with a deployment-specific scope and enabled-container label. Keep previous images by default; local builds force updates off.
- Package deployment files/example configuration/checksum, without bundling private application state or requiring server builds.
- Retain existing storage/mount identity. Document interruption, pause/pin/rollback, and explicit optional private-updater authentication. Do not add application draining, retry, Docker control, or production-server deployment.

## Independent-review reconciliation

The first integration response reviewed the old artifacts and correctly flagged missing CNB/Release/update scope, missing version/tag checks, insufficient live-tool proof, and old-main reruns advancing latest. The revised PRD/design/implementation plan address those gaps.

Do not adopt unsupported claims from that review: the reference does have GitHub Actions; blanket skipped-test rejection is too broad; source inspection does not prove every shutdown is safe or finishes in 30 seconds; and preexisting dirty/untracked files must remain, rather than requiring global git status cleanliness.

Detailed CNB/updater capability results and remaining implementation-time checks are appended after worker responses are recovered. Technical constraints must be verified rather than hidden behind a successful YAML parse.
