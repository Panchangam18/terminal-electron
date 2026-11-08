import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverApplications } from '../src/discover.mjs';
import { parseArguments } from '../src/options.mjs';

test('discovery finds nested Electron apps, deduplicates symlinks, and excludes native apps and prepared copies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-discover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = (folder, name, electron = true) => {
    const bundle = path.join(root, folder, name + '.app');
    fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents/MacOS/app'), 'fixture');
    fs.writeFileSync(path.join(bundle, 'Contents/Resources/app.asar'), 'fixture');
    fs.writeFileSync(
      path.join(bundle, 'Contents/Info.plist'),
      JSON.stringify({ CFBundleName: name, CFBundleExecutable: 'app' }),
    );
    if (electron)
      fs.mkdirSync(path.join(bundle, 'Contents/Frameworks/Electron Framework.framework'), {
        recursive: true,
      });
    return bundle;
  };
  const valid = app('Nested folder', 'Fixture café');
  app('', 'Native app', false);
  const cached = app('cached', 'Prepared app');
  fs.writeFileSync(path.join(path.dirname(cached), 'runtime.json'), '{}');
  fs.symlinkSync(valid, path.join(root, 'Alias.app'));
  fs.symlinkSync(root, path.join(root, 'Loop'));
  const found = await discoverApplications({ roots: [root], spotlight: false });
  assert.deepEqual(found, [{ name: 'Fixture café', path: fs.realpathSync(valid) }]);
});

test('CLI supports picker options and forwards app help after the separator', () => {
  assert.equal(parseArguments([]).target, undefined);
  const selected = parseArguments(['--profile', 'session', '--app-dir', 'More apps']);
  assert.equal(selected.options.profile, 'session');
  assert.deepEqual(selected.directories, ['More apps']);
  const direct = parseArguments(['/Applications/App.app', '--', '--help']);
  assert.equal(direct.help, false);
  assert.deepEqual(direct.options.args, ['--help']);
  assert.throws(() => parseArguments(['--profile']), /requires a value/);
  assert.throws(() => parseArguments(['--fps', '0']), /between 1 and 60/);
});
