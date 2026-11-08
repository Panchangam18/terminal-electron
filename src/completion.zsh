#compdef terminal-electron
_terminal_electron() {
  local context state state_descr line
  local -a entries descriptions
  local needle=${(L)words[CURRENT]}
  local app_name app_path
  _arguments -C \
    '--help[Show help]' \
    '--version[Show version]' \
    '--list[List discovered Electron apps]' \
    '--profile[Persistent private profile]:directory:_files -/' \
    '--import-profile[Import desktop browser session]:directory:_files -/' \
    '*--app-dir[Include another app folder]:directory:_files -/' \
    '--electron[Electron executable for a source app]:file:_files' \
    '--fps[Maximum frame rate]:fps:(15 30 60)' \
    '1:Electron app:->applications' \
    '*::app argument:_files'
  if [[ $state == applications ]]; then
    while IFS=$'\t' read -r app_name app_path; do
      if [[ "${(L)app_name} ${(L)app_path}" == *"$needle"* ]]; then
        entries+=("$app_path")
        descriptions+=("$app_name — $app_path")
      fi
    done < <(terminal-electron --list 2>/dev/null)
    if (( ${#entries} )); then
      compadd -U -d descriptions -a entries && return 0
    fi
    _files -g '*.app(-/)'
  fi
}
if [[ ${funcstack[1]} == _terminal-electron ]]; then
  _terminal_electron "$@"
else
  if (( ! $+functions[compdef] )); then
    autoload -Uz compinit
    compinit -D
  fi
  compdef _terminal_electron terminal-electron
fi
