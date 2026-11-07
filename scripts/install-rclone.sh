#!/usr/bin/env bash
# Shared Linux installer for verification runners and the published image.
set -euo pipefail

if (( $# > 1 )); then
  echo 'Usage: scripts/install-rclone.sh [destination-directory]' >&2
  exit 2
fi

readonly version='1.75.1'
readonly destination="${1:-/usr/local/bin}"
case "$(uname -m)" in
  x86_64|amd64)
    architecture='amd64'
    checksum='982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab'
    ;;
  aarch64|arm64)
    architecture='arm64'
    checksum='03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9'
    ;;
  *) echo 'Unsupported rclone installation architecture' >&2; exit 2 ;;
esac

workdir="$(mktemp -d "${TMPDIR:-/tmp}/azurekiln-rclone.XXXXXXXX")"
trap 'rm -rf -- "$workdir"' EXIT
readonly archive="$workdir/rclone.zip"
readonly package="rclone-v${version}-linux-${architecture}"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 \
  "https://downloads.rclone.org/v${version}/${package}.zip" --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
unzip -q "$archive" "$package/rclone" -d "$workdir"

# A version-only check missed the distro package's unsupported encryption CLI.
"$workdir/$package/rclone" config encryption set --help | grep -Fq 'rclone config encryption set [flags]'
install -d -- "$destination"
install -m 0755 -- "$workdir/$package/rclone" "$destination/rclone"
"$destination/rclone" version
