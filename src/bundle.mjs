import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCurrentFuseWire } from '@electron/fuses';
import { createReadStream } from 'node:fs';

const exec = promisify(execFile);
const offscreenMarkers = ['isOffscreen', 'startPainting', 'stopPainting', 'isPainting'];
const capabilities = new Map();

// A conservative admission check, without executing the target. Missing API
// names rule out native offscreen support. The live adapter still verifies each
// window: strings in a binary alone cannot prove runtime compatibility.
export async function offscreenCapability(binary) {
  const stat = await fs.stat(binary);
  const key = `${binary}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (capabilities.has(key)) return capabilities.get(key);
  const missing = new Set(offscreenMarkers);
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(binary)) {
    const data = Buffer.concat([carry, chunk]);
    for (const name of missing) if (data.includes(Buffer.from(name + '\0'))) missing.delete(name);
    if (!missing.size) break;
    carry = data.subarray(Math.max(0, data.length - 32));
  }
  const result = { supported: missing.size === 0, missing: [...missing] };
  capabilities.set(key, result);
  return result;
}

export async function requireOffscreenBundle(bundle) {
  const framework = await electronFramework(bundle);
  if (!framework) throw new Error('This bundle does not contain an Electron Framework.');
  const capability = await offscreenCapability(framework.binary);
  if (!capability.supported)
    throw new Error(
      `Unsupported Electron runtime: native offscreen APIs are missing (${capability.missing.join(', ')}). Ordinary-window capture is disabled. The app was not launched.`,
    );
  return framework;
}

export async function requireOffscreenExecutable(executable) {
  let directory = path.dirname(await fs.realpath(executable));
  while (directory !== path.dirname(directory)) {
    if (directory.endsWith('.app')) return requireOffscreenBundle(directory);
    directory = path.dirname(directory);
  }
  if (!(await offscreenCapability(executable)).supported)
    throw new Error(
      'Unsupported executable: native Electron offscreen support could not be established. The app was not launched.',
    );
}

export async function electronFramework(bundle) {
  const root = path.join(bundle, 'Contents/Frameworks');
  const standard = path.join(root, 'Electron Framework.framework');
  try {
    if ((await fs.stat(standard)).isDirectory())
      return { directory: standard, binary: path.join(standard, 'Electron Framework') };
  } catch {}
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.framework')) continue;
    const directory = path.join(root, entry.name);
    try {
      const { stdout } = await exec(
        '/usr/bin/plutil',
        [
          '-extract',
          'CFBundleExecutable',
          'raw',
          '-o',
          '-',
          path.join(directory, 'Resources/Info.plist'),
        ],
        { timeout: 2000, maxBuffer: 1024 * 1024 },
      );
      const binary = path.join(directory, stdout.trim());
      // The fuse wire identifies Electron even when the framework is branded.
      await getCurrentFuseWire(binary);
      return { directory, binary };
    } catch {}
  }
  return null;
}
