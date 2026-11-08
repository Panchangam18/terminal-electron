#!/bin/sh
# terminal-electron managed release launcher
set -eu
terminal_electron_script=$0
while [ -L "$terminal_electron_script" ]; do
  terminal_electron_directory=$(CDPATH= cd -- "$(dirname -- "$terminal_electron_script")" && pwd)
  terminal_electron_script=$(readlink "$terminal_electron_script")
  case "$terminal_electron_script" in /*) ;; *) terminal_electron_script="$terminal_electron_directory/$terminal_electron_script" ;; esac
done
terminal_electron_directory=$(CDPATH= cd -- "$(dirname -- "$terminal_electron_script")" && pwd)
exec "$terminal_electron_directory/runtime/bin/node" "$terminal_electron_directory/app/src/cli.mjs" "$@"
