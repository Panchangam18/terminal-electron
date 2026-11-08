import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createPackageWithOptions } from '@electron/asar';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { exportProfileSession } from '../src/profile-import.mjs';
import { Harness } from './harness.mjs';

test(
  'signed original app exports encrypted browser auth into a separate private runtime',
  { timeout: 120000, skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-import-test-'));
    const vendorName = 'Terminal Electron Import Fixture ' + path.basename(directory).slice(-6);
    let first = true;
    let h;
    let vendorProfile;
    const keys = new Set([vendorName]);
    const server = http.createServer((request, response) => {
      const authenticated = (request.headers.cookie ?? '').includes(
        'fixture_auth=local-test-session',
      );
      const headers = { 'Content-Type': 'text/html' };
      if (first) {
        first = false;
        headers['Set-Cookie'] =
          'fixture_auth=local-test-session; HttpOnly; SameSite=Lax; Max-Age=3600';
      }
      response.writeHead(200, headers);
      response.end(
        `<body>${authenticated ? 'Authenticated test session' : 'Unauthenticated test session'}</body>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await h?.stop();
      await new Promise((resolve) => server.close(resolve));
      for (const name of keys)
        try {
          execFileSync(
            '/usr/bin/security',
            ['delete-generic-password', '-s', name + ' Safe Storage', '-a', name],
            { stdio: 'ignore' },
          );
        } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const runtime = createRequire(import.meta.url)('electron');
    const bundle = path.join(directory, 'Vendor Fixture.app');
    execFileSync('/bin/cp', ['-cR', path.resolve(runtime, '../../..'), bundle]);
    const resources = path.join(bundle, 'Contents/Resources');
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
    const source = path.join(directory, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'auth-import-fixture',
        productName: vendorName,
        version: '1.0.0',
        main: 'main.cjs',
      }),
    );
    fs.writeFileSync(
      path.join(source, 'main.cjs'),
      `const {app,BrowserWindow,protocol}=require('electron');protocol.registerSchemesAsPrivileged([{scheme:'fixture-resource',privileges:{standard:true}}]);app.once('ready',()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:${server.address().port}/');});app.on('window-all-closed',()=>app.quit());`,
    );
    await createPackageWithOptions(source, path.join(resources, 'app.asar'), {});
    await flipFuses(bundle, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableCookieEncryption]: true,
    });
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
      stdio: 'pipe',
    });
    const empty = path.join(directory, 'empty');
    fs.mkdirSync(empty);
    const seed = path.join(directory, 'seed');
    fs.mkdirSync(seed, { mode: 0o700 });
    const initial = await exportProfileSession(bundle, empty, seed);
    vendorProfile = initial.profile;
    assert(initial.cookies.some((cookie) => cookie.name === 'fixture_auth'));
    const cookieDB = ['Cookies', 'Network/Cookies']
      .map((name) => path.join(vendorProfile, name))
      .find((file) => fs.existsSync(file));
    assert(cookieDB);
    assert.equal(fs.readFileSync(cookieDB).includes(Buffer.from('local-test-session')), false);
    h = new Harness(bundle, {
      profile: path.join(directory, 'private-profile'),
      cacheRoot: path.join(directory, 'runtimes'),
      importProfile: vendorProfile,
    });
    await h.start();
    keys.add(h.session.credentialName);
    assert(h.session.importReport.cookies >= 1);
    await h.wait(
      async () =>
        h.frame &&
        (await h.evaluate('document.body.innerText')).includes('Authenticated test session'),
      'imported session',
    );
    h.hidden();
    assert.notEqual(h.session.credentialName, vendorName);
    assert.equal(fs.existsSync(h.session.importCookies), false);
    await h.quit();
    console.log(
      'PASS: encrypted source cookies imported through the unchanged signed app; private runtime authenticated before its first request.',
    );
  },
);
