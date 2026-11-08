import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCurrentFuseWire } from '@electron/fuses';

const exec = promisify(execFile);

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
