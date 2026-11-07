# CI failure investigation: unsupported distribution rclone

## Scope and result

Read-only investigation of committed tree `fa233a7d509845daa5c76bdaf8b082d3c3176850` and GitHub Actions run `42314406587`, attempt 1, Verify job `128223402373`. Investigation completed on November 7, 2026 (Asia/Shanghai). No product, workflow, Dockerfile or Git changes were made; this report is the only investigation artifact written. No test suite was run during this investigation.

**Confirmed cause:** Ubuntu's installed `rclone v1.60.1-DEV` does not implement the `config encryption set` command required by `server/rclone.mjs:81`. All 27 failed tests report that same unsupported command during fixture configuration import. The previously observed failed-staging cleanup race is not the cause of this run.

## Remote evidence

- Run metadata confirms the exact SHA above, a failed conclusion and attempt 1.
- Type check, frontend build and backup-tool installation all passed. Step 8, `Run tests`, failed between `2026-11-06T23:50:10Z` and `23:50:24Z` (November 7, 07:50:10-07:50:24 in Asia/Shanghai). Browser/layout steps were skipped afterward.
- `Verify/7_Install backup tools.txt` records `rclone v1.60.1-DEV`; the test-step environment records `SEVEN_ZIP_BINARY=/usr/bin/7z`.
- `Verify/8_Run tests.txt` reports **144 tests: 113 passed, 27 failed, 4 skipped**. There are 26 executor failures and one real site-system-backup failure. Every failure includes:

  ```text
  Command config needs 0 arguments maximum: you provided 2 non flag arguments: ["encryption" "set"]
  ```

- The first failure is `tests/executor.test.mjs:78`, before that test can exercise its assertions. The real site-system-backup test at `tests/sites.test.mjs:753` fails for the same reason. Their fixtures call `rclone.importConfig()` on a plaintext alias config.
- `server/rclone.mjs:81` intentionally encrypts such configurations using `['config', 'encryption', 'set', '--password-command', command]`. The upstream changelog first lists the `config encryption` command group under **v1.68.0, September 8, 2024**. This explains why the distribution's 1.60.1 executable is incompatible.

The existing local full-suite result is useful evidence for the exported Windows tree, but cannot establish compatibility with the older executable installed by Linux CI.

## Authenticated log access

The job-level log endpoint had returned 403 to the main session. The run-attempt endpoint succeeds with the existing Git credential:

