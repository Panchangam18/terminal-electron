# Testing and verified scope

## Prerequisites

Use Apple Silicon macOS, Node.js 22.12+, Python 3, and Ghostty or Kitty. Run `npm run setup` to install the development Electron runtime for fixtures. Tests use the real system clipboard temporarily; run clipboard-writing suites sequentially.

```sh
npm test
npm run test:pty
npm run test:pty-hidpi
npm run test:dialogs
npm run test:picker
npm run format:check
```

The core tests cover binary/Unicode framing, invalid bitmap lengths, unmanaged-profile refusal, input/IPC/filesystem behavior, hidden utility windows, named ESM imports, packaged ASAR/signing/native helpers, sync/async dialogs, encrypted desktop-auth import, and bounded cleanup of an unresponsive import helper while preserving unrelated instances. Regressions also cover prelaunch refusal without offscreen APIs and immediate rejection if live offscreen verification fails, deeply nested helper signing, archive payload/integrity preservation, and native-helper process-group cleanup. The ordinary input test delays native paste to detect premature clipboard restoration and out-of-order Enter. Core tests run sequentially to avoid concurrent signed fixture launches.

PTY tests start the production CLI, reconstruct Pixel graphics packets, send real terminal input, verify files saved by the original app backend, and check clean shutdown. The high-DPI test requires actual 2000x1400 source bitmaps displayed at 1000x700. The dialog PTY test selects a Unicode folder through the shared synchronous picker.

## Installed-app tests

Install the app in `/Applications`, or set a custom path before the relevant test:

```sh
export TERMINAL_ELECTRON_SLACK_APP="/path/to/Slack.app"
export TERMINAL_ELECTRON_OBSIDIAN_APP="/path/to/Obsidian.app"
export TERMINAL_ELECTRON_VISUAL_STUDIO_CODE_APP="/path/to/Visual Studio Code.app"
export TERMINAL_ELECTRON_SCREEN_STUDIO_APP="/path/to/Screen Studio.app"
export TERMINAL_ELECTRON_COMPOSITE_APP="/path/to/Composite.app"
```

The test tools also recognize a sibling app bundle for local development. This discovery is outside the runtime adapter. Source apps and dependencies contain no app-specific compatibility logic.

```sh
npm run test:slack                 # isolated sign-in screen; no authentication started
npm run test:slack-pty             # isolated profile in production CLI
npm run test:slack-readonly -- profiles/slack-desktop
npm run test:slack-reliability -- profiles/slack-desktop
npm run test:slack-pty -- profiles/slack-desktop
npm run test:obsidian
npm run test:vscode-deep
npm run test:screenstudio
npm run test:composite
npm run test:runtime-startup -- "/path/to/Eligible.app"
python3 test/runtime_pty.py "/path/to/Eligible.app"
```

Create the signed-in Slack profile with `./run-slack-desktop` first. Close the terminal-hosted instance before running tests against its profile. Slack tests only navigate/search; they never compose or submit messages. Search input requires a positive focus check that excludes the message composer. Recording is not started in Screen Studio.

## Observed coverage

| App                      | Bundled Electron | Passing scope                                                                                                                                                                                            | Not covered                                                                                                             |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Slack 4.53.280           | 45.2.1           | Desktop auth import; five consecutive restarts for each of two signed-in profiles; DMs/Home/Files, global search, history, quick switcher, channel details, resize, hidden windows, quit; production CLI | Messages/replies/reactions/uploads/huddles intentionally excluded; repeat real OAuth round trip after popup cleanup fix |
| Obsidian 1.15.0          | 43.8.4           | Real shared synchronous terminal directory picker; vault creation, Unicode Markdown save, undo/redo, palette, resize, quit                                                                               | Sync, plugins, publishing                                                                                               |
| VS Code 1.137.0          | 42.10.0          | Repeated editor/save/undo/redo; integrated shell writes a proof file; resize, quit                                                                                                                       | Extensions                                                                                                              |
| Screen Studio 3.7.5-4595 | 39.2.7           | Controls, unpacked native helper permissions, Window/Display pickers, window switching, utility resize, quit                                                                                             | Recording, camera, microphone, export                                                                                   |
| Composite 1.0.3          | 37.4.0           | Startup, loaded UI, hidden offscreen window, quit                                                                                                                                                        | Deeper workflows                                                                                                        |

