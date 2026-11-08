# terminal-electron

Run a local Electron app inside Ghostty or Kitty, with its original desktop runtime, backend, preloads, native modules, and IPC.

```sh
curl -fsSL https://github.com/Panchangam18/terminal-electron/releases/latest/download/get.sh | bash
terminal-electron
```

The installer verifies the release checksum, bundles Node and production dependencies under `~/.local/lib/terminal-electron`, and places a launcher in `~/.local/bin`. It needs no Git, npm, separate Node install, compiler, or administrator rights. Add `~/.local/bin` to PATH if your shell does not already include it; the installer does not edit shell configuration. A custom prefix is supported with `| bash -s -- --prefix /absolute/path`.

Run **`terminal-electron`** to search and choose from the Electron apps on your computer, or launch one directly:

```sh
terminal-electron "/Applications/Slack.app"
```

The selector reads application metadata and recognizes standard or renamed Electron frameworks. It checks standard Applications folders, the current directory, and Spotlight's app index, without launching apps during discovery. Suggestions appear inline beneath the command, using ordinary terminal text. Type to filter, use Tab/Shift+Tab or Up/Down, then Enter to launch; Escape cancels. Scrollback stays visible. `terminal-electron --list` lists paths without opening the picker, and `--app-dir PATH` includes an additional folder.

The prebuilt release requires **Apple Silicon macOS 14+** and Ghostty or Kitty with Kitty graphics support. Apps are not bundled. Pixel 0.0.20 supplies the compositor, terminal protocol, and input handling. Optional desktop-auth import currently requires Python 3.

For actual zsh completion after typing `terminal-electron ` and pressing Tab, enable it in your shell:

```sh
source <(terminal-electron --completion zsh)
```

The installer also provides `~/.local/share/zsh/site-functions/_terminal-electron`. Shell startup files are not edited automatically.

## Keep a session

```sh
terminal-electron "/Applications/Slack.app" --profile ./profiles/slack
```

Use an empty directory for the first launch. The launcher prepares a cached, privately signed copy of the app and uses a separate credential identity. The original app and desktop profile are preserved. Profiles are pinned to their prepared runtime; an app update requires a new profile.

To reuse desktop authentication:

```sh
terminal-electron "/Applications/Slack.app" \
  --profile ./profiles/slack-desktop \
  --import-profile "$HOME/Library/Application Support/Slack"
```

Import snapshots the desktop profile, uses the unchanged signed app to export its browser cookies, then imports them into the private profile. Saved passwords are excluded. This supports Chromium cookie/profile authentication; custom credential stores and partitioned cookies are not covered. The source app still needs access to its existing credential store. If cookie access times out, the temporary helper is stopped and the import fails without changing the desktop profile; start a private session without `--import-profile` and sign in there. [Authentication details](docs/architecture.md#authentication).

The source checkout also includes optional Slack test launchers (these are not part of the installed command):

```sh
./run-slack           # separate private profile
./run-slack-desktop   # import desktop sign-in once, then reuse the private profile
```

Set `TERMINAL_ELECTRON_SLACK_APP` for a custom Slack bundle path, `TERMINAL_ELECTRON_SLACK_PROFILE` for the destination profile, or `TERMINAL_ELECTRON_SLACK_DESKTOP_PROFILE` for an import source.

## Controls

| Input                                   | Action                                   |
| --------------------------------------- | ---------------------------------------- |
| Ctrl+Q                                  | Cancel terminal dialogs and quit the app |
| Ctrl+Tab                                | Switch app windows                       |
| Ctrl+Shift+W                            | Close the selected window                |
| Mouse, wheel, keyboard, bracketed paste | Forward to Electron                      |
| Ctrl+L / Escape in a file dialog        | Edit the path / cancel                   |

Terminal shortcuts can intercept keys before they reach the app. Logs and profile paths are printed at startup. Run `terminal-electron --help` for options, including `--fps` and arguments forwarded after `--`.

## How it works

```text
TTY <-> Pixel native engine <-> binary bitmap/input bridge
    <-> generic Electron adapter + Pixel PageInput <-> original app
```

The adapter redirects Electron windows into offscreen rendering and hosts basic file/message dialogs in Pixel. The app's native platform layer still runs on macOS. This does not execute Windows binaries on a Mac; Windows/Linux hosting would require platform ports and testing.

The runtime uses shared Electron APIs, capabilities, and bundle metadata. **No app-name/bundle-ID branches or app-specific DOM handling are permitted in `src/`.** App-specific launchers and UI tests live outside the runtime. Pixel is used directly; terminal-browser is not a dependency.

See [architecture](docs/architecture.md) for signing, input, window, and authentication mechanisms.

## Development and verification

```sh
git clone https://github.com/Panchangam18/terminal-electron.git
cd terminal-electron
npm ci
npm run setup        # install dependencies and development Electron for fixtures
npm test             # 13 integration/framing/discovery tests
npm run test:pty      # full CLI, terminal input, graphics, backend file save
npm run test:pty-hidpi
npm run test:dialogs
npm run test:picker
npm run format:check
npm run demo
```

Source development requires Node.js 22.12+ and Python 3 for PTY tests/import. Use `./terminal-electron` when running directly from the checkout.

Dependency install scripts are disabled in `.npmrc`: packaged apps supply their own Electron. `npm run setup` explicitly installs the fixture runtime. Python 3 is required for PTY tests and profile import.

Signed-in Slack works in live Ghostty, as confirmed by the user. Automated tests also cover repeated authenticated launches and read-only navigation/search. Obsidian, VS Code, Screen Studio, and Composite have scoped passing checks. [Coverage, commands, and limits](docs/testing.md).

Profiles, prepared app copies, local screenshots/logs, and test evidence are excluded from Git. Keep these local directories private. Slack tests do not compose or submit messages.

## Current limits

This is a compatibility prototype, not universal Electron support. Native menus/tray, drag-and-drop, security/TCC dialogs, OS-level protocol invocation, and BaseWindow/WebContentsView need more work or verification. The adapter hosts basic open/save/message dialogs, not every platform option. Features tied to the vendor's original signing identity may fail in the private copy.

The bridge copies full BGRA frames at up to 15 fps by default. Shared-memory/GPU transport, performance benchmarks, and other operating systems are not implemented or verified.
