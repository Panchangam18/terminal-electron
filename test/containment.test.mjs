import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Session, resolveApp } from '../src/session.mjs';
import { offscreenCapability, requireOffscreenBundle } from '../src/bundle.mjs';
import { prepareBundle } from '../src/prepare.mjs';
import { exportProfileSession } from '../src/profile-import.mjs';
import { discoverApplications } from '../src/discover.mjs';
import { Harness } from './harness.mjs';

const markers = 'isOffscreen\0startPainting\0stopPainting\0isPainting\0';

test('missing offscreen support is refused before preparation, import or process launch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Unsupported.app');
  const framework = path.join(bundle, 'Contents/Frameworks/Electron Framework.framework');
  const binary = path.join(framework, 'Electron Framework');
  fs.mkdirSync(framework, { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents/Resources'));
  const unexpected = path.join(root, 'unexpected-execution');
  const executable = path.join(bundle, 'Contents/MacOS/app');
  fs.writeFileSync(executable, `#!/bin/sh\ntouch '${unexpected}'\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bundle, 'Contents/Info.plist'),
    JSON.stringify({ CFBundleExecutable: 'app' }),
  );
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', path.join(bundle, 'Contents/Info.plist')]);
  fs.writeFileSync(path.join(bundle, 'Contents/Resources/app.asar'), 'fixture');
  fs.writeFileSync(binary, 'custom engine without offscreen APIs');
  assert.equal((await offscreenCapability(binary)).supported, false);
  await assert.rejects(requireOffscreenBundle(bundle), /not launched/);
  await assert.rejects(resolveApp(bundle), /not launched/);
  await assert.rejects(resolveApp(executable), /not launched/);
  await assert.rejects(
    resolveApp(fileURLToPath(new URL('../examples/ipc-app', import.meta.url)), executable),
    /not launched/,
  );
  await assert.rejects(prepareBundle(bundle, root, path.join(root, 'runtimes')), /not launched/);
  await assert.rejects(exportProfileSession(bundle, root, root), /not launched/);
  const session = new Session(bundle);
  t.after(() => session.stop());
  await assert.rejects(session.start(), /not launched/);
  assert.equal(session.child, undefined);
  assert.equal(fs.existsSync(path.join(root, 'runtimes')), false);
  assert.equal(fs.existsSync(unexpected), false);
  assert.deepEqual(await discoverApplications({ roots: [root], spotlight: false }), []);
  // Invalidate the cached result after a binary changes, including markers split
  // across stream blocks. Positive static checks still require a live guard.
  fs.writeFileSync(binary, Buffer.concat([Buffer.alloc(65532), Buffer.from(markers)]));
  assert.equal((await offscreenCapability(binary)).supported, true);
  fs.writeFileSync(binary, 'again without required APIs');
  assert.equal((await offscreenCapability(binary)).supported, false);
});

async function blockedFixture(t, { prefix = '', operation, reason }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeCalled = path.join(root, 'native-prompt-or-handoff');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"guard-fixture","main":"main.cjs"}');
  fs.writeFileSync(
    path.join(root, 'main.cjs'),
    `const electron=require('electron');electron.app.whenReady().then(async()=>{${operation};require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'continued'))},'unexpected');});`,
  );
  const session = new Session(root);
  const frames = [];
  const states = [];
  session.on('message', (m) => {
    if (m.type === 'frame') frames.push(m);
    if (m.type === 'windows') states.push(m);
  });
  session.on('progress', ({ stage }) => {
    if (stage !== 'launching') return;
    const file = path.join(session.preparedPath, 'main.cjs');
    fs.writeFileSync(
      file,
      `const nativeCalled=${JSON.stringify(nativeCalled)};${prefix}\n` + fs.readFileSync(file),
    );
  });
  t.after(() => session.stop());
  const exited = new Promise((resolve) =>
    session.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await session.start();
  } catch (error) {
    assert.match(error.message, /exited|unsupported|permission|disabled/i);
  }
  const exit = await exited;
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  await session.stop();
  assert.match(fs.readFileSync(session.logPath, 'utf8'), reason);
  assert.equal(fs.existsSync(nativeCalled), false);
  assert.equal(fs.existsSync(path.join(root, 'continued')), false);
  assert.equal(frames.length, 0);
  assert(
    states.every((state) => state.windows.every((win) => win.offscreen && !win.nativeVisible)),
  );
}

test(
  'live windows lacking offscreen support stop immediately instead of using page capture',
  { timeout: 12000 },
  async (t) => {
    await blockedFixture(t, {
      prefix: `require('electron').app.on('web-contents-created',(_,contents)=>{contents.isOffscreen=undefined;});`,
      operation: `new electron.BrowserWindow({show:true,fullscreen:true,kiosk:true})`,
      reason: /native offscreen rendering is required/,
    });
  },
);

test(
  'native permission and desktop handoff guards stop before calling OS APIs',
  { timeout: 20000 },
  async (t) => {
    const mark = `require('node:fs').writeFileSync(nativeCalled,'unexpected');`;
    for (const fixture of [
      {
        label: 'Accessibility',
        prefix: `require('electron').systemPreferences.isTrustedAccessibilityClient=(prompt)=>{if(prompt){${mark}}return false;};`,
        operation: 'electron.systemPreferences.isTrustedAccessibilityClient(true)',
        reason: /Accessibility permission/,
      },
      {
        label: 'Screen Recording',
        prefix: `require('electron').systemPreferences.getMediaAccessStatus=()=> 'not-determined';require('electron').desktopCapturer.getSources=()=>{${mark}return Promise.resolve([]);};`,
        operation: "electron.desktopCapturer.getSources({types:['screen']})",
        reason: /Screen Recording permission/,
      },
      {
        label: 'System Settings',
        prefix: `require('electron').shell.openExternal=()=>{${mark}return Promise.resolve();};`,
        operation:
          "await electron.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')",
        reason: /Desktop handoff is disabled/,
      },
      {
        label: 'Relaunch',
        prefix: `require('electron').app.relaunch=()=>{${mark}};`,
        operation: 'electron.app.relaunch()',
        reason: /Native app relaunch is disabled/,
      },
      {
        label: 'Native BaseWindow',
        prefix: `require('electron').BaseWindow=class { constructor(){${mark}} };`,
        operation: 'new electron.BaseWindow({show:true})',
        reason: /Native BaseWindow windows\/views are not supported/,
      },
    ])
      await t.test(fixture.label, () => blockedFixture(t, fixture));
  },
);

test('development runtime passes static admission without being launched', async () => {
  const runtime = createRequire(import.meta.url)('electron');
  assert(await requireOffscreenBundle(path.resolve(runtime, '../../..')));
});

test(
  'offscreen fixture retains typing, resize and quit while desktop activation stays virtual',
  { timeout: 15000 },
  async (t) => {
    const h = new Harness(fileURLToPath(new URL('../examples/ipc-app', import.meta.url)));
    t.after(() => h.stop());
    const marker = path.join(h.session.directory, 'native-activation');
    h.session.on('progress', ({ stage }) => {
      if (stage !== 'launching') return;
      const entry = path.join(h.session.preparedPath, 'main.cjs');
      const spy = `()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`;
      fs.writeFileSync(
        entry,
        `const originalApp=require('electron').app;originalApp.show=${spy};originalApp.focus=${spy};originalApp.setActivationPolicy=${spy};if(originalApp.dock){originalApp.dock.show=${spy};originalApp.dock.bounce=${spy};}\n` +
          fs.readFileSync(entry),
      );
    });
    await h.start();
    await h.wait(() => h.frames > 0, 'fixture frame');
    await h.click('#note');
    for (const character of 'Keyboard input') h.key(character.codePointAt(0));
    await h.wait(
      () => h.evaluate(`document.getElementById('note').value==='Keyboard input'`),
      'typed input',
    );
    await h.resize(820, 510);
    assert.equal(
      await h.evaluate(
        `(()=>{
    app.show();app.focus();app.setActivationPolicy('regular');app.dock?.show();app.dock?.bounce();
    const win=new facade.BrowserWindow({show:true,fullscreen:true,kiosk:true,alwaysOnTop:true});
    win.show();win.focus();win.setFullScreen(true);win.setKiosk(true);win.setAlwaysOnTop(true);
    const native=OriginalWindow.prototype;
    return !nativeVisibility.get(win.id)()&&nativeOffscreen.get(win.id)()&&!native.isFullScreen.call(win)&&!native.isKiosk.call(win)&&!native.isAlwaysOnTop.call(win);
  })()`,
        true,
      ),
      true,
    );
    h.hidden();
    assert.equal(fs.existsSync(marker), false);
    assert(!h.session.logPath.startsWith(h.session.directory + path.sep));
    assert.equal(fs.statSync(h.session.logPath).mode & 0o777, 0o600);
    await h.quit();
    assert(fs.existsSync(h.session.logPath));
  },
);
