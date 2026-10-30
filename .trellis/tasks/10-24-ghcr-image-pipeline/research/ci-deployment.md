# CI and image-delivery research

Inspected on 2026-10-24. This is a read-only repository/official-documentation summary for implementation and review.

## Repository evidence

- No `.github/` directory or alternative image-publishing workflow was found with hidden-file searches.
- `git remote -v`: remote `github` points to `https://github.com/azurekiln2333/azurekiln-backup-system.git`.
- `git ls-remote --symref github HEAD`: remote default is main, observed HEAD `c30845e4b94f5b1484a04a85fa18387a53007667`. Local planning baseline HEAD is `afe7eb0`.
- The remote object exists locally. `git rev-list --left-right --count c30845e4b94f5b1484a04a85fa18387a53007667...HEAD` returned `0 62`; `git merge-base --is-ancestor` succeeded. Existing local changes span 83 files (+7925/-302), including prior watching/incremental/batch/newapi/layout work. A push is not limited to the forthcoming workflow commit; disclose this at final review and re-check before pushing.
- `Dockerfile:1-7`: Node 24 build stage installs locked dependencies and builds the frontend.
- `Dockerfile:9-23`: Node 24 runtime installs rclone, 7zip, tar, sqlite3, PostgreSQL/MariaDB clients; copies production dependencies, shared/server code, and frontend output; exposes 16323.
- `compose.yaml:3`: implicit local build. `compose.yaml:6-25`: environment, data, source/config mounts and loopback port. Preserve these contracts when selecting a registry image.
- `README.md:43`, `README.en.md:45`, `README.zh-TW.md:45`: current instructions build on the deployment host.
- `package.json:7-19`: Node >=24; existing check/test/build/browser/layout scripts.
- No `docker`, `gh`, or `actionlint` executable was found on PATH during planning. Git remote read access is working; this is not evidence of write permission.

## CI prerequisites from code inspection

- `tests/executor.test.mjs:18-20` treats Linux as a real-tools environment. Install rclone, full 7-Zip, and tar before `npm test`.
- `tests/integration.test.mjs:18-20` uses a real executable-path check and the `RUN_BACKUP_INTEGRATION=1` opt-in. Supply actual absolute tool paths.
- `tests/newapi.test.mjs:17-19` checks the 7-Zip path with `existsSync`; a bare command name can silently skip the real encrypted archive round trip. Set `SEVEN_ZIP_BINARY` to an existing absolute path, resolving `7zz` or `7z` after installation.
- The existing tests use Node's built-in SQLite and injected database-dump runners; they do not require running external PostgreSQL/MySQL servers for the current suite.
- `scripts/check-browser.mjs:14-18` and `scripts/check-layout.mjs:20-22` select `BROWSER_EXECUTABLE`, a Windows Chrome path, or `/usr/bin/chromium`. GitHub-hosted Chrome on another path will not be discovered automatically.
- After `npm ci`, `npx playwright-core install --with-deps chromium` can install the browser matching the locked package. Resolve `chromium.executablePath()` and pass it through `BROWSER_EXECUTABLE`.
- Browser and layout checks require built `web/dist`; run browser suites sequentially to avoid contention over backup tools and services.

## Official documentation inspected

The following primary pages were fetched successfully during planning (web search returned no usable rendered result, so the pages were read directly over HTTPS):

- GitHub, Publishing Docker images: `https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-docker-images`
  - GHCR authentication supports `registry: ghcr.io`, `github.actor`, and the automatically supplied `GITHUB_TOKEN`.
  - Publishing requires the job's package-write permission alongside checkout/read permissions. Additional attestation permissions are needed only if that optional feature is included.
- GitHub, Working with the Container registry: `https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry`
  - Public container images support anonymous pulls. Package visibility/access must be checked; an image's existence does not prove anonymous pull access.
  - `GITHUB_TOKEN` can publish packages associated with the workflow repository. Private server pulls require a suitable package-read credential.
- Docker, Multi-platform image with GitHub Actions: `https://docs.docker.com/build/ci/github-actions/multi-platform/`
  - Official examples use Buildx, optionally QEMU, with `linux/amd64,linux/arm64`.
  - A multi-platform registry build and a locally loaded smoke-test image have different image-store requirements. Build/load a single-platform candidate for local execution, then publish a multi-platform build.
- Docker, Compose up CLI: `https://docs.docker.com/reference/cli/docker/compose/up/`
  - `--no-build` disables building; `--pull` controls image-pull policy. A separate explicit pull followed by recreate is suitable for an operator-controlled deployment.

Select and verify official Action releases/pins at implementation time. Current documentation examples must not be treated as remembered permanent version numbers.

## Practical delivery boundary

Use GitHub Actions for automated verification/build and GHCR image delivery. Let the operator choose the server update time through Compose. Automatic SSH deployment and registry visibility changes require separate authorization and are outside the prepared scope.
