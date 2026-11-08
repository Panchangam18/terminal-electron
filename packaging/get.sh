#!/bin/bash
# curl -fsSL https://github.com/Panchangam18/terminal-electron/releases/latest/download/get.sh | bash
set -euo pipefail
[[ "$(uname -s)" = Darwin && "$(uname -m)" = arm64 ]] || { echo 'This release requires an Apple Silicon Mac.' >&2; exit 1; }
os_version=$(sw_vers -productVersion)
[[ "${os_version%%.*}" -ge 14 ]] || { echo 'This release requires macOS 14 or later.' >&2; exit 1; }
archive='@ARCHIVE@'
url='https://github.com/Panchangam18/terminal-electron/releases/download/@TAG@/@ARCHIVE@'
sha256='@SHA256@'
download_directory=$(mktemp -d "${TMPDIR:-/tmp}/terminal-electron-get.XXXXXX")
trap 'rm -rf "$download_directory"' EXIT
echo 'Downloading terminal-electron @VERSION@…'
curl -fL --progress-bar "$url" -o "$download_directory/$archive"
echo "$sha256  $download_directory/$archive" | shasum -a 256 -c - >/dev/null || { echo 'Checksum mismatch; nothing was installed.' >&2; exit 1; }
ditto -x -k "$download_directory/$archive" "$download_directory/unpacked"
bash "$download_directory/unpacked/${archive%.zip}/install.sh" "$@"