```text
GET /repos/azurekiln2333/azurekiln-backup-system/actions/runs/42314406587/attempts/1/logs
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

It returned 302; following its download location without forwarding the API Authorization header yielded a 51,734-byte ZIP with 13 log members. The credential and temporary signed download URL were held only in process memory and were never printed or written. The step-log endpoint `/actions/jobs/128223402373/steps/8/logs` returned 404, so it was not needed. The run has no uploaded artifacts.

For another investigation, use the run's actual `run_attempt`, consume the redirect promptly, and keep both credentials and signed locations out of command output, reports and persisted files. No broader account permission was required for the successful attempt-log route in this session.

## Existing provisioning and version baseline

There is no committed, checksum-verified rclone installer in this tree. The relevant owners are:

| Owner | Current behavior | Required correction |
| --- | --- | --- |
| `.github/workflows/build-and-release.yml:68` | Installs unpinned apt `rclone`; probes only its version | Use the shared pinned installer, assert encryption-command capability and pass its absolute path to tests |
| `scripts/ci-verify.sh:126` | Disposable-CI fallback installs apt `rclone`; an existing executable is accepted without checking this capability | Provision/validate the pinned compatible executable even when an old executable already exists; do not leave installation only on the missing-tool branch |
| `.cnb.yml:110` and `:172` | Both verification and tag packaging use `ci-verify.sh` | They inherit a shared-script fix; no duplicate inline download/checksum implementation is needed in the YAML |
| `Dockerfile:9` | Runtime `node:24-bookworm-slim` stage installs apt `rclone` | Use the same pinned installer in the final image; a CI-only fix would leave runtime provisioning inconsistent |

`tests/executor.test.mjs:18`, `tests/file-clone.test.mjs:21` and `tests/sites.test.mjs:27` already name **v1.75.1** as the Windows tool baseline. Reusing that version is a bounded compatibility fix; there is no need to track a moving latest release. The existing Docker/CNB remote runs were not reproduced here; their unpinned apt provisioning is a confirmed source pattern, not evidence that those separate remote jobs have already failed.

## Recommended shared fix and checksum contract

The main session selected a single `scripts/install-rclone.sh` for GitHub verification, `ci-verify.sh`/CNB and the Docker runtime stage. Keep the application's existing encryption/import behavior unchanged.

- Fix the version at **1.75.1**. Map Linux `x86_64` to `amd64` and `aarch64`/`arm64` to `arm64`; reject unsupported architectures explicitly.
- Download the matching versioned official ZIP into a fresh temporary directory. Do not use `curl | bash`, an unversioned latest URL, or a fallback to unverified distribution bytes.
- Pin the expected SHA-256 in the reviewed installer and verify the downloaded archive **before extracting or installing**. HTTPS retrieval of an upstream checksum file alone is weaker than the reviewed digest pin.
- The official versioned `SHA256SUMS` retrieved during this investigation contains:

  | Archive | SHA-256 |
  | --- | --- |
  | `rclone-v1.75.1-linux-amd64.zip` | `982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab` |
  | `rclone-v1.75.1-linux-arm64.zip` | `03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9` |

- Install the verified executable at `/usr/local/bin/rclone` with executable permissions and clean temporary files on success and failure. GitHub's host runner needs the privileged install invoked through its existing sudo facility; disposable CNB containers and the Docker build run as root.
- Pass/export that absolute path as `RCLONE_BINARY`. Do not allow `/usr/bin/rclone` or an old preinstalled executable to win discovery afterward.
- Probe both the fixed version and `rclone config encryption set --help`. The existing `rclone version` probe succeeds for the incompatible executable, so it cannot be the only acceptance check.
- Ensure Linux installation prerequisites are present **before** running the helper: trusted CA certificates, a downloader such as curl, ZIP extraction such as unzip, and `sha256sum`/`install` (coreutils). Bookworm slim should declare needed downloader/extractor packages explicitly rather than assume they exist. Copy the helper into the Docker runtime build stage before calling it; continue installing the other required backup tools there. Multiarchitecture builds must select their own target architecture's ZIP and digest.

Updating `ci-verify.sh` centrally is sufficient for both existing CNB call sites. A `.cnb.yml` edit is only needed if the implementation chooses to expose a new explicit shared-installer invocation or environment setting; do not add a second independent version/checksum list there.

## Four skipped real-tool cases and required environment

The actual cloud log skipped these tests despite installing executables:

1. `real encrypted file backup extracts only the selected basename, preserves exact bytes and supports empty files`
2. `real AES-256 directory upload, checksum, SMTP, extraction and immediate cleanup`
3. `real live WAL Vaultwarden snapshot, ZIP AES, optional artifacts and separate destination`
4. `SMTP rejection preserves backup success and still removes successful staging`

`tests/file-clone.test.mjs:20` requires `RUN_BACKUP_INTEGRATION=1`. `tests/integration.test.mjs:20` otherwise checks `existsSync(rcloneBinary)`; its Linux fallback is the bare string `rclone`, not a PATH lookup, so the condition stays false even if `/usr/bin/rclone` exists. The GitHub test step currently exports only `SEVEN_ZIP_BINARY`.

Set `RUN_BACKUP_INTEGRATION=1`, `RCLONE_BINARY=/usr/local/bin/rclone`, and `SEVEN_ZIP_BINARY` to the resolved absolute 7-Zip executable. `ci-verify.sh:196-205` already exports these forms for its own callers; preserve its zero-skip budget and required-case checks. Propagate the rclone path to later browser/layout steps too, so they exercise the same executable as unit/integration tests.

## Validation to perform after implementation

This investigation did not edit the installer/workflows or run tests. The main session owns the implementation and subsequent gates.

- Syntax-check the installer and affected shell entrypoints. Exercise success, unsupported architecture, download failure and checksum mismatch without allowing an invalid executable to be installed.
- In disposable Linux state with the pinned binary, run affected real rclone import/encryption and backup tests. Then run the complete authorized test/check/build gates sequentially, with the integration environment above and no silent tool skips.
- Inspect the subsequent GitHub attempt's real logs: correct fixed rclone version, capability probe success, all intended real-tool cases executed, and any remaining independent failure reported separately.
- Verify the built runtime image contains the same version and supports `config encryption set`; preserve existing image smoke checks and prove a throwaway plaintext alias configuration can be imported/encrypted without production mounts. Test both published architecture targets where execution is available, and report any architecture that was only build-checked.
- Continue treating the failed-staging timing race as an independent known issue. Do not claim the dependency fix resolves a race that this failed run never reached.

## Primary references

- GitHub run: `https://github.com/azurekiln2333/azurekiln-backup-system/actions/runs/42314406587`
- GitHub REST run-attempt logs: `https://docs.github.com/en/rest/actions/workflow-runs#download-workflow-run-attempt-logs`
- Upstream command: `https://rclone.org/commands/rclone_config_encryption_set/`
- Upstream changelog source: `https://raw.githubusercontent.com/rclone/rclone/master/docs/content/changelog.md` (v1.68.0 section)
- Versioned checksum manifest: `https://downloads.rclone.org/v1.75.1/SHA256SUMS`
