import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// App-specific discovery belongs to test tooling, never to the runtime adapter.
export function testApp(name, override) {
  const variable = 'TERMINAL_ELECTRON_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_APP';
  const explicit = override ?? process.env[variable];
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join('/Applications', name + '.app'), path.resolve(root, '..', name + '.app')];
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) throw new Error(`Cannot find ${name}. Set ${variable} to its .app path.`);
  return target;
}

export function testDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-' + name + '-'));
}
