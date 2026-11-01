# Independent integration review

Reviewer: lane 4 (verification scripts + independent integration review).
Scope reviewed: `.github/workflows/build-and-release.yml` (lane 1), `.cnb.yml` (lane 2),
`compose.yaml` / `compose.build.yaml` / `.env.docker.example` / the three READMEs (lane 3),
`scripts/prepare-release.mjs` (lane 1), and lane 4's own `scripts/ci-verify.sh`,
`scripts/check-image.sh`, `tests/ci-scripts.test.mjs`.

Nothing was committed, pushed, published or deployed during this review. No child agents
were created. Other lanes' files were read only.

## Evidence discipline

Every finding below is labelled with the evidence actually obtained:

- **static** — read from the file.
- **executed** — a command was run in this session; the command is quoted.
- **owner-verified** — the owning lane asserts it; **no evidence available here**.
- **unverified** — could not be established without Docker / a CNB account / a remote run.

Host facts that bound the evidence: `docker`, `gh`, `actionlint` are absent from PATH;
there is no CNB remote and no CNB account; the only remote is `github`
(`azurekiln2333/azurekiln-backup-system`); WSL is installed but its distro cannot start
(`Wsl/Service/CreateInstance/MountDisk/HCR/ERROR_FILE_NOT_FOUND`), so no Linux execution
of `scripts/ci-verify.sh` was possible. Git Bash could only perform syntax and control-flow
checks.

---

## Summary verdict

The three lanes converge on a coherent design, and the safety-critical separation
(verify → publish) is structurally correct in both pipelines. Six findings need action
before publication; two of them can corrupt the stable channel.

| # | Severity | Area | Finding |
| --- | --- | --- | --- |
| 1 | High | `latest` channel | An unreadable or label-less `latest` manifest is read as "channel empty", which permits a downgrade |
| 2 | High | CNB verification | The CNB release pipeline's verification and image steps have no documented Docker daemon, so verification may be weaker than claimed |
| 3 | Medium | Updater | `WATCHTOWER_CLEANUP=true` contradicts the stated "retain previous images by default" acceptance criterion |
| 4 | Medium | CNB portability | `.cnb.yml` relies on YAML merge keys (`<<: *anchor`), which the published CNB schema rejects when not resolved |
| 5 | Medium | Docs | The CNB registry path is promised but appears in no operator-facing file |
| 6 | Low | Docs / evidence | "Verified" language exceeds the evidence in three places |
| 7 | Low | Verification | `scripts/ci-verify.sh` is not covered by a schema/lint check and has never executed on Linux |
| 8 | Info | Hygiene | Duplicate/ambiguous inputs in `package_release` hardening; CNB `concurrency` never used |

---

## 1. High — an unreadable `latest` is treated as an empty channel (downgrade risk)

Both lanes recover the current stable version by regex-matching `\d+\.\d+\.\d+` over the raw
`latest` manifest JSON:

- `.github/workflows/build-and-release.yml` — "Resolve current channel and queue state"
- `.cnb.yml` — `publish-image`

**Executed** (`node .artifacts/cnblint/latest-parse2.mjs`) against the workflow's own logic:

```
label present:                             matched=["0.2.0"] current='0.2.0'
label present, older annotation first:     matched=["3.11.0","0.2.0"] current='3.11.0'
label absent:                              matched=[]        current=''
```

The first match in document order wins, so unrelated semver-looking values in the manifest
(base-image versions, dependency versions inside labels) can be mistaken for the channel
version. Worse, when nothing matches, `current` becomes `''`, and **executed**
(`node --input-type=module -e "…resolveChannel({release, currentLatest: null})"`):

```
latest unreadable-empty -> {"latest":true,"reason":"stable channel is empty"}
latest = 0.9.0         -> {"latest":false,"reason":"0.1.0 is older than stable 0.9.0"}
```

So an unparseable `latest` is indistinguishable from first publication and **promotes**.
The GitHub lane guards this for a *readable but version-less* response
(`[ -s /tmp/latest.json ] && [ -z "$current" ]`), and `resolveChannel` supports an explicit
`'unknown'` sentinel that fails closed — but neither lane ever passes `'unknown'`.
The CNB lane has no equivalent guard at all: `imagetools inspect --raw` failing (network,
auth, registry hiccup) sets `latest_raw=""`, which reads as "first publication".

