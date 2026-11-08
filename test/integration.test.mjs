import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { Input } from './driver.mjs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createPackageWithOptions } from '@electron/asar';

function nextMessage(session, predicate, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out. App log: ${session.logPath}`));
    }, timeout);
    const onMessage = (m) => {
      if (predicate(m)) {
        cleanup();
        resolve(m);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timer);
      session.off('message', onMessage);
      session.off('app-error', onError);
    }
    session.on('message', onMessage);
    session.on('app-error', onError);
  });
}
let request = 0;
async function evaluate(session, expression, main = false) {
  const id = ++request;
  const result = nextMessage(session, (m) => m.type === 'result' && m.request === id);
  session.send({ type: main ? 'evaluate-main' : 'evaluate', request: id, expression });
  const message = await result;
  if (message.error) throw new Error(message.error);
  return message.value;
}
async function poll(session, expression, predicate) {
  for (let i = 0; i < 60; i++) {
    try {
      const value = await evaluate(session, expression);
      if (predicate(value)) return value;
    } catch (error) {
      if (!/disposed|destroyed|context/i.test(error.message)) throw error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Condition failed: ${expression}`);
}

test('unmanaged existing profiles are refused before an app can access their credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-profile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferences = path.join(directory, 'Preferences');
  fs.writeFileSync(preferences, 'existing app data');
  const session = new Session(fileURLToPath(new URL('../examples/ipc-app', import.meta.url)), {
    profile: directory,
  });
  t.after(() => session.stop());
  await assert.rejects(session.start(), /not created by terminal-electron/);
  assert.equal(session.child, undefined);
  assert.equal(fs.readFileSync(preferences, 'utf8'), 'existing app data');
});