ChatGPT/Codex is currently unsupported. The v0.2.2 page-capture rendering results are superseded by a user report of screen takeover and repeated Screen Recording/Accessibility prompts requiring a reboot. v0.2.3 removes that backend and rejects runtimes missing native offscreen APIs before executing target code. No installed third-party app was relaunched to investigate this incident. The exact native requester was not recovered from retained logs.

Containment fixtures use mocked permission APIs and sentinel files to prove that missing Screen Recording/Accessibility requests, System Settings handoffs, native relaunch and BaseWindow construction stop before their native APIs are called. Static checks cover bundle paths, direct executable paths, source-runtime overrides, discovery and profile import. Default logs persist outside temporary session folders. These tests establish these boundaries; they do not establish an OS sandbox around arbitrary native helpers.

The user confirmed signed-in Slack works in live Ghostty. Automated terminal checks use PTYs and decoded graphics; other live terminal/app combinations have not been established.

A newcomer check anonymously cloned the public repository into a path containing spaces, downloaded and checksum-verified Node 22.12.0, installed with an empty npm cache, and launched Slack through the production terminal CLI without downloading development Electron. Plain launch, resize, clean shutdown, and restart passed. A production-only install with no Node Electron package also passed. Developer setup, all thirteen core tests, standard/2x CLI tests, and the synchronous terminal picker passed from that checkout. Desktop-auth import had previously passed, but a later fresh-profile run timed out reading the desktop cookies. Import remains optional and dependent on source credential access; the failure cleanup is regression tested. This check uses the same Mac, not a separate clean machine or a newly controlled Ghostty session.

These results are scoped observations, not universal compatibility guarantees. Native menus/tray, drag-and-drop, security/TCC prompts, OS protocol invocation, BaseWindow/WebContentsView, and other operating systems need further support or verification.

## Local artifacts

Tests write JSON results, screenshots, and transcripts to `proof/`. CLI sessions print their retained log and profile paths. These can contain account information and are intentionally excluded from Git, alongside `profiles/`, app bundles, credentials, and caches. The repository contains source, fixtures, and the coverage summary rather than personal session data.

## Prebuilt install and app picker

The selector uses inline terminal suggestions, with Tab/Shift+Tab and arrow navigation, rather than an alternate screen or graphics canvas. Native zsh completion is available with `terminal-electron --completion zsh`. Renamed Electron frameworks are recognized by their fuse data; display names and bundle identifiers do not control compatibility.

The release installer follows terminal-mac's layout: a checksum-verified release ZIP, an immutable versioned runtime under `~/.local/lib/terminal-electron`, and one launcher in `~/.local/bin`. Updates retain old versions so an existing prepared runtime and credential identity are not silently replaced. The payload includes Node and production dependencies, but no desktop apps, user profiles, or account data. Shell configuration is not edited.

`npm run test:picker` creates a packaged Electron fixture and uses the production CLI on a real PTY. It searches the app picker, launches only that fixture, waits for original app frames, quits, and checks cancellation without starting an app. `TERMINAL_ELECTRON_TEST_COMMAND` selects an installed launcher; `TERMINAL_ELECTRON_TEST_PATH` can restrict the child PATH to system tools to verify that no global Node is needed. Discovery tests cover nested apps, aliases, cycles, native-app exclusion, and prepared-copy exclusion.

Maintainers build release assets with `npm run build:release`. This downloads a pinned Node distribution from nodejs.org, verifies its upstream checksum, installs production dependencies from the lockfile, and packages only the distribution payload. The generated `dist/get.sh` pins the release archive's SHA-256. Test the extracted `install.sh` with a temporary `--prefix` before publishing. The installer refuses to replace an unrelated executable and validates its payload on repeated installation.

During v0.2.3 investigation, the clipboard-paste fixture failed after reboot on both the unchanged v0.2.2 adapter and the updated adapter; neither produced a paste event. This remains unresolved and is not counted as a passing regression. No clipboard or privacy permissions were changed to make it pass. The new containment fixture verifies keyboard typing, resize and clean shutdown without clipboard access.