Additional CNB-only gap: `resolveChannel` accepts `concurrency`, and the GitHub lane passes
it. **Executed**: `grep concurrency .cnb.yml` → no match. The CNB lane relies on the pipeline
`lock` only, so a rerun of an older tag that starts *after* a newer tag finished will compare
against the registry (correct) — but two tags racing across the lock boundary are not
protected by the channel logic the shared helper was written to provide.

Recommended: read the version from the OCI annotation
`org.opencontainers.image.version` (both lanes already set it) instead of a free regex;
treat "tag exists but version not identifiable" as `'unknown'` in **both** lanes; and pass
`concurrency` where the platform exposes queue state.

Verification status: **unverified remotely**. No image exists yet, so the real manifest
shape could not be observed. The parsing defect is proven against synthetic manifests built
from the workflow's own logic, not against a live GHCR/CNB manifest.

## 2. High — the CNB verification path may not be equivalent to the GitHub one

`.cnb.yml` states the shared `scripts/ci-verify.sh` and `scripts/check-image.sh` are reused so
the lanes "cannot drift". The schema shows what the release pipeline actually requests.

**Executed** (schema-derived):

```
services enum/item names: ["vscode","docker"]
job can declare services?  ["name","timeout","ifModify",…,"exports","allowFailure","lock"]   # no services
```

CNB exposes a `docker` service, and `pipeline.services` is where a daemon is declared. The
`v*` release pipeline declares **no** `services`. Its stages run:

- `verify` → `node:24-bookworm` (no `services`, no `docker`),
- `publish` → `docker.cnb.cool/azurekiln/azurekiln-backup-system` (the app image),
  which also has no daemon.

