module.exports = function (config) {
  try {
    return install(config);
  } catch (error) {
    console.error(error.stack ?? error);
    require('electron').app.exit(1);
  }
};

function install(config) {
  if (globalThis.__terminalElectron) throw new Error('Terminal adapter already installed');
  const Module = require('node:module');
  const net = require('node:net');
  const { StringDecoder } = require('node:string_decoder');
  const electron = require('electron');
  const { app } = electron;
  if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') {
    // Keep native offscreen view focus working; target code cannot promote the
    // application to a regular desktop app. The dock is hidden after ready.
    app.setActivationPolicy = () => {};
  }
  const setPath = app.setPath.bind(app);
  const profilePath = require('node:fs').realpathSync(config.profile);
  app.setPath = (name, value) => setPath(name, name === 'userData' ? profilePath : value);
  app.setPath('userData', profilePath);
  const setName = app.setName.bind(app);
  const getName = app.getName.bind(app);
  let logicalName = getName();
  if (!config.credentialName?.startsWith('Terminal Electron '))
    throw new Error('Missing private credential namespace.');
  setName(config.credentialName);
  app.setName = (name) => {
    logicalName = name;
    setName(config.credentialName);
  };
  app.getName = () => logicalName;
  const appFunctions = new Map();
  const application = new Proxy(app, {
    get(target, key) {
      if (key === 'name') return logicalName;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || key === 'constructor') return value;
      if (appFunctions.get(key)?.source !== value)
        appFunctions.set(key, { source: value, bound: value.bind(target) });
      return appFunctions.get(key).bound;
    },
    set(target, key, value) {
      if (key === 'name') {
        app.setName(value);
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
  });
  if (config.importCookies) {
    const fs = require('node:fs');
    const nativeReady = app.whenReady.bind(app),
      nativeIsReady = app.isReady.bind(app),
      emit = app.emit.bind(app);
    let imported = false;
    const ready = nativeReady()
      .then(async () => {
        const cookies = JSON.parse(fs.readFileSync(config.importCookies, 'utf8'));
        fs.rmSync(config.importCookies, { force: true });
        let count = 0,
          partitioned = 0;
        for (const cookie of cookies) {
          if (cookie.partitionKey) {
            partitioned++;
            continue;
          }
          const details = {
            url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite:
              { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[cookie.sameSite] ??
              'unspecified',
          };
          if (cookie.expires > 0) details.expirationDate = cookie.expires;
          await electron.session.defaultSession.cookies.set(details);
          count++;
        }
        await electron.session.defaultSession.cookies.flushStore();
        imported = true;
        send({ type: 'profile-imported', cookies: count, partitionedSkipped: partitioned });
      })
      .catch(() => {
        send({ type: 'error', message: 'Private profile cookie import failed.' });
        app.exit(1);
      });
    app.whenReady = () => ready;
    app.isReady = () => nativeIsReady() && imported;
    app.emit = (event, ...args) => {
      if (event === 'ready' && !imported) {
        ready.then(() => emit(event, ...args));
        return true;
      }
      return emit(event, ...args);
    };
  }
  const windows = new Map();
  const nativeVisibility = new Map();
  const nativeOffscreen = new Map();
  const visibility = new Map();
  const inputs = new Map();
  const focusStates = new Map();
  const hostBrowsers = new Map();
  const windowCaptures = new Map();
  const protocols = new Set(
    config.protocolSchemes
      .map((scheme) => scheme.toLowerCase())
      .filter(
        (scheme) =>
          /^[a-z][a-z0-9+.-]*$/.test(scheme) &&
          !['http', 'https', 'file', 'data', 'javascript'].includes(scheme),
      ),
  );
  const validProtocol = (scheme) =>
    typeof scheme === 'string' &&
    /^[a-z][a-z0-9+.-]*$/i.test(scheme) &&
    !['http', 'https', 'file', 'data', 'javascript'].includes(scheme.toLowerCase());
  app.setAsDefaultProtocolClient = (scheme) => {
    if (!validProtocol(scheme)) return false;
    protocols.add(scheme.toLowerCase());
    return true;
  };
  app.isDefaultProtocolClient = (scheme) =>
    validProtocol(scheme) && protocols.has(scheme.toLowerCase());
  app.removeAsDefaultProtocolClient = (scheme) =>
    validProtocol(scheme) && protocols.delete(scheme.toLowerCase());
  let selected = null;
  let focusedWindow = null;
  let terminalFocused = true;
  let viewport = { width: config.width, height: config.height };
  let sequence = 0;
  let wholeSurface = true;
  let inputBuffer = '';
  const inputDecoder = new StringDecoder('utf8');
  const socket = net.connect(config.socket);
  const send = (value) => {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
  };
  function failClosed(message) {
    require('node:fs').writeSync(2, `terminal-electron: ${message}\n`);
    send({ type: 'error', message });
    app.exit(1);
    throw new Error(message);
  }
  function requireOffscreenWindow(win) {
    if (typeof win.webContents.isOffscreen === 'function' && win.webContents.isOffscreen())
      return true;
    win.hide();
    failClosed(
      'Unsupported runtime: native offscreen rendering is required. Ordinary-window capture is disabled.',
    );
    return false;
  }
  const report = () =>
    send({
      type: 'windows',
      selected: selected?.id,
      windows: [...windows.values()].map((w) => ({
        id: w.id,
        title: w.getTitle(),
        logicalVisible: visibility.get(w.id),
        offscreen: nativeOffscreen.get(w.id)(),
        captureMode: 'paint',
        nativeVisible: nativeVisibility.get(w.id)(),
      })),
    });

  function updateFocus() {
    const next = terminalFocused && selected && visibility.get(selected.id) ? selected : null;
    if (focusedWindow === next) return;
    const previous = focusedWindow;
    focusedWindow = next;
    const event = { preventDefault() {} };
    if (previous && !previous.isDestroyed()) {
      previous.emit('blur');
      app.emit('browser-window-blur', event, previous);
    }
    if (focusedWindow === next && next && !next.isDestroyed()) {
      next.emit('focus');
      if (focusedWindow === next) app.emit('browser-window-focus', event, next);
    }
  }

  function deliverURL(url, source) {
    let protocol;
    try {
      protocol = new URL(url).protocol.slice(0, -1).toLowerCase();
    } catch {
      return false;
    }
    if (!protocols.has(protocol)) return false;
    const browser = hostBrowsers.get(source?.id);
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    app.emit('open-url', event, url);
    if (browser)
      setImmediate(() => {
        const opener =
          browser.opener && !browser.opener.isDestroyed()
            ? browser.opener
            : [...windows.values()].findLast(
                (window) => !hostBrowsers.has(window.id) && visibility.get(window.id),
              );
        if (opener) select(opener);
        for (const [id, entry] of hostBrowsers)
          if (entry.group === browser.group) {
            const window = windows.get(id);
            if (window && !window.isDestroyed()) window.close();
          }
      });
    return true;
  }

  function publishFrame(win, dirty, image) {
    if (selected !== win || socket.destroyed || image.isEmpty()) return;
    if (socket.writableLength > 16 * 1024 * 1024) {
      wholeSurface = true;
      return;
    }
    const size = image.getSize();
    const [inputWidth, inputHeight] = windowCaptures.get(win.id)?.fallback
      ? [viewport.width, viewport.height]
      : win.getContentSize();
    if (config.frameFormat === 'bgra') {
      const bitmap = image.toBitmap();
      const scale = Math.sqrt(bitmap.length / (size.width * size.height * 4));
      const width = Math.round(size.width * scale),
        height = Math.round(size.height * scale);
      send({
        type: 'frame',
        format: 'bgra',
        id: win.id,
        seq: ++sequence,
        width,
        height,
        inputWidth,
        inputHeight,
        byteLength: bitmap.length,
        ...(!wholeSurface && dirty ? { damage: dirty } : {}),
      });
      socket.write(bitmap);
      wholeSurface = false;
    } else {
      const png = image.toPNG();
      send({
        type: 'frame',
        id: win.id,
        seq: ++sequence,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        inputWidth,
        inputHeight,
        png: png.toString('base64'),
      });
    }
  }

  function watchCapture(win) {
    if (windowCaptures.has(win.id)) return;
    const state = {
      nativePaint: false,
      busy: false,
      fallback: false,
      metrics: null,
      lastShot: null,
    };
    windowCaptures.set(win.id, state);
    state.timer = setInterval(
      async () => {
        if (
          state.busy ||
          state.nativePaint ||
          selected !== win ||
          win.isDestroyed() ||
          win.webContents.isLoadingMainFrame()
        )
          return;
        state.busy = true;
        try {
          if (!state.fallback) {
            const layout = await cdp(win, 'Page.getLayoutMetrics');
            state.metricsNeeded =
              (layout.cssLayoutViewport ?? layout.layoutViewport).clientWidth === 0;
            if (!state.metricsNeeded) return;
            state.fallback = true;
            send({
              type: 'diagnostic',
              id: win.id,
              event: 'popup-capture-fallback',
            });
          }
          const metrics = `${viewport.width}x${viewport.height}`;
          if (state.metricsNeeded && state.metrics !== metrics) {
            await cdp(win, 'Emulation.setDeviceMetricsOverride', {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: 1,
              mobile: false,
            });
            state.metrics = metrics;
          }
          const shot = await cdp(win, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
          });
          if (shot.data === state.lastShot && !wholeSurface) return;
          state.lastShot = shot.data;
          wholeSurface = true;
          publishFrame(
            win,
            null,
            electron.nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')),
          );
        } catch (error) {
          if (!win.isDestroyed() && !state.reported) {
            state.reported = true;
            send({
              type: 'diagnostic',
              id: win.id,
              event: 'popup-capture-failed',
              message: error.message,
            });
          }
        } finally {
          state.busy = false;
        }
      },
      Math.max(200, 1000 / config.fps),
    );
  }

  function select(win) {
    if (!win || win.isDestroyed()) return;
    if (selected && selected !== win) {
      inputs.get(selected.id)?.releaseKeys();
      inputs.get(selected.id)?.releaseModifiers();
      cdp(selected, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      focusStates.delete(selected.id);
    }
    selected = win;
    wholeSurface = true;
    for (const window of windows.values())
      window.webContents.setFrameRate?.(window === win ? config.fps : 1);
    win.setContentSize(viewport.width, viewport.height);
    focusWindow(win);
    win.webContents.invalidate?.();
    updateFocus();
    report();
  }

  function adopt(win, initialVisible = true) {
    if (windows.has(win.id)) return win;
    if (!requireOffscreenWindow(win)) return win;
    windows.set(win.id, win);
    nativeVisibility.set(win.id, win.isVisible.bind(win));
    const offscreen = win.webContents.isOffscreen.bind(win.webContents);
    nativeOffscreen.set(win.id, offscreen);
    let minimumSize = win.getMinimumSize(),
      maximumSize = win.getMaximumSize(),
      resizable = win.isResizable();
    win.setMinimumSize(0, 0);
    win.setMaximumSize(0, 0);
    win.setResizable(true);
    win.setMinimumSize = (width, height) => {
      minimumSize = [width, height];
    };
    win.setMaximumSize = (width, height) => {
      maximumSize = [width, height];
    };
    win.getMinimumSize = () => [...minimumSize];
    win.getMaximumSize = () => [...maximumSize];
    win.setResizable = (value) => {
      resizable = !!value;
    };
    win.isResizable = () => resizable;
    win.webContents.isOffscreen = () => false;
    visibility.set(win.id, initialVisible);
    win.show = () => {
      visibility.set(win.id, true);
      select(win);
      win.emit('show');
    };
    win.showInactive = () => {
      visibility.set(win.id, true);
      if (!selected || !visibility.get(selected.id)) select(win);
      else report();
      win.emit('show');
    };
    win.hide = () => {
      visibility.set(win.id, false);
      if (selected === win) {
        const replacement = [...windows.values()].findLast((w) => visibility.get(w.id));
        if (replacement) select(replacement);
      }
      updateFocus();
      report();
      win.emit('hide');
    };
    win.focus = () => select(win);
    win.isVisible = () => visibility.get(win.id);
    win.isFocused = () => focusedWindow === win;
    let maximized = false;
    let minimized = false;
    let fullscreen = false;
    win.restore = () => {
      visibility.set(win.id, true);
      minimized = false;
      select(win);
      win.emit('restore');
    };
    win.minimize = () => {
      minimized = true;
      win.emit('minimize');
    };
    win.maximize = () => {
      maximized = true;
      select(win);
      win.emit('maximize');
    };
    win.unmaximize = () => {
      maximized = false;
      win.emit('unmaximize');
    };
    win.isMaximized = () => maximized;
    win.isMinimized = () => minimized;
    win.setFullScreen = (value) => {
      fullscreen = !!value;
      win.emit(fullscreen ? 'enter-full-screen' : 'leave-full-screen');
    };
    win.isFullScreen = () => fullscreen;
    let kiosk = false;
    let alwaysOnTop = false;
    win.setKiosk = (value) => {
      kiosk = !!value;
    };
    win.isKiosk = () => kiosk;
    win.setAlwaysOnTop = (value) => {
      alwaysOnTop = !!value;
    };
    win.isAlwaysOnTop = () => alwaysOnTop;
    win.setFocusable = () => {};
    win.moveTop = () => {};
    win.webContents.on('paint', (_event, dirty, image) => {
      if (!image.isEmpty() && windowCaptures.has(win.id))
        windowCaptures.get(win.id).nativePaint = true;
      publishFrame(win, dirty, image);
    });
    win.webContents.on('render-process-gone', (_event, details) =>
      send({
        type: 'diagnostic',
        id: win.id,
        event: 'render-process-gone',
        reason: details.reason,
        exitCode: details.exitCode,
      }),
    );
    win.webContents.on('did-fail-load', (_event, code, description) =>
      send({ type: 'diagnostic', id: win.id, event: 'did-fail-load', code, description }),
    );
    const navigate = (event, details) => {
      const url = typeof details === 'string' ? details : (details?.url ?? event.url);
      let protocol;
      try {
        protocol = new URL(url).protocol.slice(0, -1).toLowerCase();
      } catch {
        return;
      }
      if (protocols.has(protocol)) {
        event.preventDefault();
        deliverURL(url, win);
      }
    };
    win.webContents.on('will-navigate', navigate);
    win.webContents.on('will-frame-navigate', navigate);
    win.webContents.on('will-redirect', navigate);
    win.on('page-title-updated', report);
    win.on('closed', () => {
      windows.delete(win.id);
      nativeVisibility.delete(win.id);
      nativeOffscreen.delete(win.id);
      visibility.delete(win.id);
      inputs.delete(win.id);
      focusStates.delete(win.id);
      hostBrowsers.delete(win.id);
      clearInterval(windowCaptures.get(win.id)?.timer);
      windowCaptures.delete(win.id);
      if (selected === win) selected = null;
      if (focusedWindow === win) focusedWindow = null;
      if (!selected) select([...windows.values()].findLast((w) => visibility.get(w.id)));
      report();
    });
    const setWindowOpenHandler = win.webContents.setWindowOpenHandler.bind(win.webContents);
    const wrapOpenHandler = (handler) => (details) => {
      if (deliverURL(details.url, win)) return { action: 'deny' };
      const decision = handler(details);
      if (decision.action !== 'allow') return decision;
      const options = decision.overrideBrowserWindowOptions ?? {};
      const result = {
        ...decision,
        overrideBrowserWindowOptions: {
          ...options,
          show: false,
          fullscreen: false,
          kiosk: false,
          alwaysOnTop: false,
          skipTaskbar: true,
          paintWhenInitiallyHidden: true,
          webPreferences: {
            ...options.webPreferences,
            offscreen: {
              ...(typeof options.webPreferences?.offscreen === 'object'
                ? options.webPreferences.offscreen
                : {}),
              useSharedTexture: false,
            },
            backgroundThrottling: false,
          },
        },
      };
      if (decision.createWindow)
        result.createWindow = (creation) => {
          const contents = decision.createWindow(creation);
          const child = OriginalWindow.fromWebContents(contents);
          if (child) {
            if (hostBrowsers.has(win.id)) hostBrowsers.set(child.id, hostBrowsers.get(win.id));
            watchCapture(child);
          }
          return contents;
        };
      return result;
    };
    win.webContents.setWindowOpenHandler = (handler) =>
      setWindowOpenHandler(wrapOpenHandler(handler));
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
    win.webContents.on('did-create-window', (child) => {
      if (!windows.has(child.id)) adopt(child);
      if (hostBrowsers.has(win.id)) hostBrowsers.set(child.id, hostBrowsers.get(win.id));
      watchCapture(child);
    });
    if (initialVisible || !selected) select(win);
    else report();
    return win;
  }

  const OriginalWindow = electron.BrowserWindow;
  const Window = new Proxy(OriginalWindow, {
    get(Target, key, receiver) {
      if (key === 'getFocusedWindow') return () => focusedWindow;
      return Reflect.get(Target, key, receiver);
    },
    construct(Target, args, NewTarget) {
      const options = args[0] ?? {};
      const updated = {
        ...options,
        show: false,
        fullscreen: false,
        kiosk: false,
        alwaysOnTop: false,
        skipTaskbar: true,
        paintWhenInitiallyHidden: true,
        width: viewport.width,
        height: viewport.height,
        webPreferences: {
          ...options.webPreferences,
          offscreen: {
            ...(typeof options.webPreferences?.offscreen === 'object'
              ? options.webPreferences.offscreen
              : {}),
            useSharedTexture: false,
          },
          backgroundThrottling: false,
        },
      };
      const win = Reflect.construct(Target, [updated], NewTarget === Window ? Target : NewTarget);
      return adopt(win, options.show !== false);
    },
  });
  const descriptors = Object.getOwnPropertyDescriptors(electron);
  descriptors.app = { value: application, writable: false, enumerable: true, configurable: false };
  descriptors.BrowserWindow = {
    value: Window,
    writable: false,
    enumerable: true,
    configurable: false,
  };
  for (const key of ['BaseWindow', 'WebContentsView', 'BrowserView']) {
    if (typeof electron[key] !== 'function') continue;
    descriptors[key] = {
      value: new Proxy(electron[key], {
        construct() {
          return failClosed(`Native ${key} windows/views are not supported in terminal mode.`);
        },
      }),
      writable: false,
      enumerable: true,
      configurable: false,
    };
  }
  const facade = Object.defineProperties({}, descriptors);
  const dialogCanceled = (kind, options) =>
    kind === 'message'
      ? {
          response:
            options.cancelId ??
            Math.max(
              0,
              (options.buttons ?? []).findIndex((label) =>
                /^(cancel|no)$/i.test(label.replaceAll('&', '')),
              ),
            ),
          checkboxChecked: options.checkboxChecked ?? false,
        }
      : kind === 'save'
        ? { canceled: true }
        : { canceled: true, filePaths: [] };
  function requestDialog(kind, args, synchronous) {
    const options =
      args.find((value) => value && typeof value === 'object' && !value.webContents) ?? {};
    const request = JSON.stringify({
      kind,
      options,
      runtime: {
        pid: process.pid,
        electron: process.versions.electron,
        executable: process.execPath,
      },
    });
    const { execFileSync, spawn } = require('node:child_process');
    if (synchronous) {
      try {
        return JSON.parse(
          execFileSync(config.nodePath, [config.dialogClient, config.dialogSocket], {
            input: request,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
          }),
        );
      } catch {
        return dialogCanceled(kind, options);
      }
    }
    return new Promise((resolve) => {
      const child = spawn(config.nodePath, [config.dialogClient, config.dialogSocket], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
      });
      let result = '';
      child.stdout.on('data', (chunk) => (result += chunk.toString('utf8')));
      child.on('error', () => resolve(dialogCanceled(kind, options)));
      child.stdin.on('error', () => {});
      child.on('close', () => {
        try {
          resolve(JSON.parse(result));
        } catch {
          resolve(dialogCanceled(kind, options));
        }
      });
      child.stdin.end(request);
    });
  }
  electron.dialog.showOpenDialog = (...args) => requestDialog('open', args, false);
  electron.dialog.showOpenDialogSync = (...args) => {
    const result = requestDialog('open', args, true);
    return result.canceled ? undefined : result.filePaths;
  };
  electron.dialog.showSaveDialog = (...args) => requestDialog('save', args, false);
  electron.dialog.showSaveDialogSync = (...args) => {
    const result = requestDialog('save', args, true);
    return result.canceled ? undefined : result.filePath;
  };
  electron.dialog.showMessageBox = (...args) => requestDialog('message', args, false);
  electron.dialog.showMessageBoxSync = (...args) => requestDialog('message', args, true).response;
  electron.dialog.showErrorBox = (title, content) => {
    requestDialog('message', [{ title, message: content, buttons: ['OK'] }], true);
  };
  electron.shell.openExternal = async (url, options) => {
    if (deliverURL(url, selected)) return;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
      return failClosed(
        'An app requested an external native application or System Settings. Desktop handoff is disabled in terminal mode.',
      );
    const opener = selected;
    const browser = new Window({
      title: parsed.hostname,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    hostBrowsers.set(browser.id, { opener, group: browser.id });
    browser.loadURL(url).catch((error) => {
      if (error.code !== 'ERR_ABORTED')
        send({
          type: 'diagnostic',
          id: browser.id,
          event: 'external-page-load-failed',
          code: error.code,
        });
    });
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' || request === 'electron/main') return facade;
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
  for (const key of ['electron', 'electron/main']) {
    const replacement = new Module(key);
    replacement.filename = key;
    replacement.loaded = true;
    replacement.exports = facade;
    require.cache[key] = replacement;
  }
  if (typeof Module.registerHooks === 'function') {
    const virtualModule = 'terminal-electron:electron';
    const exports = Object.keys(facade).filter(
      (key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default',
    );
    const source = `const e=globalThis.__terminalElectron.facade; export default e; ${exports.map((key) => `export const ${key}=e.${key};`).join(' ')}`;
    Module.registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'electron' || specifier === 'electron/main')
          return { url: virtualModule, shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url === virtualModule) return { format: 'module', source, shortCircuit: true };
        return next(url, context);
      },
    });
  }

  const { PageInput } = require(config.pixelInput);
  class OrderedPageInput extends PageInput {
    dispatchEnter(...args) {
      return (this.pending = super.dispatchEnter(...args));
    }
    dispatchEditing(...args) {
      return (this.pending = super.dispatchEditing(...args));
    }
    async drain() {
      await this.focusGate;
      await this.pending;
    }
  }
  function cdp(win, method, params) {
    const debuggerAPI = win.webContents.debugger;
    if (!debuggerAPI.isAttached()) debuggerAPI.attach('1.3');
    return debuggerAPI.sendCommand(method, params);
  }
  function focusWindow(win) {
    win.webContents.focus();
    if (focusStates.has(win.id)) return focusStates.get(win.id);
    const pending = cdp(win, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(
      () => {},
    );
    focusStates.set(win.id, pending);
    pending.then(() => {
      if (focusStates.get(win.id) === pending) focusStates.set(win.id, null);
    });
    return pending;
  }
  let clipboardWork = Promise.resolve();
  let inputWork = Promise.resolve();
  let pasteSequence = 0;
  const queueInput = (operation) => {
    inputWork = inputWork
      .then(operation)
      .catch((error) => send({ type: 'error', message: error.message }));
  };
  async function pasteCompletion(win) {
    const key = `__terminalElectronPaste${++pasteSequence}`;
    const encoded = JSON.stringify(key);
    const frames = (
      await Promise.all(
        win.webContents.mainFrame.framesInSubtree.map(async (frame) => {
          try {
            await frame.executeJavaScript(
              `(()=>{let resolve;const done=new Promise(value=>resolve=value);let timer;const finish=received=>{globalThis.removeEventListener('paste',listener,true);clearTimeout(timer);resolve(received);};const listener=()=>finish(true);globalThis[${encoded}]={done,cleanup:()=>finish(false)};globalThis.addEventListener('paste',listener,{capture:true,once:true});timer=setTimeout(()=>finish(false),2000);return true;})()`,
            );
            return frame;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
    return async () => {
      await Promise.any(
        frames.map((frame) =>
          frame.executeJavaScript(
            `globalThis[${encoded}].done.then(received=>{if(!received)throw new Error('No paste event');return true;})`,
          ),
        ),
      ).catch(() => {});
      await Promise.allSettled(
        frames.map((frame) =>
          frame.executeJavaScript(
            `globalThis[${encoded}]?.cleanup();delete globalThis[${encoded}];true`,
          ),
        ),
      );
    };
  }
  function paste(win, text) {
    if (process.platform !== 'darwin') {
      pixelInput(win).paste(text);
      return pixelInput(win).drain();
    }
    clipboardWork = clipboardWork
      .then(async () => {
        const clipboard = electron.clipboard;
        let restore;
        if (typeof electron.ClipboardItem === 'function' && typeof clipboard.has === 'function') {
          const items = await clipboard.read();
          const saved = await Promise.all(
            items.map(async (item) => {
              const data = {};
              for (const type of item.types) data[type] = await item.getType(type);
              return new electron.ClipboardItem(data);
            }),
          );
          restore = () => (saved.length ? clipboard.write(saved) : clipboard.clear());
        } else {
          const formats = clipboard.availableFormats();
          const supported = new Set([
            'text/plain',
            'text/html',
            'text/rtf',
            'image/png',
            'image/jpeg',
            'image/bmp',
            'image/tiff',
          ]);
          if (formats.some((format) => !supported.has(format))) {
            await cdp(win, 'Input.insertText', { text });
            return;
          }
          const saved = {};
          if (formats.includes('text/plain')) saved.text = clipboard.readText();
          if (formats.includes('text/html')) saved.html = clipboard.readHTML();
          if (formats.includes('text/rtf')) saved.rtf = clipboard.readRTF();
          if (formats.some((format) => format.startsWith('image/')))
            saved.image = clipboard.readImage();
          restore = () => (formats.length ? clipboard.write(saved) : clipboard.clear());
        }
        const pasted = await pasteCompletion(win);
        try {
          await clipboard.writeText(text);
          await pixelInput(win).dispatchPaste();
          await pasted();
        } finally {
          if ((await clipboard.readText()) === text) await restore();
        }
      })
      .catch((error) => send({ type: 'error', message: error.message }));
    return clipboardWork;
  }
  function pixelInput(win) {
    if (!inputs.has(win.id))
      inputs.set(
        win.id,
        new OrderedPageInput({
          contents: () => win.webContents,
          scale: () => 1,
          focus: () => focusWindow(win),
          cdp: (method, params) => cdp(win, method, params),
        }),
      );
    return inputs.get(win.id);
  }

  app.on('browser-window-created', (_, win) => requireOffscreenWindow(win));
  app.show = app.focus = () => {
    if (selected) select(selected);
  };
  app.hide = () => {
    for (const win of windows.values()) win.hide();
  };
  app.relaunch = () =>
    failClosed(
      'Native app relaunch is disabled in terminal mode. Restart through terminal-electron.',
    );
  if (app.dock) {
    app.dock.show = async () => {};
    app.dock.bounce = () => -1;
  }
  const preferences = electron.systemPreferences;
  if (typeof preferences?.isTrustedAccessibilityClient === 'function') {
    const trusted = preferences.isTrustedAccessibilityClient.bind(preferences);
    preferences.isTrustedAccessibilityClient = (prompt) => {
      const allowed = trusted(false);
      if (prompt && !allowed)
        failClosed(
          'The app requested macOS Accessibility permission. Native permission prompting is unsupported in terminal mode.',
        );
      return allowed;
    };
  }
  if (typeof electron.desktopCapturer?.getSources === 'function') {
    const getSources = electron.desktopCapturer.getSources.bind(electron.desktopCapturer);
    electron.desktopCapturer.getSources = (options) => {
      if (process.platform === 'darwin' && preferences.getMediaAccessStatus('screen') !== 'granted')
        return failClosed(
          'The app requested macOS Screen Recording permission. Native permission prompting is unsupported in terminal mode.',
        );
      return getSources(options);
    };
  }
  app.whenReady().then(() => app.dock?.hide());
  socket.on('connect', () =>
    send({
      type: 'ready',
      pid: process.pid,
      electron: process.versions.electron,
      executable: process.execPath,
    }),
  );
  socket.on('error', () => app.exit(1));
  socket.on('close', () => app.exit(0));
  socket.on('data', (data) => {
    inputBuffer += inputDecoder.write(data);
    let end;
    while ((end = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, end);
      inputBuffer = inputBuffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'resize') {
          viewport = {
            width: Math.max(100, Math.min(2560, message.width | 0)),
            height: Math.max(100, Math.min(1600, message.height | 0)),
          };
          wholeSurface = true;
          if (selected) {
            selected.setContentSize(viewport.width, viewport.height);
            selected.webContents.invalidate?.();
          }
        } else if (message.type === 'pixel-input') {
          queueInput(async () => {
            const win = selected;
            if (!win || win.isDestroyed()) return;
            const input = pixelInput(win);
            if (message.kind === 'key') input.key(message.event);
            else if (message.kind === 'paste') await paste(win, message.text);
            else if (message.kind === 'pointer') input.pointer(message.event);
            else if (message.kind === 'wheel') {
              input.pointer({
                kind: 'move',
                button: 'none',
                x: message.event.x,
                y: message.event.y,
                mods: message.event.mods,
              });
              input.wheel(message.event);
            } else if (message.kind === 'focus') {
              terminalFocused = true;
              updateFocus();
              await focusWindow(win);
            } else if (message.kind === 'release') {
              terminalFocused = false;
              updateFocus();
              input.releaseKeys();
              input.releaseModifiers();
              win.blurWebView?.();
              focusStates.delete(win.id);
              await cdp(win, 'Emulation.setFocusEmulationEnabled', { enabled: false });
            }
            await input.drain();
          });
        } else if (message.type === 'next-window') {
          queueInput(() => {
            const all = [...windows.values()].filter((w) => visibility.get(w.id));
            select(all[(all.indexOf(selected) + 1) % all.length]);
          });
        } else if (message.type === 'select-window') {
          queueInput(() => {
            const win = windows.get(message.id);
            if (win && visibility.get(win.id)) select(win);
          });
        } else if (message.type === 'close-window') queueInput(() => selected?.close());
        else if (message.type === 'quit') queueInput(() => app.quit());
        else if (message.type === 'evaluate-main' && config.test) {
          Promise.resolve()
            .then(() => eval(message.expression))
            .then(
              (value) => send({ type: 'result', request: message.request, value }),
              (error) => send({ type: 'result', request: message.request, error: error.message }),
            );
        } else if (message.type === 'evaluate' && config.test) {
          if (!selected) {
            send({ type: 'result', request: message.request, error: 'No active app window yet' });
            continue;
          }
          Promise.resolve(selected.webContents.executeJavaScript(message.expression, true)).then(
            (value) => send({ type: 'result', request: message.request, value }),
            (error) => send({ type: 'result', request: message.request, error: error.message }),
          );
        }
      } catch (error) {
        send({ type: 'error', message: error.message });
      }
    }
  });
  globalThis.__terminalElectron = {
    windows,
    report,
    select,
    originalWindow: OriginalWindow,
    facade,
  };
  return { installed: true, electron: process.versions.electron };
}
