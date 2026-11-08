#!/bin/bash
# Install a complete release without npm, Node, Git, or administrator access.
set -euo pipefail
install_prefix="${TERMINAL_ELECTRON_PREFIX:-$HOME/.local}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || { echo '--prefix requires an absolute directory.' >&2; exit 1; }; install_prefix="$2"; shift 2 ;;
    --help|-h) echo 'Usage: bash install.sh [--prefix /absolute/path]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$install_prefix" = /* ]] || { echo 'The install prefix must be absolute.' >&2; exit 1; }
[[ "$(uname -s)" = Darwin && "$(uname -m)" = arm64 ]] || { echo 'This release requires an Apple Silicon Mac.' >&2; exit 1; }
os_version=$(sw_vers -productVersion)
[[ "${os_version%%.*}" -ge 14 ]] || { echo 'This release requires macOS 14 or later.' >&2; exit 1; }
source_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ -f "$source_directory/SHA256SUMS" && -f "$source_directory/VERSION" ]] || { echo 'Extract the complete terminal-electron release before installing.' >&2; exit 1; }
(cd "$source_directory" && shasum -a 256 -c SHA256SUMS >/dev/null)
version=$(cat "$source_directory/VERSION")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
digest=$(shasum -a 256 "$source_directory/SHA256SUMS"); digest=${digest%% *}; digest=${digest:0:12}
mkdir -p "$install_prefix/lib/terminal-electron" "$install_prefix/bin"
library=$(CDPATH= cd -- "$install_prefix/lib/terminal-electron" && pwd)
destination="$library/$version-$digest"
launcher="$install_prefix/bin/terminal-electron"
if [[ -e "$launcher" || -L "$launcher" ]]; then
  existing=$(readlink "$launcher" || true)
  case "$existing" in "$library/"*/terminal-electron) ;; *) echo "Refusing to replace an unrelated file: $launcher" >&2; exit 1 ;; esac
fi
mkdir "$library/.install-lock" 2>/dev/null || { echo 'Another installation is running. If interrupted, remove the .install-lock directory and retry.' >&2; exit 1; }
staging=''; temporary_link=''
cleanup() {
  [[ -z "$staging" ]] || rm -rf "$staging"
  [[ -z "$temporary_link" ]] || rm -f "$temporary_link"
  rmdir "$library/.install-lock"
}
trap cleanup EXIT
if [[ ! -d "$destination" ]]; then
  staging=$(mktemp -d "$library/.install-XXXXXX")
  ditto "$source_directory" "$staging"
  (cd "$staging" && shasum -a 256 -c SHA256SUMS >/dev/null)
  mv "$staging" "$destination"; staging=''
else
  (cd "$destination" && shasum -a 256 -c SHA256SUMS >/dev/null)
fi
temporary_link="$install_prefix/bin/.terminal-electron-$$"
ln -s "$destination/terminal-electron" "$temporary_link"
mv -f "$temporary_link" "$launcher"; temporary_link=''
echo "Installed terminal-electron $version: $launcher"
case ":$PATH:" in *":$install_prefix/bin:"*) echo 'Run: terminal-electron' ;; *) echo "Add $install_prefix/bin to PATH, or run: \"$launcher\"" ;; esac
echo 'Run terminal-electron to choose an app, or terminal-electron "/path/to/App.app".'
mkdir -p "$install_prefix/share/zsh/site-functions"
cp "$destination/app/src/completion.zsh" "$install_prefix/share/zsh/site-functions/_terminal-electron"
echo 'Optional zsh Tab completion: source <(terminal-electron --completion zsh)'
