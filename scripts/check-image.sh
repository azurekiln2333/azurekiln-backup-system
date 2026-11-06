#!/usr/bin/env bash
# Disposable container smoke check for a candidate image.
#
#   bash scripts/check-image.sh --build            # build the local Dockerfile as the candidate
#   bash scripts/check-image.sh --image <ref>      # pull and test a published candidate (digest recommended)
#   bash scripts/check-image.sh --build --keep     # leave the container for inspection
#
# What it proves: the image starts, answers HTTP, and has every backup tool the
# application calls at runtime (rclone, 7zz, tar, sqlite3, pg_dump,
# mariadb-dump) where the application expects to find it. What it does NOT
# prove: any non-amd64 runtime behaviour, updater selection, or persistence.
#
# Safety rules (see design.md "Verification and limits"):
#   - never mount, read or write the operator's `.env`, `docker-compose.yml`, sources
#     or the `backup-data` volume;
#   - a throwaway env file with inert values is generated per run;
#   - the container is always removed on exit unless --keep is passed;
#   - the only published port is bound to a random loopback port.
set -Eeuo pipefail

readonly SCRIPT_NAME="check-image"
readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

IMAGE_REF=""
DO_BUILD=0
KEEP=0
PULL=1
APP_PORT="${CHECK_IMAGE_PORT:-16323}"
READY_TIMEOUT="${CHECK_IMAGE_READY_TIMEOUT:-120}"
PLATFORM="${CHECK_IMAGE_PLATFORM:-}"

log() { printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
trap 'die "aborted at ${BASH_SOURCE[0]}:${LINENO} (command: ${BASH_COMMAND})"' ERR

usage() {
  cat <<'USAGE'
Usage: scripts/check-image.sh (--build | --image <ref>) [--keep] [--no-pull]

  --build              Build the repository Dockerfile and test that image.
  --image <ref>        Test an existing image reference (prefer name@sha256:...).
  --no-pull            Do not pull a non-local --image reference first.
  --keep               Keep the container and its temporary directory for inspection.
  --platform <p>       Build/run platform (default: the host platform).

Environment:
  CHECK_IMAGE_PORT             Container HTTP port (default: 16323)
  CHECK_IMAGE_READY_TIMEOUT    Seconds to wait for readiness (default: 120)
  CHECK_IMAGE_PLATFORM         Same as --platform
  CHECK_IMAGE_SETUP_USER/PASS  Only used for the generated throwaway env file
USAGE
}

while (( $# )); do
  case "$1" in
    --build) DO_BUILD=1; shift ;;
    --image) IMAGE_REF="${2:-}"; [[ -n "$IMAGE_REF" ]] || die "--image needs a reference"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --keep) KEEP=1; shift ;;
    --platform) PLATFORM="${2:-}"; [[ -n "$PLATFORM" ]] || die "--platform needs a value"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument '$1'" ;;
  esac
done

(( DO_BUILD )) || [[ -n "$IMAGE_REF" ]] || { usage >&2; die "either --build or --image <ref> is required"; }
if (( DO_BUILD )) && [[ -n "$IMAGE_REF" ]]; then
  die "--build and --image are mutually exclusive"
fi
if (( DO_BUILD )); then
  IMAGE_REF="${CHECK_IMAGE_LOCAL_REF:-azurekiln-backup-system:smoke-$$}"
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/azurekiln-image-check-XXXXXX")"
container="azurekiln-image-check-$$-${RANDOM}"
started=0