Consequences, all **owner-verified only** (the file's own "NOT VERIFIED" block acknowledges
the Docker point, but the file's top-level policy text still asserts reuse):

1. `scripts/ci-verify.sh` on `node:24-bookworm` must install `rclone`, `7zip`, `tar`,
   `sqlite3`, `postgresql-client`, `mariadb-client` **and** Chromium with its apt
   dependencies, as root, inside `CI_VERIFY_ALLOW_DEV=1`. If any of that is unavailable the
   script now fails loudly (by design), so the failure is visible rather than silent — good —
   but the CNB pipeline would then never reach publication. That is the correct direction to
   fail, and it must be observed once before the lane is called done.
2. `scripts/check-image.sh --build` requires a reachable Docker daemon
   (`docker info`, `docker build`, `docker run`). Without a `services: [docker]` entry this
   step cannot pass. The same applies to `docker buildx build --push` and
   `docker buildx imagetools`.
3. `.cnb.yml`'s header says the image smoke check runs "BEFORE the published 2-arch image is
   built". That ordering claim depends on a daemon that the pipeline never declares.

Recommended: add an explicit `services: [docker]` (and confirm `buildx` availability) to the
`v*` pipeline, or move the smoke check to a job that declares it. Until a real run exists,
the CNB lane should be described as *unverified*, not as "reuses the same entrypoint".

Verification status: **unverified**. This reviewer has no CNB account or remote run. The
schema evidence above shows the declaration is absent; whether CNB injects a daemon anyway is
not established by any evidence available here.

## 3. Medium — `WATCHTOWER_CLEANUP=true` contradicts AC5

`prd.md` R6 and AC5 require: *"Retain previous images for rollback by default"* and
*"old-image cleanup defaults off"*. `compose.yaml` sets `WATCHTOWER_CLEANUP: "true"` with the
comment "Old images are removed after a successful update".

**Executed** (`node .artifacts/cnblint/compose-filters.cjs`):

```
service watchtower:
  WATCHTOWER_CLEANUP  = "true"
  CLEANUP env (any)   = ["WATCHTOWER_CLEANUP"]
```

`task.json` also records `"updater_cleanup": "true"`, so this was a deliberate decision, not a
slip. The documentation is internally consistent with the implementation
(**executed**, `readme-claims.cjs`: all three READMEs say old images are *removed*, and none
claims they are retained; they correctly tell operators to re-pull a previous tag or digest to
roll back).

So this is not a documentation bug — it is an unresolved conflict between the accepted
requirement (cleanup defaults **off**) and the shipped default (**on**). Either the PRD
acceptance criterion or the default must change, and `prd.md`/`design.md` should say which.
Note the rollback path still works (tags and digests remain pullable), but a rollback now
requires a network pull and cannot use a locally cached previous image.

Verification status: **static + executed** on the Compose file; no updater container was run.

## 4. Medium — `.cnb.yml` depends on YAML merge-key resolution

The three verification pipelines are defined once and shared through an anchor:

```yaml
main:
  push:
    - <<: *verify-pipeline
```

**Executed** (`node .artifacts/cnblint/validate.mjs` against
`https://docs.cnb.cool/conf-schema-zh.json` as the document root; the schema's root is a map
of branch globs to `event` objects):

```
SCHEMA: INVALID
- /main/push/0 must have required property 'stages' (missing stages)
- /main/push/0 must NOT have additional properties (+<<)
- /main/pull_request/0 must have required property 'stages' (missing stages)
- /main/api_trigger/0 must have required property 'stages' (missing stages)
(15 raw errors, 15 distinct)
```

**Executed** (`diagnose.mjs`), the same document with merge keys resolved:

```
merge=false: main.push[0] keys = ["<<"]
merge=true:  main.push[0] keys = ["name","docker","stages"]
OK   main / push[0]
OK   main / api_trigger[0]
OK   main / pull_request[0]
OK   v* / tag_push[0]
OK   $ / tag_push[0]
```

**Executed** (`real-stages.cjs`): every individual stage of every pipeline is schema-valid,
including `validate-release-tag` (a bare `{name, script}` stage) and the `publish` stage.

Interpretation, stated carefully:

- Every pipeline becomes schema-valid **iff** the platform resolves YAML merge keys.
- `.cnb.yml`'s header claim of "File validated (0 errors) … reported 0 errors" is therefore
  true only under a merge-aware parser. The claim is not reproducible with a stock
  `yaml`/JSON-Schema toolchain, and this reviewer could not reproduce it with
  `yaml@2.9.1 + ajv@8.20.0` unless merge keys were explicitly enabled.
- Merge keys are a YAML 1.1 convenience; not every parser honours them. If CNB's parser does
  not, `main`/PR verification does not parse at all — the *safe* failure mode (nothing
  publishes), but the pipeline would appear broken on every non-tag event.

Recommended: either expand the anchor into three literal pipeline blocks (removing all doubt,
at the cost of duplication), or record the primary-document citation that CNB resolves `<<`.
This is a one-line risk for lane 2 to close; it should not be closed by assertion alone.

## 5. Medium — the CNB image path is promised but never documented

`README.md:41`, `README.en.md:43`, `README.zh-TW.md:43` all tell operators they may point
`BACKUP_IMAGE` at "a CNB image". **Executed**
(`grep -n 'docker\.cnb\.cool' README.md README.en.md README.zh-TW.md .env.docker.example`) →
no match in any file.

The concrete path (`docker.cnb.cool/azurekiln/azurekiln-backup-system`) exists only inside
`.cnb.yml` comments, which operators never see. An operator told "use a CNB image" cannot
discover the string. `README.md:41`'s Chinese sentence is additionally truncated relative to
its English/Taiwanese siblings (it omits the `/sources` note that the other two carry at the
corresponding place — see finding 6).

Recommended (lane 3): add the literal path to at least the `BACKUP_IMAGE` comment in
`.env.docker.example` and to the deployment section of all three READMEs, subject to finding
2 being resolved so the image actually exists and is pullable.

## 6. Low — "verified" language exceeds the evidence in three places

These are claims a reader will treat as established facts:

1. `.cnb.yml` header: `# VERIFIED against primary CNB docs … File validated (0 errors)`.
   Finding 4 shows the validation result depends on merge-key support that the cited schema
   does not itself guarantee. Also, `docker.image: docker.cnb.cool/azurekiln/azurekiln-backup-system`
   is used as the *build environment for the publish stage* while the comment explains it as
   the *receiving image path*. Those are different concepts; the comment's reasoning
   ("`docker.image` must be a non-empty literal", "an absolute registry path makes CNB
   authenticate with the platform token") is not established by the schema, which only
   requires a non-empty string or `{name, dockerUser, dockerPassword}`.
2. `.cnb.yml` `ci-verify` comment: "Reused so the CNB and GitHub lanes cannot drift". The
   *script* is shared; the surrounding environment is not (finding 2).
3. `.cnb.yml` `upload-release-assets`: the file itself states the
   `cnbcool/attachments`/`settings.attachments` contract is "taken from the reference
   repository, not from CNB docs". That is honest, but it means Release assets — the only way
   an operator gets the deployment bundle on CNB — rest on an unverified contract. If it is
   wrong, the Release record exists without its bundle.
4. `.cnb.yml` `prepare-release-options` says it "exits 3" / `prepare-release.mjs` output is
   grepped by `ci-verify`. That was true of an earlier revision of lane 4's script; lane 4 now
   consumes the documented JSON contract instead (see finding 8). The comment should be
   updated to match.

Lane 4 self-disclosure: my own `scripts/ci-verify.sh` also states facts it could not observe
on this host. Its Linux execution is **unverified** (finding 7).

## 7. Low — the verification entrypoint itself is unverified

`scripts/ci-verify.sh` never ran on Linux in this session. Evidence actually obtained:

- **executed**: `bash -n scripts/ci-verify.sh` → exit 0; `bash -n scripts/check-image.sh` →
  exit 0.
- **executed**: the platform guard refuses to run on `MINGW64_NT-10.0-19045` and on Darwin,
  with an explicit message. Intentional: the npm scripts are the documented local path.
- **executed**: an in-process harness (sourcing an edited copy with `main` removed and
  `resolve_tools`/`assert_all_tools` stubbed) exercised the two gates against synthetic TAP
  logs:
  - skip budget `0` with 1 skip → fails; with budget `5` → passes;
  - a required case reported `not ok` → fails;
  - a required case reported `# SKIP` → fails;
  - a required case passing → passes;
  - a missing `scripts/prepare-release.mjs` → fails with an explicit message.
- **executed**: `package_release` end-to-end against the real `scripts/prepare-release.mjs`
  (Windows), producing `azurekiln-backup-system-0.1.0-deploy.tar.gz` (4711 bytes), verifying
  the digest against the bytes, verifying the sidecar, listing the archive, rejecting
  `.env`-shaped members, and requiring `compose.yaml` + `.env.docker.example`.

Bugs this harness found and fixed in my own script (worth recording so the same classes are
looked for in the lanes' scripts):

- `^# skip` matched the aggregate `# skipped 0` summary line, so every required case looked
  skipped. Now matches `# SKIP` / `# not ok` only.
- `npm test`'s default reporter is the human format on Node 24; the TAP parser needs
  `--test-reporter=tap`. Now explicit.
- `sha256sum` / `tar` mis-handle Windows-style absolute paths (`\` escaping, `D:` read as a
  remote host). Both now run from the file's own directory.
- A `(^|/)\.env\.` forbidden-member pattern rejected the required
  `.env.docker.example` member. Now exact-match `.env`.
- `export TAR_BINARY` silently did nothing, because `loadConfig` has no `tarBinary` key and
  `backup.mjs` resolves `tar` through PATH. Removed; `tar` is now resolved through PATH and
  recorded for evidence only, so the suite cannot be configured to use a different `tar` than
  the one asserted.
- `${7ZZ_BINARY:-…}` cannot be used in a `${NAME-default}` form (a variable name may not
  start with a digit). Guarded by `tests/ci-scripts.test.mjs`.

Still unverified in `scripts/ci-verify.sh` and `scripts/check-image.sh`: actual Linux tool
discovery, Chromium installation under `npx playwright-core`, `--with-deps` as root, and any
Docker execution. `scripts/check-image.sh` was exercised only for its argument contract
(`--help`, missing-argument failure, `--build`/`--image` mutual exclusion, and the
"docker not on PATH" failure). Its container lifecycle is **untested**.

## 8. Info — smaller observations

- **Verification coverage bypass, GitHub `verify` job.** The workflow's `verify` job installs
  `rclone 7zip tar sqlite3` and exports only `SEVEN_ZIP_BINARY`, then runs `npm test` directly
  rather than `scripts/ci-verify.sh`. That works, but the two lanes now differ in what they
  assert: GitHub does not export `RCLONE_BINARY`/`PG_DUMP_BINARY` explicitly, does not set
  `RUN_BACKUP_INTEGRATION=1`, and has no skip budget. `tests/integration.test.mjs` and
  `tests/file-clone.test.mjs` gate their real cases on `RUN_BACKUP_INTEGRATION === '1'`
  (**executed**: `grep -n RUN_BACKUP_INTEGRATION tests/*.test.mjs`), so on GitHub those cases
  are skipped while the job is green. The PRD wants real-tool coverage; the cheapest fix for
  lane 1 is to call `bash scripts/ci-verify.sh verify` exactly as CNB does.
- **`latest` promotion is not atomic across two tags (GitHub).** `concurrency.group` is
  `release-${{ github.ref }}`, which serializes reruns of *the same* tag but not two different
  tags. The `actions/runs` check reduces the window but cannot close it. Documented as a
  known limitation rather than a defect if accepted.
- **`SOURCE_DATE_EPOCH` is sourced from `github.event.repository.pushed_at`**, which changes on
  every push. The comment says this "keeps the archive reproducible for an unchanged tag", but
  two runs of the same tag at different `pushed_at` values produce different bundle digests.
  Reproducibility for an unchanged tag would need `github.event.created_at`-like input or the
  commit's date.
- **`package_release` hardening.** My script re-checks the bundle contract that
  `scripts/prepare-release.mjs` already enforces. It is deliberately redundant (a second pair
  of eyes on a published artifact) but duplicates the forbidden-segment list; if lane 1
  changes `FORBIDDEN_SEGMENTS`, my list silently drifts. A future cleanup could import the
  helper's exported list instead.
- **Compose identity preserved.** **Executed** (`compose-filters.cjs`): base model has no
  `build`, keeps service `backup`, volume key `backup-data`, `127.0.0.1:16323:16323`, root
  user, the 30 s stop grace, and the updater alone mounts `/var/run/docker.sock`. The
  `compose.build.yaml` override sets `build`, `pull_policy: build`, forces the app update label
  to `"false"` and puts the updater behind `profiles: [auto-update]`. No finding here; AC4/AC5
  structure is as designed apart from finding 3's default.
- **Docker-socket exposure is correctly scoped** to the updater in both models; the app
  container never receives it, and `scripts/check-image.sh` asserts that at run time.
- **README language consistency.** All three READMEs agree on image default, updater image tag
  (`1.23.2` in all four places, matching `compose.yaml`), 600 s polling, the
  `down -v` prohibition, and the cleanup/rollback wording (**executed**,
  `readme-claims.cjs`). The only cross-language asymmetry is `README.md:41`'s truncated
  sentence noted in finding 5.

---

## Claims in this review that remain unverified

- That GHCR/CNB `latest` manifests look as modelled in finding 1 (no image has been published).
- That CNB does or does not inject a Docker daemon (finding 2). The declaration is absent; the
  platform behaviour is unknown.
- That CNB parses YAML merge keys (finding 4). The schema verdict is fully reproducible; the
  platform's parser is not.
- That `cnbcool/attachments` accepts `settings.attachments` (finding 6.3). Owner-lane
  uncertainty, restated here so it is not lost.
- That the `nickfedor/watchtower:1.23.2` image honours `WATCHTOWER_SCOPE` +
  `label-enable` + `timeout` exactly as assumed. The research file cites upstream docs and
  registry APIs; no updater container was run (**AC5 runtime behaviour is unverified**).
- Any arm64 runtime behaviour. `linux/amd64,linux/arm64` is built by both lanes, and
  `check-image.sh` runs the *daemon's* architecture only. No arm64 execution evidence exists;
  no arm64 claim should be made.
- Whether `scripts/ci-verify.sh` passes on `ubuntu-24.04` or `node:24-bookworm`. This is the
  single most important remaining evidence gap, and it is cheap to close with one real run.

## Suggested order of action

1. Findings 1 and 2 (publication correctness and CNB verification strength) — lane 1 / lane 2.
2. Finding 3 — decide the cleanup default at PRD level, then align `compose.yaml` or the AC.
3. Finding 4 — lane 2, plus a recorded primary source for merge-key support.
4. Finding 5 and 6 — lane 3 and lanes 1/2, documentation and claim-tightening only.
5. Finding 7 and the GitHub `verify` job gap — lane 4 and lane 1, then one real Linux run.
