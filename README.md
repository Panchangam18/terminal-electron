# terminal-electron

Run a local Electron app inside Ghostty or Kitty, with its original desktop runtime, backend, preloads, native modules, and IPC.

```sh
npm ci
./terminal-electron "/Applications/Slack.app"
```

Requires **macOS**, **Node.js 22.12+**, and a terminal with Kitty graphics support. Tested on Apple Silicon. Pixel 0.0.20 supplies the compositor, terminal protocol, and input handling. Apps are not bundled with this repository.

## Keep a session

```sh
./terminal-electron "/Applications/Slack.app" --profile ./profiles/slack
```

Use an empty directory for the first launch. The launcher prepares a cached, privately signed copy of the app and uses a separate credential identity. The original app and desktop profile are preserved. Profiles are pinned to their prepared runtime; an app update requires a new profile.

To reuse desktop authentication:

```sh
./terminal-electron "/Applications/Slack.app" \
  --profile ./profiles/slack-desktop \
  --import-profile "$HOME/Library/Application Support/Slack"
```

Import snapshots the desktop profile, uses the unchanged signed app to export its browser cookies, then imports them into the private profile. Saved passwords are excluded. This supports Chromium cookie/profile authentication; custom credential stores and partitioned cookies are not covered. [Authentication details](docs/architecture.md#authentication).

Convenience launchers:

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

Terminal shortcuts can intercept keys before they reach the app. Logs and profile paths are printed at startup. Run `./terminal-electron --help` for options, including `--fps` and arguments forwarded after `--`.

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
npm run setup        # install dependencies and development Electron for fixtures
npm test             # 9 integration/framing tests
npm run test:pty      # full CLI, terminal input, graphics, backend file save
npm run test:pty-hidpi
npm run test:dialogs
npm run format:check
npm run demo
```

Dependency install scripts are disabled in `.npmrc`: packaged apps supply their own Electron. `npm run setup` explicitly installs the fixture runtime. Python 3 is required for PTY tests and profile import.

Signed-in Slack works in live Ghostty, as confirmed by the user. Automated tests also cover repeated authenticated launches and read-only navigation/search. Obsidian, VS Code, Screen Studio, and Composite have scoped passing checks. [Coverage, commands, and limits](docs/testing.md).

Profiles, prepared app copies, local screenshots/logs, and test evidence are excluded from Git. Keep these local directories private. Slack tests do not compose or submit messages.

## Current limits

This is a compatibility prototype, not universal Electron support. Native menus/tray, drag-and-drop, security/TCC dialogs, OS-level protocol invocation, and BaseWindow/WebContentsView need more work or verification. The adapter hosts basic open/save/message dialogs, not every platform option. Features tied to the vendor's original signing identity may fail in the private copy.

The bridge copies full BGRA frames at up to 15 fps by default. Shared-memory/GPU transport, performance benchmarks, and other operating systems are not implemented or verified.
