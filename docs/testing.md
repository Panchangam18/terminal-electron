# Testing and verified scope

## Prerequisites

Use Apple Silicon macOS, Node.js 22.12+, Python 3, and Ghostty or Kitty. Run `npm run setup` to install the development Electron runtime for fixtures. Tests use the real system clipboard temporarily; run clipboard-writing suites sequentially.

```sh
npm test
npm run test:pty
npm run test:pty-hidpi
npm run test:dialogs
npm run format:check
```

The ten core tests cover binary/Unicode framing, invalid bitmap lengths, unmanaged-profile refusal, input/IPC/filesystem behavior, hidden utility windows, named ESM imports, packaged ASAR/signing/native helpers, sync/async dialogs, encrypted desktop-auth import, and bounded cleanup of an unresponsive import helper while preserving unrelated instances. The ordinary input test delays native paste to detect premature clipboard restoration and out-of-order Enter.

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

The user confirmed signed-in Slack works in live Ghostty. Automated terminal checks use PTYs and decoded graphics; other live terminal/app combinations have not been established.

A newcomer check anonymously cloned the public repository into a path containing spaces, downloaded and checksum-verified Node 22.12.0, installed with an empty npm cache, and launched Slack through the production terminal CLI without downloading development Electron. Plain launch, resize, clean shutdown, and restart passed. A production-only install with no Node Electron package also passed. Developer setup, all ten core tests, standard/2x CLI tests, and the synchronous terminal picker passed from that checkout. Desktop-auth import had previously passed, but a later fresh-profile run timed out reading the desktop cookies. Import remains optional and dependent on source credential access; the failure cleanup is regression tested. This check uses the same Mac, not a separate clean machine or a newly controlled Ghostty session.

These results are scoped observations, not universal compatibility guarantees. Native menus/tray, drag-and-drop, security/TCC prompts, OS protocol invocation, BaseWindow/WebContentsView, and other operating systems need further support or verification.

## Local artifacts

Tests write JSON results, screenshots, and transcripts to `proof/`. CLI sessions print their retained log and profile paths. These can contain account information and are intentionally excluded from Git, alongside `profiles/`, app bundles, credentials, and caches. The repository contains source, fixtures, and the coverage summary rather than personal session data.