test(
  'ordinary app preserves IPC, disk writes, terminal typing/clicking, scroll, resizing, multiple windows, and hidden native windows',
  { timeout: 35000 },
  async (t) => {
    const session = new Session(fileURLToPath(new URL('../examples/ipc-app', import.meta.url)), {
      test: true,
      width: 1000,
      height: 700,
    });
    t.after(() => session.stop());
    const first = nextMessage(session, (m) => m.type === 'frame');
    await session.start();
    const frame = await first;
    assert.equal(
      Buffer.from(frame.png, 'base64').subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
    );
    await poll(
      session,
      `document.readyState==='complete' && !!document.getElementById('note') && typeof desktop==='object'`,
      (v) => v === true,
    );
    const input = new Input(session);
    await evaluate(
      session,
      '(async()=>{globalThis.testClipboardText=await electron.clipboard.readText();return true;})()',
      true,
    );
    const rect = await evaluate(
      session,
      `(()=>{let r=document.getElementById('note').getBoundingClientRect();return{x:r.x+20,y:r.y+20};})()`,
    );
    input.clickAt(rect.x, rect.y);
    await poll(session, 'document.activeElement.id', (v) => v === 'note');
    await evaluate(
      session,
      'clipboardWork=new Promise(resolve=>setTimeout(resolve,120));true',
      true,
    );
    await evaluate(
      session,
      'globalThis.originalDispatchPaste=pixelInput(selected).dispatchPaste.bind(pixelInput(selected));pixelInput(selected).dispatchPaste=()=>{setTimeout(()=>originalDispatchPaste().catch(()=>{}),40);return Promise.resolve();};true',
      true,
    );
    input.paste('Local Electron. Original backend.');
    input.key(13);
    input.paste('Ordered paste. café 日本語 🚀');
    const note = 'Local Electron. Original backend.\nOrdered paste. café 日本語 🚀';
    await poll(session, `document.getElementById('note').value`, (v) => v === note);
    await evaluate(session, 'pixelInput(selected).dispatchPaste=originalDispatchPaste;true', true);
    await evaluate(session, 'clipboardWork.then(()=>true)', true);
    let clipboardRestored = false;
    for (let i = 0; i < 20; i++) {
      clipboardRestored = await evaluate(
        session,
        '(async()=>(await electron.clipboard.readText())===globalThis.testClipboardText)()',
        true,
      );
      if (clipboardRestored) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!clipboardRestored)
      console.log(
        'Clipboard restore diagnostics:',
        await evaluate(
          session,
          `(async()=>{const value=await electron.clipboard.readText();return{originalEmpty:globalThis.testClipboardText==='',currentEmpty:value==='',stillStaged:value==='Local Electron. Original backend.',formats:(await electron.clipboard.read()).map(item=>item.types)};})()`,
          true,
        ),
      );
    assert.equal(clipboardRestored, true);
    input.key(13);
    await poll(session, `document.getElementById('note').value`, (v) => v === note + '\n');
    const ipc = await evaluate(session, 'desktop.increment()');
    assert.equal(ipc.count, 1);
    assert.equal(ipc.pid, session.child.pid);
    const saved = await evaluate(session, `desktop.save(document.getElementById('note').value)`);
    assert.equal(fs.readFileSync(saved, 'utf8'), note + '\n');
    const button = await evaluate(
      session,
      `(()=>{let r=document.getElementById('increment').getBoundingClientRect();return{x:r.x+20,y:r.y+20};})()`,
    );
    input.clickAt(button.x, button.y);
    await poll(session, `document.getElementById('status').textContent`, (v) =>
      v.includes('IPC counter: 2'),
    );
    input.wheel(600, 540, 55);
    await poll(session, 'scrollY', (v) => v > 0);
    session.send({ type: 'resize', width: 800, height: 500 });
    await poll(
      session,
      '({width:innerWidth,height:innerHeight})',
      (v) => v.width === 800 && v.height === 500,
    );
    const second = nextMessage(session, (m) => m.type === 'windows' && m.windows.length === 2);
    await evaluate(session, 'desktop.secondWindow()');
    const windows = await second;
    assert(windows.windows.every((w) => w.offscreen && !w.nativeVisible));
    const switched = nextMessage(
      session,
      (m) => m.type === 'windows' && m.selected !== windows.selected,
    );
    input.key(9, 4);
    await switched;
    const capture = nextMessage(session, (m) => m.type === 'frame');
    session.send({ type: 'resize', width: 1000, height: 700 });
    const screenshot = await capture;
    const evidence = path.resolve('proof');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'ipc-app.png'), Buffer.from(screenshot.png, 'base64'));
    fs.writeFileSync(
      path.join(evidence, 'integration.json'),
      JSON.stringify(
        {
          runtime: session.installation,
          windows: windows.windows,
          ipc,
          saved,
          checks: [
            'terminal typing',
            'terminal mouse click',
            'main-process IPC',
            'filesystem write',
            'scroll',
            'resize',
            'window switching',
            'no visible native windows',
          ],
        },
        null,
        2,
      ),
    );
  },
);

test(
  'hidden utility windows do not steal the selected app surface',
  { timeout: 15000 },
  async (t) => {
    const session = new Session(fileURLToPath(new URL('../examples/ipc-app', import.meta.url)), {
      test: true,
    });
    t.after(() => session.stop());
    const initial = nextMessage(session, (m) => m.type === 'windows' && m.windows.length === 1);
    await session.start();
    const first = await initial;
    const created = nextMessage(session, (m) => m.type === 'windows' && m.windows.length === 2);
    await evaluate(
      session,
      `globalThis.utility=new (require('electron').BrowserWindow)({show:false,minWidth:100,minHeight:100,maxWidth:100,maxHeight:100,resizable:false});utility.loadURL('data:text/html,hidden');true`,
      true,
    );
    assert.equal((await created).selected, first.selected);
    await evaluate(
      session,
      'globalThis.focusEvents=[];app.on("browser-window-focus",(_,w)=>focusEvents.push(w.id));utility.showInactive();true',
      true,
    );
    assert.equal(await evaluate(session, 'selected.id', true), first.selected);
    assert.equal(await evaluate(session, 'utility.isVisible()&&!utility.isFocused()', true), true);
    const shown = nextMessage(
      session,
      (m) => m.type === 'windows' && m.selected !== first.selected,
    );
    await evaluate(session, 'utility.show();true', true);
    const utility = await shown;
    session.send({ type: 'resize', width: 800, height: 500 });
    await poll(
      session,
      '({width:innerWidth,height:innerHeight})',
      (v) => v.width === 800 && v.height === 500,
    );
    assert.deepEqual(
      await evaluate(
        session,
        '({max:utility.getMaximumSize(),resizable:utility.isResizable()})',
        true,
      ),
      { max: [100, 100], resizable: false },
    );
    assert(utility.windows.every((w) => w.offscreen && !w.nativeVisible));
    const hidden = nextMessage(
      session,
      (m) => m.type === 'windows' && m.selected === first.selected,
    );
    await evaluate(session, 'utility.hide();true', true);
    await hidden;
    assert.equal(
      await evaluate(session, "require('electron').BrowserWindow.getFocusedWindow().id", true),
      first.selected,
    );
  },
);

