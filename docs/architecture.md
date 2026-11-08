# Architecture

## Execution and platform boundary

The app runs locally using its bundled Electron runtime, original main process, preloads, renderers, IPC, native modules, and helper programs. The adapter redirects presentation and input through shared Electron APIs. macOS native code continues to execute on macOS; Windows executables are not translated or emulated.

Native AppKit/SwiftUI apps are outside this adapter's scope. A separate backend could reuse Pixel for presentation, but would need macOS window capture and input delivery rather than Electron APIs.

The packaged-app launcher currently depends on macOS bundle metadata, signing tools, and filesystem behavior. A Windows/Linux implementation needs platform-specific preparation, IPC/terminal integration, credentials, and testing. Extracting an ASAR and swapping Electron does not ensure portability when native libraries, helper binaries, or OS assumptions differ.

## Bundle preparation

`src/prepare.mjs` makes a cached private bundle, adds an entry shim before the original main module, and ad-hoc signs the copy. The source bundle is unchanged. The cache key includes source signature/resources, archive contents, host path, and preparation version. The profile records and validates its exact runtime identity before launch.

Archive preparation rewrites the ASAR header and appends only the shim and amended package metadata. The original packed payload, file integrity records, links, and unpacked executables stay intact; the launcher does not extract and repackage every file. Nested helper bundles are signed inside out, including helpers inside versioned frameworks. The private copy's archive integrity check, team-scoped entitlements, and explicit library-validation restriction are adjusted to permit the shim and existing native modules. Download quarantine is removed only from the verified private artifact. Integrations tied to the vendor signing identity can fail. A source app update requires a new profile, preserving the old one.

CommonJS and named ES-module Electron imports pass through the same adapter. Source directories can also run with `--electron PATH`; the default development runtime is installed by `npm run setup`. Direct executable targets have a limited inspector injection path.

## Windows, frames, and input

The adapter creates hidden BrowserWindows and provides logical visibility, focus, and window selection. Standard Electron builds supply offscreen paint events. Builds without offscreen APIs use CDP page screenshots, with hidden `capturePage` as a fallback when CDP capture is unavailable. Capture is serialized and limited to the selected window at the requested frame rate; unchanged frames are skipped. Native min/max constraints do not prevent terminal viewport resizing; the logical API values remain available to the app.

Electron paint events supply BGRA bitmaps and damage metadata over a private Unix socket. Headers are JSON; bitmap payloads are binary. The decoder supports arbitrary fragmentation and UTF-8. Physical raster dimensions are separate from CSS input coordinates, including actual 2x rendering.

Pixel's native engine and surface handle capability negotiation, compositing, terminal graphics, input parsing, and cleanup. Pixel's PageInput executes inside the target app's Electron process. Input operations are serialized so asynchronous paste or editing-key work cannot be overtaken. Clipboard staging waits for the renderer paste event before restoring the prior clipboard; unsupported legacy clipboard formats use plain-text insertion.

Native offscreen popups that finish loading with a zero-sized viewport receive a capability-based CDP capture fallback, preserving the original guest and opener. No app-specific selectors are used.

Each app starts in a separate process group. Shutdown cleans up that group's remaining native helpers and closes inherited output streams. Other desktop instances belong to separate groups.

## Terminal dialogs and sign-in callbacks

Open/save/message APIs use a shared Pixel overlay. Async calls wait on a private dialog socket. Sync calls use a small Node IPC client while Electron's main process blocks; the separate terminal frontend stays responsive. The selected paths or responses return to the original app backend. Security/Keychain/TCC dialogs are not replaced.

HTTPS links open in a sandboxed terminal-hosted browser with Node integration disabled. Callback schemes are read from bundle metadata and routed to the app's `open-url` handler. The callback closes the browser popup group and returns to the original app window without changing system protocol defaults. The nested-popup callback fixture passes; a repeat real Slack OAuth flow after the popup cleanup fix has not been verified.

## Authentication

Prepared apps use a stable, private `Terminal Electron … Safe Storage` credential identity. They do not request the vendor's original Safe Storage item. No mock Keychain, plaintext cookie fallback, credential ACL change, or raw Keychain secret extraction is used. Nonempty unmanaged profiles and mismatched runtimes are rejected before credential access.

`--import-profile SOURCE --profile NEW_DESTINATION`:

1. Clone the desktop profile into a private snapshot, using SQLite backup for cookie databases to account for active WAL files. Remove instance locks, symlinks, and saved-password databases from the snapshot.
2. Launch the unchanged signed original app at its original path against that snapshot, with a loopback debugging endpoint.
3. Export browser cookies through that owned app instance, then close it. The existing desktop instance and original profile are preserved.
4. Copy the snapshot into the new managed destination, remove the vendor-encrypted cookie stores, and import cookies under the private identity before the app's ready handlers execute.
5. Flush the cookie store and delete the transient cookie file. Cookie values are never printed.

This supports Chromium cookie/profile authentication. It does not migrate arbitrary native credential stores, saved passwords, or partitioned cookies. Applications may still require sign-in when their authentication depends on other platform-specific mechanisms.

The original app must be able to read its existing credential store. Import is explicit and is never retried automatically. If cookie access times out, cleanup first requests normal termination and then kills only processes using the unique snapshot profile if necessary. The source desktop instance and other app sessions are preserved. Startup progress is shown in the CLI, and a private log exists even when preparation or import fails.

## Runtime policy

Use Electron APIs, runtime capabilities, bundle metadata, and platform rules. Do not add app-name/bundle-ID branches, app DOM selectors, or bespoke app adapters to `src/`. Application-specific UI tests and convenience scripts belong outside the runtime. Keep compatibility claims limited to actual checks.

Pixel's low-level native/surface/input APIs are pinned to 0.0.20; upgrading requires integration validation. Cross-process shared textures and shared-memory frame transport are not implemented; accepted paint events still copy a full bitmap.