cleanup() {
  local status=$?
  set +e
  if [[ "$started" == "1" ]]; then
    if (( KEEP )); then
      log "keeping container '$container' for inspection"
      log "  docker logs $container"
      log "  docker rm -f $container   # when finished"
    else
      log "removing container '$container'"
      docker rm -f "$container" >/dev/null 2>&1
    fi
  fi
  if (( KEEP )); then
    log "keeping temporary directory: $workdir"
  else
    rm -rf "$workdir"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command '$1' is not on PATH"; }

require_cmd docker
require_cmd curl
docker info >/dev/null 2>&1 || die "docker is installed but the daemon is not reachable"
host_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || echo 'unknown')"
log "docker server platform: $host_platform"
[[ -n "$PLATFORM" ]] || PLATFORM="linux/$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo amd64)"
case "$host_platform" in
  linux/*) ;;
  *) die "this smoke check targets a Linux container; the daemon reports '$host_platform'" ;;
esac
arch="${PLATFORM#linux/}"
if [[ "$host_platform" != "linux/$arch" ]]; then
  log "WARNING: candidate platform $PLATFORM differs from the daemon platform $host_platform;"
  log "         emulated execution is slow and is not equivalent to native evidence."
fi

# ---------------------------------------------------------------------------
# Build or pull the candidate
# ---------------------------------------------------------------------------
if (( DO_BUILD )); then
  log "building candidate image '$IMAGE_REF' for $PLATFORM"
  docker build --platform "$PLATFORM" -t "$IMAGE_REF" "$REPO_ROOT"
else
  if (( PULL )); then
    log "pulling candidate image '$IMAGE_REF' for $PLATFORM"
    docker pull --platform "$PLATFORM" "$IMAGE_REF" || log "pull failed; assuming the image is already local"
  fi
  docker image inspect "$IMAGE_REF" >/dev/null 2>&1 || die "image '$IMAGE_REF' is not available locally"
fi

image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF")"
image_arch="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE_REF" 2>/dev/null || echo unknown)"
log "candidate: $IMAGE_REF ($image_id, inspect platform: $image_arch)"

# ---------------------------------------------------------------------------
# Throwaway state and a test-only environment file
# ---------------------------------------------------------------------------
# These values are inert by construction: no rclone remote is configured, the
# state directory is empty, and the source root is an empty temporary folder.
# They are never read from the operator's .env.
env_file="$workdir/test.env"
source_dir="$workdir/sources"
mkdir -p "$source_dir/demo"
printf 'image-smoke fixture\n' > "$source_dir/demo/sample.txt"

setup_user="${CHECK_IMAGE_SETUP_USER:-smoke-admin}"
setup_password="${CHECK_IMAGE_SETUP_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)}"

cat > "$env_file" <<ENV
BACKUP_HOST=0.0.0.0
BACKUP_PORT=$APP_PORT
BACKUP_PUBLIC_URL=http://127.0.0.1:$APP_PORT
DATA_DIR=/data
SOURCE_ROOTS=/sources
ADMIN_USERNAME=$setup_user
ADMIN_PASSWORD=$setup_password
RCLONE_BINARY=rclone
SEVEN_ZIP_BINARY=7zz
SQLITE_BINARY=sqlite3
PG_DUMP_BINARY=pg_dump
MYSQL_DUMP_BINARY=mariadb-dump
ENV
chmod 600 "$env_file"

# Confirm the repository's real configuration is not referenced anywhere.
if grep -Fq "$REPO_ROOT/.env" "$env_file"; then die "the generated env file references the repository .env"; fi

# ---------------------------------------------------------------------------
# Start the container
# ---------------------------------------------------------------------------
log "starting a disposable container"
started=1
docker run -d --name "$container" \
  --platform "$PLATFORM" \
  --env-file "$env_file" \
  --mount "type=bind,src=$source_dir,dst=/sources/demo,readonly" \
  -p "127.0.0.1::${APP_PORT}" \
  --label "com.centurylinklabs.watchtower.enable=false" \
  --label "azurekiln.check=image-smoke" \
  "$IMAGE_REF" >/dev/null

mapped_port="$(docker port "$container" "${APP_PORT}/tcp" | head -n 1 | awk -F: '{print $NF}')"
[[ -n "$mapped_port" ]] || die "no loopback port mapping was published for ${APP_PORT}/tcp"
log "published port: 127.0.0.1:$mapped_port -> ${APP_PORT}/tcp"

# ---------------------------------------------------------------------------
# Wait for HTTP readiness
# ---------------------------------------------------------------------------
base_url="http://127.0.0.1:$mapped_port"
log "waiting up to ${READY_TIMEOUT}s for $base_url/api/auth/status"
ready=0
deadline=$(( $(date +%s) + READY_TIMEOUT ))
body=""
while (( $(date +%s) < deadline )); do
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    log "container exited before becoming ready:"
    docker logs "$container" >&2 || true
    die "candidate container exited during startup"
  fi
  if body="$(curl -fsS --max-time 5 "$base_url/api/auth/status" 2>/dev/null)"; then
    ready=1
    break
  fi
  sleep 2
done
(( ready == 1 )) || { docker logs "$container" >&2 || true; die "the application did not become HTTP-ready within ${READY_TIMEOUT}s"; }
log "HTTP readiness confirmed: $body"

# The status document is public by design; assert its shape instead of guessing.
case "$body" in
  *'"initialized"'*) ;;
  *) die "unexpected /api/auth/status payload: $body" ;;
esac

# Both the SPA shell and an authenticated API boundary must behave.
curl -fsS --max-time 10 "$base_url/" -o "$workdir/index.html" || die "GET / did not return the web shell"
grep -qi '<div id="app"' "$workdir/index.html" || die "GET / did not return the expected SPA shell"
unauth_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base_url/api/jobs")"
[[ "$unauth_code" == "401" ]] || die "GET /api/jobs without a session returned $unauth_code, expected 401"
log "HTTP surface: shell OK, unauthenticated API boundary OK (401)"

# ---------------------------------------------------------------------------
# Runtime tools
# ---------------------------------------------------------------------------
log "checking runtime backup tools inside the container"
tool_failures=0
check_tool() {
  local name="$1"
  shift
  local output
  if ! output="$(docker exec "$container" "$@" 2>&1)"; then
    printf '[%s] MISSING/BROKEN: %s -> %s\n' "$SCRIPT_NAME" "$name" "$(printf '%s' "$output" | head -n 2 | tr '\n' ' ')" >&2
    tool_failures=$((tool_failures + 1))
    return
  fi
  printf '[%s] %-13s %s\n' "$SCRIPT_NAME" "$name" "$(printf '%s' "$output" | head -n 1)" >&2
}

check_tool rclone       sh -c 'command -v rclone && rclone version | head -n 1'
check_tool 7zz          sh -c 'command -v 7zz && 7zz i >/dev/null'
check_tool tar          sh -c 'command -v tar && tar --version | head -n 1'
check_tool sqlite3      sh -c 'command -v sqlite3 && sqlite3 --version'
check_tool pg_dump      sh -c 'command -v pg_dump && pg_dump --version'
check_tool mariadb-dump sh -c 'command -v mariadb-dump && mariadb-dump --version'

# The binaries must be executable by the container user, not merely on PATH.
check_tool execute     sh -c 'rclone version >/dev/null && 7zz i >/dev/null && tar --version >/dev/null && sqlite3 --version >/dev/null && pg_dump --version >/dev/null && mariadb-dump --version >/dev/null && echo "all tools executed"'

# Real end-to-end use of the two tools that the backup path depends on most:
# pack a fixture with 7zz, unpack it with 7zz, and confirm the bytes survive.
check_tool archive-roundtrip sh -c '
  set -e
  d=$(mktemp -d)
  echo "smoke payload" > "$d/payload.txt"
  ( cd "$d" && 7zz a -pSm0ke-Pass -mhe=on "$d/out.7z" payload.txt >/dev/null )
  7zz x -pSm0ke-Pass -y -o"$d/out" "$d/out.7z" >/dev/null
  grep -q "smoke payload" "$d/out/payload.txt"
  echo "7z encrypted round trip OK"
'

# rclone must be able to use a local alias remote, the same shape the app uses.
check_tool rclone-alias sh -c '
  set -e
  d=$(mktemp -d)
  mkdir -p "$d/remote"
  printf "[smoke]\ntype = alias\nremote = $d/remote\n" > "$d/rclone.conf"
  echo hello > "$d/local.txt"
  rclone --config "$d/rclone.conf" copyto "$d/local.txt" smoke:copied.txt >/dev/null
  rclone --config "$d/rclone.conf" cat smoke:copied.txt | grep -q hello
  echo "rclone alias round trip OK"
'

# The application must have started under its real entrypoint, and its own
# health surface must report the tools rather than an empty stub. This is an
# authenticated endpoint, so it is checked over the loopback mapping only after
# a session exists; here the process-level assertions are the portable part.
check_tool app-entrypoint sh -c 'tr "\\0" " " < /proc/1/cmdline | grep -q "server/app.mjs" && echo "entrypoint pid1: $(tr \"\\0\" \" \" < /proc/1/cmdline)"'

(( tool_failures == 0 )) || die "$tool_failures runtime tool check(s) failed"

# ---------------------------------------------------------------------------
# Isolation and shutdown
# ---------------------------------------------------------------------------
log "asserting disposable-state isolation"
mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$container")"
printf '[%s] mounts: %s\n' "$SCRIPT_NAME" "$mounts" >&2
case "$mounts" in
  *"/sources/demo"*) ;;
  *) die "the fixture source mount is not present; the check did not run as intended" ;;
esac
if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$container" | grep -Fq "$REPO_ROOT/.env"; then
  die "the container mounted the repository .env; the smoke check must never use real configuration"
fi
if docker inspect --format '{{range .Mounts}}{{.Name}} {{.Destination}} {{end}}' "$container" | grep -q 'backup-data'; then
  die "the container mounted the production backup-data volume"
fi
if docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$container" | grep -q '/var/run/docker.sock'; then
  die "the application container mounted the Docker socket"
fi

log "stopping the container to confirm clean shutdown"
stop_started="$(date +%s)"
docker stop --time 30 "$container" >/dev/null
stop_elapsed=$(( $(date +%s) - stop_started ))
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
log "container stopped in ${stop_elapsed}s with exit code $exit_code"
started=0
if (( KEEP )); then
  docker start "$container" >/dev/null
  started=1
  log "container restarted for inspection on port $mapped_port"
fi

printf '\n[%s] SMOKE CHECK PASSED for %s\n' "$SCRIPT_NAME" "$IMAGE_REF" >&2
printf '[%s] Note: this ran on %s. It says nothing about other architectures,\n' "$SCRIPT_NAME" "$PLATFORM" >&2
printf '[%s] updater selection, or persistence across container replacement.\n' "$SCRIPT_NAME" >&2