test('ES-module source app preserves named Electron imports', { timeout: 15000 }, async (t) => {
  const session = new Session(fileURLToPath(new URL('../examples/esm-app', import.meta.url)), {
    test: true,
  });
  t.after(() => session.stop());
  const windows = nextMessage(session, (m) => m.type === 'windows' && m.windows.length === 1);
  await session.start();
  const state = await windows;
  assert(state.windows[0].offscreen);
  assert.equal(state.windows[0].nativeVisible, false);
  await poll(session, 'document.body.innerText', (v) => v.includes('Named Electron imports work.'));
});

test(
  'packaged ASAR app runs through its original Electron binary and leaves input archive unchanged',
  { timeout: 45000, skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-package-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const runtime = createRequire(import.meta.url)('electron');
    const originalBundle = path.resolve(runtime, '../../..');
    const bundle = path.join(directory, 'ASAR Proof.app');
    execFileSync('/bin/cp', ['-cR', originalBundle, bundle]);
    const resources = path.join(bundle, 'Contents/Resources');
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
    const archive = path.join(resources, 'app.asar');
    const fixture = path.join(directory, 'source');
    fs.cpSync(fileURLToPath(new URL('../examples/esm-app', import.meta.url)), fixture, {
      recursive: true,
    });
    const helper = path.join(fixture, 'fixture-helper');
    fs.writeFileSync(helper, '#!/bin/sh\nprintf helper-ok\n', { mode: 0o755 });
    fs.appendFileSync(
      path.join(fixture, 'main.mjs'),
      `\nimport {execFileSync} from 'node:child_process';\nimport {fileURLToPath} from 'node:url';\nexecFileSync(fileURLToPath(new URL('./fixture-helper',import.meta.url)));\n`,
    );
    await createPackageWithOptions(fixture, archive, { unpack: '**/fixture-helper' });
    execFileSync('/usr/bin/plutil', [
      '-replace',
      'CFBundleURLTypes',
      '-json',
      JSON.stringify([{ CFBundleURLSchemes: ['terminal-electron-fixture'] }]),
      path.join(bundle, 'Contents/Info.plist'),
    ]);
    // Reproduce Slack's production signing: team-scoped Keychain grants and
    // explicit library validation must not be carried into the private copy.
    const entitlements = path.join(directory, 'restricted.plist');
    fs.writeFileSync(
      entitlements,
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], {
        input: JSON.stringify({
          'com.apple.security.cs.allow-jit': true,
          'keychain-access-groups': ['TEAMID.test.app'],
          'com.apple.developer.associated-domains': ['applinks:example.com'],
        }),
      }),
    );
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime,library',
      '--entitlements',
      entitlements,
      bundle,
    ]);
    const originalArchive = fs.readFileSync(archive);
    const options = {
      test: true,
      profile: path.join(directory, 'profile'),
      cacheRoot: path.join(directory, 'runtimes'),
    };
    const session = new Session(bundle, options);
    t.after(() => session.stop());
    const windows = nextMessage(session, (m) => m.type === 'windows' && m.windows.length === 1);
    await session.start();
    const state = await windows;
    assert(state.windows[0].offscreen);
    assert.equal(state.windows[0].nativeVisible, false);
    await poll(session, 'document.body.innerText', (v) =>
      v.includes('Named Electron imports work.'),
    );
    assert.deepEqual(fs.readFileSync(archive), originalArchive);
    const server = http.createServer((request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'terminal_auth=fixture-session; HttpOnly; SameSite=Lax; Max-Age=3600',
      });
      response.end(
        request.url === '/popup'
          ? '<title>Authentication popup</title><body>Private authentication popup <a id="complete" href="terminal-electron-fixture://complete?code=fixture">Complete sign in</a></body>'
          : '<title>Authentication fixture</title><body>Private authentication fixture <button id="popup" onclick="window.open(\'/popup\',\'auth-child\')">Open sign-in popup</button></body>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const authURL = `http://127.0.0.1:${server.address().port}/`;
    await evaluate(
      session,
      `app.on('open-url',(event,url)=>{event.preventDefault();globalThis.callbackURLs??=[];callbackURLs.push(url);});electron.shell.openExternal(${JSON.stringify(authURL)}).then(()=>true)`,
      true,
    );
    await poll(session, 'document.body.innerText', (v) =>
      v.includes('Private authentication fixture'),
    );
    const preferences = await evaluate(
      session,
      'selected.webContents.getLastWebPreferences()',
      true,
    );
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    const popup = await evaluate(
      session,
      `(()=>{const r=document.getElementById('popup').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    const childFrame = nextMessage(session, (m) => m.type === 'frame' && m.id > 2);
    new Input(session).clickAt(popup.x, popup.y);
    await poll(session, 'document.body.innerText', (v) =>
      v.includes('Private authentication popup'),
    );
    session.send({ type: 'resize', width: 900, height: 650 });
    await childFrame;
    const link = await evaluate(
      session,
      `(()=>{const r=document.getElementById('complete').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    new Input(session).clickAt(link.x, link.y);
    await poll(session, 'document.body.innerText', (v) =>
      v.includes('Named Electron imports work.'),
    );
    assert.deepEqual(await evaluate(session, 'globalThis.callbackURLs', true), [
      'terminal-electron-fixture://complete?code=fixture',
    ]);
    assert.equal(await evaluate(session, 'windows.size===1&&hostBrowsers.size===0', true), true);
    const prepared = session.preparedPath;
    assert(
      fs.statSync(path.join(prepared, 'Contents/Resources/app.asar.unpacked/fixture-helper')).mode &
        0o111,
    );
    const binary = fs.readFileSync(session.command.executable);
    const encrypted = await evaluate(
      session,
      `(async()=>{
    const logical=facade.app.getName();facade.app.setName('Renamed fixture');facade.app.name='Renamed again';
    if(getName()!==config.credentialName||facade.app.getName()!=='Renamed again')throw new Error('Credential namespace changed with app name');
    facade.app.name=logical;
    const s=electron.safeStorage;
    const value=s.encryptStringAsync?await s.encryptStringAsync('terminal-electron restart proof'):s.encryptString('terminal-electron restart proof');
    return{namespace:getName(),encrypted:value.toString('base64')};
  })()`,
      true,
    );
    assert(encrypted.namespace.startsWith('Terminal Electron '));
    const exit = new Promise((resolve) => session.once('exit', resolve));
    session.send({ type: 'quit' });
    assert.equal(await exit, 0);
    await session.stop();
    const restarted = new Session(bundle, options);
    t.after(() => restarted.stop());
    const reopened = nextMessage(restarted, (m) => m.type === 'windows' && m.windows.length === 1);
    await restarted.start();
    await reopened;
    assert.equal(restarted.preparedPath, prepared);
    assert.deepEqual(fs.readFileSync(restarted.command.executable), binary);
    const restored = await evaluate(
      restarted,
      `(async()=>{
    const s=electron.safeStorage;const bytes=Buffer.from(${JSON.stringify(encrypted.encrypted)},'base64');
    const value=s.decryptStringAsync?await s.decryptStringAsync(bytes):s.decryptString(bytes);
    return typeof value==='string'?value:value.result;
  })()`,
      true,
    );
    assert.equal(restored, 'terminal-electron restart proof');
    assert.equal(
      await evaluate(
        restarted,
        `electron.session.defaultSession.cookies.get({url:${JSON.stringify(authURL)},name:'terminal_auth'}).then(cookies=>cookies[0]?.value)`,
        true,
      ),
      'fixture-session',
    );
    t.after(() => {
      try {
        execFileSync(
          '/usr/bin/security',
          [
            'delete-generic-password',
            '-s',
            encrypted.namespace + ' Safe Storage',
            '-a',
            encrypted.namespace,
          ],
          { stdio: 'ignore' },
        );
      } catch {}
    });
  },
);
