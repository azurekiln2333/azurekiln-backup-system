# Backup Tool Provisioning

## 1. Scope / Trigger

Apply when changing Linux backup-tool installation, CI verification or the runtime Docker image. The application encrypts imported plaintext rclone configurations; a binary that merely answers `version` is insufficient.

## 2. Signatures

- `bash scripts/install-rclone.sh [destination-directory]` installs the pinned Linux executable, default `/usr/local/bin/rclone`.
- GitHub's `Install backup tools`, CNB's `scripts/ci-verify.sh` disposable-host path and `Dockerfile` share this installer.
- Verification: `rclone config encryption set --help` must contain `rclone config encryption set [flags]`.
- `scripts/ci-verify.sh verify|verify-and-package` retains sequential check/test/build/browser/site-deployment/layout gates and its Linux zero-skip budget.

## 3. Contracts

- Version 1.75.1 is pinned with separate official SHA-256 values for Linux amd64 and arm64 in the installer. `x86_64|amd64` selects amd64; `aarch64|arm64` selects arm64. No moving latest or distro fallback is allowed for newly provisioned rclone.
- Use CA-validated HTTPS and a fresh temporary directory. Check the reviewed digest before extraction, probe the extracted binary, then install mode 0755. A rejected download must preserve an existing executable. Clean temporary files on all exits after allocation.
- Explicit installation prerequisites: Bash, curl, unzip and coreutils. CI/Docker install packages before invoking the helper. GitHub invokes the privileged destination install with its existing elevated command; disposable CNB and Docker install as root.
- Pass the resulting absolute `RCLONE_BINARY` and discovered absolute `SEVEN_ZIP_BINARY` to tests and full browser checks. Set `RUN_BACKUP_INTEGRATION=1` in CI so all intended real encrypted archive cases execute.
- `CI_VERIFY_ALLOW_DEV=1` permits missing/incompatible-tool provisioning only in a disposable root CI environment. Existing compatible developer binaries remain usable. Recheck encryption capability after resolution/installation.
- The legacy environment key `7ZZ_BINARY` starts with a digit and must be read using `printenv 7ZZ_BINARY`; `${7ZZ_BINARY:-}` and `$7ZZ_BINARY` are invalid Bash variable references.
- The runtime image uses the same verified rclone package. Keep application config encryption, release triggers, tag promotion and deployment data handling unchanged.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unsupported architecture or extra arguments | Exit 2 before downloading/installing |
| Download failure, digest mismatch, extraction or capability failure | Nonzero exit; preserve installed tool and clean temporary directory |
| Old rclone exists but lacks encryption command | Do not accept `version` alone; provision when authorized for disposable CI, otherwise fail before tests |
| Linux real-tool tests skipped | Existing shared verification skip gate fails |
| Windows local verification | Report Linux installer/image execution limits and explicit platform-specific test skips |

## 5. Good / Base / Bad Cases

- Good: the exact same pinned package passes import/encryption tests in verification and is installed in the target architecture's runtime image.
- Base: an already compatible explicit local rclone path passes capability resolution without host package changes.
- Bad: Ubuntu's rclone 1.60.1 passes `version`, then 27 tests fail with an unsupported `config encryption` command; fixing CI alone leaves the Docker image with the same provisioning defect.

## 6. Tests Required

- `tests/rclone-installer.test.mjs` executes installer rejection on Linux: corrupt downloads for both published architectures and unsupported architecture must preserve the old executable and leave no temporary directory. Windows explicitly skips the POSIX fixture tests.
- `tests/ci-scripts.test.mjs` guards encrypted CLI capability wiring, shared provisioning and numeric environment-key discovery. Shell syntax checking alone cannot detect a bad parameter substitution in an unexecuted branch.
- Run real rclone plaintext import/encrypted restore/backup cases with absolute binary paths. Inspect the subsequent GitHub run rather than infer cloud success from Windows results. Runtime image/CNB/arm64 execution must have separate evidence before being claimed.

## 7. Wrong vs Correct

Wrong: install unpinned apt rclone everywhere, assert only `version`, or remove config encryption to make old binaries pass.

Correct: share the pinned installer across verification and runtime image, verify archive SHA before extraction, probe the required command and keep the application's encrypted configuration boundary.
