import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPackageWithOptions, extractFile, getRawHeader } from '@electron/asar';
import { patchArchive } from '../src/archive.mjs';

test('archive patch preserves packed payloads, links, unpacked executables and integrity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{"main":"main.js"}');
  const data = Buffer.alloc(9 * 1024 * 1024, 123);
  fs.writeFileSync(path.join(source, 'main.js'), data);
  fs.symlinkSync('main.js', path.join(source, 'alias'));
  fs.writeFileSync(path.join(source, 'helper'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = path.join(directory, 'app.asar');
  await createPackageWithOptions(source, archive, { unpack: 'helper' });
  const before = getRawHeader(archive);
  const unpacked = fs.readFileSync(archive + '.unpacked/helper');
  const entry = '// café 日本語 🚀\n';
  await patchArchive(archive, { 'package.json': '{"main":".shim.cjs"}', '.shim.cjs': entry });
  const after = getRawHeader(archive);
  for (const name of ['main.js', 'alias', 'helper'])
    assert.deepEqual(after.header.files[name], before.header.files[name]);
  assert.deepEqual(extractFile(archive, 'alias'), data);
  assert.equal(extractFile(archive, '.shim.cjs').toString(), entry);
  assert.equal(JSON.parse(extractFile(archive, 'package.json')).main, '.shim.cjs');
  assert.deepEqual(fs.readFileSync(archive + '.unpacked/helper'), unpacked);
  assert(fs.statSync(archive + '.unpacked/helper').mode & 0o111);
  assert.equal(
    after.header.files['.shim.cjs'].integrity.hash,
    createHash('sha256').update(entry).digest('hex'),
  );
  await assert.rejects(patchArchive(archive, { '../outside': 'bad' }), /root files/);
  assert.equal(fs.existsSync(path.join(directory, 'outside')), false);
});
