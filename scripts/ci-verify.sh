#!/usr/bin/env bash
# Linux verification entrypoint for both delivery pipelines (GitHub Actions and CNB).
#
#   bash scripts/ci-verify.sh verify              # checks, tests, build, browser, layout
#   bash scripts/ci-verify.sh verify-and-package  # the above, then scripts/prepare-release.mjs
#
# Why this file exists: the test suites decide whether their real-tool cases run
# by probing binary paths (`existsSync`, `process.platform !== 'win32'`), and the
# browser checks only look at `$BROWSER_EXECUTABLE` or a hardcoded Chrome path.
# Without this script a Linux runner would report green while silently skipping
# the rclone / 7-Zip / tar round trips. Everything below therefore resolves
# ABSOLUTE paths, proves each binary actually executes, and fails loudly instead
# of degrading to a skip.
#
# Requirements (see design.md "Verification and limits"):
#   - npm run check / test / build, then browser + layout SEQUENTIALLY.
#   - The browser executable must come from the locked playwright-core version.
#   - The package mode must reuse scripts/prepare-release.mjs rather than
#     re-implementing release metadata here.
set -Eeuo pipefail

readonly SCRIPT_NAME="ci-verify"
readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ARTIFACT_ROOT="${CI_VERIFY_ARTIFACT_DIR:-$REPO_ROOT/.artifacts/ci}"
readonly MAIN_SCENARIO="${CI_VERIFY_MAIN_SCENARIO:-azurekiln-ci-main}"

# npm install strategy: `ci` (default) or `install`.
INSTALL_MODE="${CI_VERIFY_INSTALL:-ci}"
# Chromium location strategies: `auto` (default), `download` (force
# playwright-core install), `system` (prefer an already installed browser).
BROWSER_STRATEGY="${CI_VERIFY_BROWSER_STRATEGY:-auto}"
# Number of skipped tests tolerated in the whole suite. On Linux the expected
# value is 0: every real-tool case must execute.
MAX_SKIPPED="${CI_VERIFY_MAX_SKIPPED:-0}"
# Test names that must visibly execute (not skip) in the reported test output.
# One per line; fixed strings, matched inside `# Subtest: <name>` blocks.
readonly DEFAULT_MUST_RUN='round trip: the real encrypted archive
survives a real system-configuration backup
directory upload, completion marker
rclone invalid import
real encrypted file backup
real encrypted 7z and ZIP'
MUST_RUN_PATTERNS="${CI_VERIFY_MUST_RUN-$DEFAULT_MUST_RUN}"
readonly -a TOOL_KEYS=(rclone seven_zip tar sqlite3 pg_dump mariadb_dump)
# Set by install_host_tools when the host package manager had to supply tools.
HOST_TOOLS_INSTALLED=0
# Release helper entrypoint invoked by the package mode.
PREPARE_RELEASE="${PREPARE_RELEASE_SCRIPT:-$REPO_ROOT/scripts/prepare-release.mjs}"

declare -A TOOL_PATH=()

log() { printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2; }
section() { printf '\n[%s] ==== %s ====\n' "$SCRIPT_NAME" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
trap 'die "aborted at ${BASH_SOURCE[0]}:${LINENO} (command: ${BASH_COMMAND})"' ERR

usage() {
  cat <<'USAGE'
Usage: scripts/ci-verify.sh <verify|verify-and-package>

Environment overrides (all optional):
  CI_VERIFY_INSTALL=ci|install          npm dependency install strategy (default: ci)
  CI_VERIFY_BROWSER_STRATEGY=auto|download|system   Chromium acquisition (default: auto)
  CI_VERIFY_MAX_SKIPPED=<n>             skipped-test budget (default: 0)
  CI_VERIFY_MUST_RUN=<patterns>         newline-separated test names that must not be skipped
  CI_VERIFY_ARTIFACT_DIR=<dir>          logs and screenshots (default: .artifacts/ci)
  PREPARE_RELEASE_SCRIPT=<path>         release helper for verify-and-package
  CI_VERIFY_ALLOW_DEV=1                 permit installing rclone/7-Zip/tar with the host package manager
                                        when they are missing (CI containers only)
  7ZZ_BINARY/SEVEN_ZIP_BINARY           explicit 7-Zip executable (7zz, 7zzs or 7z)
  RCLONE_BINARY/SQLITE_BINARY/PG_DUMP_BINARY/MARIADB_DUMP_BINARY  explicit tool paths
  TAR_BINARY                            tar candidate used only to resolve a path (tar has no app override)
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' is not on PATH"
}

# Resolve a command name or path to an absolute, regular, executable path.
resolve_executable() {
  local candidate="$1" resolved=""
  [[ -n "$candidate" ]] || return 1
  if [[ "$candidate" == */* ]]; then
    [[ -f "$candidate" ]] || return 1
    resolved="$(cd -- "$(dirname -- "$candidate")" && pwd -P)/$(basename -- "$candidate")"
  else
    resolved="$(command -v -- "$candidate" 2>/dev/null || true)"
    [[ -n "$resolved" ]] || return 1
    resolved="$(readlink -f -- "$resolved" 2>/dev/null || printf '%s' "$resolved")"
  fi
  [[ -f "$resolved" ]] || return 1
  [[ -x "$resolved" ]] || return 1
  printf '%s' "$resolved"
}

# Pick the first candidate that resolves. Sets RESOLVED_EXECUTABLE.
RESOLVED_EXECUTABLE=""
pick_executable() {
  local candidate resolved=""
  RESOLVED_EXECUTABLE=""
  for candidate in "$@"; do
    if resolved="$(resolve_executable "$candidate")"; then
      RESOLVED_EXECUTABLE="$resolved"
      return 0
    fi
  done
  return 1
}

# Prove a binary actually runs: not merely present on disk, but executing.
# `assert_tool <key> <probe-args...>` uses ${TOOL_PATH[key]}.
assert_tool() {
  local key="$1"
  shift
  local binary="${TOOL_PATH[$key]:-}"
  [[ -n "$binary" ]] || die "no executable resolved for tool '$key'"
  local output
  if ! output="$("$binary" "$@" 2>&1)"; then
    die "tool '$key' resolved to '$binary' but failed to execute (probe: $binary $*)"
  fi
  printf '[%s] %-14s %s | %s\n' "$SCRIPT_NAME" "$key" "$binary" "$(printf '%s' "$output" | head -n 1)" >&2
}

install_host_tools() {
  # Only ever used inside a disposable CI container; a developer machine must
  # install its own tools so the local suite keeps its documented behaviour.
  if [[ "${CI_VERIFY_ALLOW_DEV:-0}" != "1" ]]; then
    die "backup tools are missing. Install rclone, 7-Zip (7zz), tar, sqlite3, postgresql-client and mariadb-client, or set CI_VERIFY_ALLOW_DEV=1 inside a disposable CI container."
  fi
  [[ "$(id -u)" == "0" ]] || die "CI_VERIFY_ALLOW_DEV=1 requires root to install packages"
  require_cmd apt-get
  log "installing missing backup tools with apt-get"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates rclone 7zip tar sqlite3 postgresql-client mariadb-client
  HOST_TOOLS_INSTALLED=1
}

resolve_tools() {
  local rclone_candidates=() seven_zip_candidates=() tar_candidates=() sqlite_candidates=() pg_candidates=() mysql_candidates=()
  [[ -n "${RCLONE_BINARY:-}" ]] && rclone_candidates+=("$RCLONE_BINARY")
  rclone_candidates+=(rclone /usr/bin/rclone /usr/local/bin/rclone)
  if [[ -n "${7ZZ_BINARY:-}" ]]; then seven_zip_candidates+=("$7ZZ_BINARY"); fi
  if [[ -n "${SEVEN_ZIP_BINARY:-}" ]]; then seven_zip_candidates+=("$SEVEN_ZIP_BINARY"); fi
  # 7zz is the current upstream name; 7zzs is the static build; 7z is Debian's
  # 7zip package entry point. tests/newapi.test.mjs falls back to '7z' on Linux.
  seven_zip_candidates+=(7zz 7zzs 7z /usr/bin/7zz /usr/bin/7zzs /usr/bin/7z /usr/lib/p7zip/7z)
  [[ -n "${TAR_BINARY:-}" ]] && tar_candidates+=("$TAR_BINARY")
  tar_candidates+=(tar /bin/tar /usr/bin/tar)
  [[ -n "${SQLITE_BINARY:-}" ]] && sqlite_candidates+=("$SQLITE_BINARY")
  sqlite_candidates+=(sqlite3 /usr/bin/sqlite3)
  [[ -n "${PG_DUMP_BINARY:-}" ]] && pg_candidates+=("$PG_DUMP_BINARY")
  pg_candidates+=(pg_dump)
  [[ -n "${MARIADB_DUMP_BINARY:-}" ]] && mysql_candidates+=("$MARIADB_DUMP_BINARY")
  [[ -n "${MYSQL_DUMP_BINARY:-}" ]] && mysql_candidates+=("$MYSQL_DUMP_BINARY")
  mysql_candidates+=(mariadb-dump mysqldump)

  local missing=0
  if pick_executable "${rclone_candidates[@]}"; then TOOL_PATH[rclone]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  if pick_executable "${seven_zip_candidates[@]}"; then TOOL_PATH[seven_zip]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  if pick_executable "${tar_candidates[@]}"; then TOOL_PATH[tar]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  if pick_executable "${sqlite_candidates[@]}"; then TOOL_PATH[sqlite3]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  if pick_executable "${pg_candidates[@]}"; then TOOL_PATH[pg_dump]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  if pick_executable "${mysql_candidates[@]}"; then TOOL_PATH[mariadb_dump]="$RESOLVED_EXECUTABLE"; else missing=1; fi
  (( missing == 0 )) && return

  # Escalation path: a disposable CI container with CI_VERIFY_ALLOW_DEV=1.
  install_host_tools
  TOOL_PATH=()
  if pick_executable rclone /usr/bin/rclone; then TOOL_PATH[rclone]="$RESOLVED_EXECUTABLE"; else die "rclone is still unavailable after installation"; fi
  if pick_executable 7zz 7zzs 7z /usr/bin/7zz /usr/bin/7zzs /usr/bin/7z; then TOOL_PATH[seven_zip]="$RESOLVED_EXECUTABLE"; else die "7-Zip is still unavailable after installation"; fi
  if pick_executable tar /bin/tar /usr/bin/tar; then TOOL_PATH[tar]="$RESOLVED_EXECUTABLE"; else die "tar is still unavailable after installation"; fi
  if pick_executable sqlite3 /usr/bin/sqlite3; then TOOL_PATH[sqlite3]="$RESOLVED_EXECUTABLE"; else die "sqlite3 is still unavailable after installation"; fi
  if pick_executable pg_dump; then TOOL_PATH[pg_dump]="$RESOLVED_EXECUTABLE"; else die "pg_dump is still unavailable after installation"; fi
  if pick_executable mariadb-dump mysqldump; then TOOL_PATH[mariadb_dump]="$RESOLVED_EXECUTABLE"; else die "mariadb-dump is still unavailable after installation"; fi
}

assert_all_tools() {
  assert_tool rclone version
  # `7z i` lists formats/formats-in-use and exits 0 for 7zz, 7zzs and 7z.
  assert_tool seven_zip i
  assert_tool tar --version
  assert_tool sqlite3 --version
  assert_tool pg_dump --version
  assert_tool mariadb_dump --version
}

export_tool_environment() {
  # Only export variables that server/config.mjs actually consumes. `tarBinary` is
  # NOT part of loadConfig (backup.mjs falls back to 'tar' via PATH), and
  # tests/executor.test.mjs compares spawned binaries against
  # config.pgDumpBinary/config.mysqlDumpBinary. Exporting a *_BINARY the runtime
  # ignores would silently make the suite exercise a different tool than the one
  # we just asserted, so tar is made available through PATH instead.
  export RCLONE_BINARY="${TOOL_PATH[rclone]}"
  export SEVEN_ZIP_BINARY="${TOOL_PATH[seven_zip]}"
  export SQLITE_BINARY="${TOOL_PATH[sqlite3]}"
  export PG_DUMP_BINARY="${TOOL_PATH[pg_dump]}"
  export MYSQL_DUMP_BINARY="${TOOL_PATH[mariadb_dump]}"
  export PATH="$(dirname -- "${TOOL_PATH[tar]}"):$PATH"
  # Enable the opt-in live cases in tests/integration.test.mjs and
  # tests/file-clone.test.mjs. This is a hard requirement, not a convenience:
  # without it the real rclone/7-Zip round trips are never executed.
  export RUN_BACKUP_INTEGRATION=1
  # Keep suites from reaching a real rclone configuration or cloud remote.
  export RCLONE_CONFIG_SOURCE=""
  unset AZUREKILN_RCLONE_CONFIG_PASSWORD || true
  # Deterministic, non-interactive subprocesses. LANG/LC_ALL are only set when
  # the container actually provides a UTF-8 locale; forcing LC_ALL=C.UTF-8 on an
  # image without it makes every Node process print locale warnings.
  export NO_COLOR=1
  export TZ=UTC
  if locale -a 2>/dev/null | grep -qiE '^(C|en_US)\.utf-?8$'; then
    locale_name="$(locale -a 2>/dev/null | grep -iE '^(C|en_US)\.utf-?8$' | head -n 1)"
    export LANG="$locale_name"
  else
    log "WARNING: no UTF-8 locale found; leaving LANG/LC_ALL unmodified"
  fi
}

install_dependencies() {
  require_cmd npm
  local npm_version node_version lock_hash
  node_version="$(node --version)"
  npm_version="$(npm --version)"
  log "node $node_version / npm $npm_version"
  # Node >= 24 is required by package.json engines and node:sqlite.
  local major="${node_version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || die "cannot parse node version '$node_version'"
  (( major >= 24 )) || die "node >= 24 is required, found $node_version"
  [[ -f package-lock.json ]] || die "package-lock.json is missing; deterministic installs are impossible"
  lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
  log "package-lock.json sha256: $lock_hash"
  # Always install into the worktree: the browser/test scripts are resolved
  # relative to it, and `npm ci` wipes node_modules deterministically.
  case "$INSTALL_MODE" in
    ci)
      if [[ -f node_modules/.package-lock.json ]] \
        && [[ -f node_modules/.ci-lock-hash ]] \
        && [[ "$(cat node_modules/.ci-lock-hash)" == "$lock_hash" ]]; then
        log "node_modules already matches package-lock.json; skipping npm ci"
      else
        log "running npm ci (removes any partial node_modules)"
        npm ci --no-audit --no-fund
        printf '%s' "$lock_hash" > node_modules/.ci-lock-hash
      fi
      ;;
    install)
      log "running npm install (explicit CI_VERIFY_INSTALL=install)"
      npm install --no-audit --no-fund
      printf '%s' "$lock_hash" > node_modules/.ci-lock-hash
      ;;
    *) die "CI_VERIFY_INSTALL must be 'ci' or 'install', found '$INSTALL_MODE'" ;;
  esac
  [[ -x node_modules/.bin/vue-tsc ]] || die "vue-tsc is missing after install"
  [[ -d node_modules/playwright-core ]] || die "playwright-core is missing after install"
}

# Ask the locked playwright-core package where its Chromium lives. This is the
# only version-aware answer; a hardcoded path can silently use a browser built
# for a different revision.
playwright_chromium_path() {
  node -e '
    const { chromium } = require("./node_modules/playwright-core");
    try { process.stdout.write(chromium.executablePath() || ""); } catch { process.stdout.write(""); }
  ' 2>/dev/null || true
}

resolve_browser() {
  if [[ -n "${BROWSER_EXECUTABLE:-}" ]]; then
    RESOLVED_EXECUTABLE="$(resolve_executable "$BROWSER_EXECUTABLE")" \
      || die "BROWSER_EXECUTABLE='$BROWSER_EXECUTABLE' is not an executable file"
    log "using caller-provided browser executable: $RESOLVED_EXECUTABLE"
    export BROWSER_EXECUTABLE="$RESOLVED_EXECUTABLE"
    return
  fi

  local playwright_version candidate=""
  playwright_version="$(node -p "require('./node_modules/playwright-core/package.json').version")"
  log "locked playwright-core version: $playwright_version"

  # 1) A browser the locked package already installed (cache hit on a warm agent).
  [[ "$BROWSER_STRATEGY" == "system" ]] || candidate="$(playwright_chromium_path)"

  # 2) Install the browser build that matches the locked version.
  if [[ "$BROWSER_STRATEGY" != "system" && ( -z "$candidate" || ! -x "$candidate" ) ]]; then
    log "installing Chromium for playwright-core $playwright_version"
    # --with-deps needs root for OS packages; fall back to a plain download and
    # let the resolution below report a hard error if nothing is usable.
    if ! npx --no-install playwright-core install --with-deps chromium; then
      log "install --with-deps failed; retrying the browser download only"
      npx --no-install playwright-core install chromium \
        || log "playwright-core browser download failed; falling back to a system browser"
    fi
    candidate="$(playwright_chromium_path)"
  fi

  if [[ -z "$candidate" || ! -x "$candidate" ]]; then
    # 3) An operating-system Chromium already on the image.
    if pick_executable chromium /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; then
      candidate="$RESOLVED_EXECUTABLE"
      log "using OS Chromium: $candidate (may not match playwright-core $playwright_version)"
    else
      die "no Chromium executable found. Run 'npx playwright-core install --with-deps chromium' or set BROWSER_EXECUTABLE."
    fi
  fi

  local reported
  reported="$("$candidate" --version 2>&1 | head -n 1 || true)"
  [[ "$candidate" == /* ]] || die "resolved browser path is not absolute: $candidate"
  log "browser executable: $candidate${reported:+ ($reported)}"
  # If the managed browser was not used, say so plainly: a revision mismatch
  # otherwise surfaces as a confusing playwright protocol error much later.
  if [[ "$BROWSER_STRATEGY" == "auto" && "$candidate" != *"chromium-"* ]]; then
    log "WARNING: '$candidate' is not a playwright-managed chromium build for $playwright_version"
  fi
  export BROWSER_EXECUTABLE="$candidate"
}

# The test step is run with the TAP reporter on purpose: the default reporter
# changed to a human format in recent Node versions, while the skip budget and
# required-case checks parse the stable `# Subtest:` / `ok N - … # SKIP` form.
run_tests() {
  npm test -- --test-reporter=tap
}

run_step() {
  local name="$1"
  shift
  local logfile="$ARTIFACT_ROOT/$name.log"
  section "$name"
  local started ended
  started="$(date +%s)"
  set +e
  "$@" 2>&1 | tee "$logfile"
  local status="${PIPESTATUS[0]}"
  set -e
  ended="$(date +%s)"
  if [[ "$status" -ne 0 ]]; then
    printf '\n[%s] FAILED: %s (exit %s, %ss) — log: %s\n' "$SCRIPT_NAME" "$name" "$status" "$((ended - started))" "$logfile" >&2
    if [[ "$name" == "browser" || "$name" == "layout" ]]; then
      local shots="$REPO_ROOT/.artifacts"
      if [[ -d "$shots" ]]; then log "screenshots/diagnostics (if any) are under $shots"; fi
    fi
    exit "$status"
  fi
  printf '[%s] PASSED: %s (%ss)\n' "$SCRIPT_NAME" "$name" "$((ended - started))" >&2
  local summary=""
  summary="$(grep -E '^# (tests|pass|fail|skipped|cancelled|todo|duration_ms)' "$logfile" | tr '\n' ' ' || true)"
  printf '%s %s\n' "$name:" "${summary:- (no node --test summary line)}" >> "$ARTIFACT_ROOT/summary.txt"
}

# The aggregate skip gate. On Linux no real-tool case may silently degrade.
assert_skips_within_budget() {
  section "skip-budget"
  local logfile="$ARTIFACT_ROOT/test.log"
  local skipped total
  # Only the aggregate line `# skipped N` is authoritative.
  skipped="$(grep -E '^# skipped [0-9]+$' "$logfile" | awk '{print $3}' | tail -n 1 || true)"
  skipped="${skipped:-0}"
  total="$(grep -E '^# tests [0-9]+$' "$logfile" | awk '{print $3}' | tail -n 1 || true)"
  total="${total:-0}"
  log "tests=$total skipped=$skipped budget=$MAX_SKIPPED"
  if (( total == 0 )); then die "the test run reported zero tests; refusing to treat that as success"; fi
  if (( skipped > MAX_SKIPPED )); then
    printf 'Skipped tests exceeded the budget (%s > %s).\n' "$skipped" "$MAX_SKIPPED" >&2
    printf 'A real-tool skip on Linux means a missing or non-executing binary,\n' >&2
    printf 'not an acceptable platform difference. Inspect %s.\n' "$logfile" >&2
    die "skipped-test budget exceeded"
  fi
}
# A required case that appears in the output only as a skip is a defect, even
# when the aggregate skip budget happens to be satisfied by other suites.
assert_required_cases_executed() {
  section "required-live-cases"
  local logfile="$ARTIFACT_ROOT/test.log" pattern matched=0 tolerated=0 failures=0
  local patterns
  patterns="$(printf '%s\n' "$MUST_RUN_PATTERNS" | sed 's/\r//g')"
  while IFS= read -r pattern; do
    [[ -n "$pattern" ]] || continue
    local block=""
    # node --test wraps a subtest in `# Subtest: <name>` / `ok N - <name>` (or
    # `not ok`), with `# SKIP <reason>` inside for a skipped case.
    block="$(awk -v pat="$pattern" '
      /^# Subtest: / { inside = 0; if (index($0, pat)) { inside = 1; print } next }
      inside { print }
    ' "$logfile" || true)"
    if [[ -z "$block" ]]; then
      log "NOTE: no case name matched /$pattern/ (names may have changed; not fatal)"
      tolerated=$((tolerated + 1))
      continue
    fi
    # A skipped case prints `# SKIP <reason>` inside its block. Match that exact
    # marker: `^# skip` would also hit the aggregate `# skipped 0` summary line.
    if printf '%s\n' "$block" | grep -Eq '^# SKIP|^ *not ok |^ *ok [0-9]+ - .*# SKIP'; then
      printf '%s\n' "$block" >&2
      log "ERROR: required case /$pattern/ did not execute"
      failures=$((failures + 1))
      continue
    fi
    matched=$((matched + 1))
  done <<< "$patterns"
  log "required cases executed=$matched unmatched=$tolerated failures=$failures"
  (( failures == 0 )) || die "a required real-tool case was skipped; the suite must run it in CI"
}

write_tool_report() {
  {
    printf 'node=%s\n' "$(node --version)"
    printf 'npm=%s\n' "$(npm --version)"
    printf 'rclone=%s\n' "${TOOL_PATH[rclone]}"
    printf 'seven_zip=%s\n' "${TOOL_PATH[seven_zip]}"
    printf 'tar=%s (PATH-resolved; the app config has no tar override)\n' "${TOOL_PATH[tar]}"
    printf 'sqlite3=%s\n' "${TOOL_PATH[sqlite3]}"
    printf 'pg_dump=%s\n' "${TOOL_PATH[pg_dump]}"
    printf 'mariadb_dump=%s\n' "${TOOL_PATH[mariadb_dump]}"
    printf 'host_tools_installed=%s\n' "$HOST_TOOLS_INSTALLED"
    printf 'browser=%s\n' "${BROWSER_EXECUTABLE:-}"
    printf 'run_backup_integration=%s\n' "${RUN_BACKUP_INTEGRATION:-}"
  } > "$ARTIFACT_ROOT/tools.txt"
  cat "$ARTIFACT_ROOT/tools.txt" >&2
}

package_release() {
  section "package"
  [[ -f "$PREPARE_RELEASE" ]] || die "release helper '$PREPARE_RELEASE' does not exist; the package mode cannot fabricate release metadata"
  # A bare invocation is the helper's documented bundle mode. Keep stdout raw and
  # on disk so the JSON contract can be parsed without log formatting, and copy
  # the whole output to the artifact log for the job summary.
  local logfile="$ARTIFACT_ROOT/package.log"
  local stdout_file="$ARTIFACT_ROOT/package.stdout"
  set +e
  node "$PREPARE_RELEASE" >"$stdout_file" 2>&1
  local status=$?
  set -e
  cat "$stdout_file" >&2
  cp "$stdout_file" "$logfile" 2>/dev/null || true
  (( status == 0 )) || die "release preparation failed (exit $status); see $logfile"

  # The owning lane defines this contract: exactly one JSON line with the bundle
  # metadata, followed by a bare path line. Consume the JSON rather than guessing
  # from path-shaped text: a Windows-style absolute path has no forward slashes.
  local meta_lines
  meta_lines="$(node -e '
    const { readFileSync } = require("node:fs");
    const lines = readFileSync(process.argv[1], "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const meta = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((value) => value && typeof value.archivePath === "string" && typeof value.digest === "string");
    if (!meta) process.exit(3);
    // The helper names the file `archive`; `archiveName` is accepted as well so
    // an owner-side rename cannot silently produce an empty value.
    const name = meta.archiveName ?? meta.archive ?? "";
    for (const value of [meta.archivePath, meta.sidecarPath, name, meta.digest, meta.version, meta.tag, meta.isPrerelease]) {
      process.stdout.write(String(value ?? "") + "\n");
    }
  ' "$stdout_file")" || die "the release helper did not print the documented metadata contract (see $logfile)"

  local archive_path sidecar_path archive_name digest version tag is_prerelease
  { IFS= read -r archive_path; IFS= read -r sidecar_path; IFS= read -r archive_name;
    IFS= read -r digest; IFS= read -r version; IFS= read -r tag; IFS= read -r is_prerelease; } <<< "$meta_lines"

  [[ -n "$archive_name" && -n "$archive_path" ]] || die "the release helper reported no archive"
  [[ -f "$archive_path" ]] || die "the release helper reported '$archive_path' but no such file exists"
  [[ -f "$sidecar_path" ]] || die "the release helper reported '$sidecar_path' but no checksum sidecar exists"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "the release helper reported a malformed digest: '$digest'"

  # The published bytes must match both the reported digest and the sidecar.
  # Hash from the archive's own directory: GNU sha256sum escapes a path that
  # contains a backslash, and Windows-style paths make that observable.
  local actual_digest sidecar_digest
  actual_digest="$(cd -- "$(dirname -- "$archive_path")" && sha256sum -- "$(basename -- "$archive_path")" | cut -d' ' -f1)"
  sidecar_digest="$(cd -- "$(dirname -- "$sidecar_path")" && sha256sum --check --status -- "$(basename -- "$sidecar_path")" >/dev/null 2>&1 && cut -d' ' -f1 "$sidecar_path")"
  [[ "$actual_digest" == "$digest" ]] || die "archive digest '$actual_digest' does not match the reported '$digest'"
  [[ "$sidecar_digest" == "$digest" ]] || die "the sha256 sidecar does not describe the produced archive"

  # Private configuration and local state must never be inside a published bundle.
  # List from the archive's directory: GNU tar reads a leading `C:`/`D:` in a
  # path as a remote host name. The archive name comes from our own metadata, so
  # it starts with a letter and needs no `--` guard.
  local members
  members="$(cd -- "$(dirname -- "$archive_path")" && tar -tzf "$(basename -- "$archive_path")")" \
    || die "the release bundle is not a readable gzip archive: $archive_path"
  local forbidden
  # `.env` must match exactly: `.env.docker.example` is a required member, so a
  # loose `\.env\.` pattern would reject a correct bundle.
  for forbidden in '(^|/)\.env$' '(^|/)secret\.key$' '(^|/)secret\.key\.[^/]*$' '(^|/)\.data(/|$)' '(^|/)node_modules(/|$)' '(^|/)\.trellis(/|$)' '(^|/)\.artifacts(/|$)' '(^|/)sources(/|$)' '(^|/)\.git(/|$)' '(^|/)\.claude(/|$)' '(^|/)\.codex(/|$)' '(^|/)\.pi(/|$)'; do
    if printf '%s\n' "$members" | grep -Eq "$forbidden"; then
      die "the release bundle contains a private member matching $forbidden"
    fi
  done
  # An installation bundle that cannot be deployed is not a bundle.
  local required
  for required in 'docker-compose\.yml' 'docker-compose\.build\.yml' '\.env\.docker\.example'; do
    if ! printf '%s\n' "$members" | grep -Eq "(^|/)$required$"; then
      die "the release bundle is missing a required deployment file matching $required"
    fi
  done

  log "bundle: $archive_name ($(wc -c < "$archive_path" | tr -d ' ') bytes, sha256 $digest)"
  log "version=$version tag=$tag prerelease=$is_prerelease"
  log "package mode completed"
}


main() {
  local mode="${1:-}"
  case "$mode" in
    verify|verify-and-package) ;;
    -h|--help|help) usage; exit 0 ;;
    "") usage >&2; die "a mode argument is required (verify or verify-and-package)" ;;
    *) usage >&2; die "unknown mode '$mode' (expected verify or verify-and-package)" ;;
  esac

  case "$(uname -s)" in
    Linux) ;;
    *) die "scripts/ci-verify.sh is the Linux pipeline entrypoint; on $(uname -s) use the npm scripts directly" ;;
  esac

  mkdir -p "$ARTIFACT_ROOT"
  : > "$ARTIFACT_ROOT/summary.txt"
  section "environment"
  log "repo: $REPO_ROOT"
  log "mode: $mode"
  log "scenario: $MAIN_SCENARIO"
  require_cmd node
  require_cmd sha256sum
  require_cmd tee

  resolve_tools
  section "tools"
  assert_all_tools
  export_tool_environment
  install_dependencies
  resolve_browser
  write_tool_report

  # A production install must never see the operator's real configuration.
  if [[ -f "$REPO_ROOT/.env" ]]; then
    log "WARNING: a .env file exists in the worktree. Tests create their own fixtures,"
    log "         but the image smoke check must keep using test-only environment files."
  fi

  run_step check npm run check
  run_step test run_tests
  assert_skips_within_budget
  assert_required_cases_executed
  run_step build npm run build
  # Browser and layout checks share the source fixtures, backup tools and the
  # built web/dist output, so they run strictly sequentially.
  run_step browser npm run check:browser
  run_step layout npm run check:layout

  if [[ "$mode" == "verify-and-package" ]]; then
    package_release
  fi

  section "done"
  log "all verification steps passed; artifacts in $ARTIFACT_ROOT"
}

main "$@"
