import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';

const exec = promisify(execFile);
const ignored = new Set(['node_modules', 'profiles', 'proof', 'work', 'Caches', 'Library']);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function discoverApplications({
  directories = [],
  spotlight = true,
  roots = ['/Applications', path.join(os.homedir(), 'Applications'), process.cwd()],
} = {}) {
  const candidates = new Set();
  const visited = new Set();
  async function walk(directory, depth = 0) {
    let canonical;
    try {
      canonical = await fs.realpath(directory);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (canonical.endsWith('.app')) {
      candidates.add(canonical);
      return;
    }
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(canonical, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter(
          (e) =>
            !e.name.startsWith('.') &&
            !ignored.has(e.name) &&
            (e.isDirectory() || e.isSymbolicLink()),
        )
        .map((e) => walk(path.join(canonical, e.name), depth + 1)),
    );
  }
  await Promise.all([...roots, ...directories].map((root) => walk(path.resolve(root))));
  if (spotlight) {
    try {
      const { stdout } = await exec(
        '/usr/bin/mdfind',
        ['-0', 'kMDItemContentType == "com.apple.application-bundle"'],
        { timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      );
      for (const candidate of stdout.split('\0')) if (candidate) candidates.add(candidate);
    } catch {}
  }
  const apps = [];
  const seen = new Set();
  // Avoid hundreds of concurrent plist processes on a heavily indexed machine.
  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const candidate = queue.pop();
        try {
          const file = await fs.realpath(candidate);
          if (seen.has(file) || !file.endsWith('.app') || file.includes('.app/Contents/')) continue;
          seen.add(file);
          if (!(await exists(path.join(file, 'Contents/Frameworks/Electron Framework.framework'))))
            continue;
          if (await exists(path.join(path.dirname(file), 'runtime.json'))) continue;
          const resources = path.join(file, 'Contents/Resources');
          if (
            !(await exists(path.join(resources, 'app.asar'))) &&
            !(await exists(path.join(resources, 'app/package.json')))
          )
            continue;
          try {
            const archive = path.join(resources, 'app.asar');
            const pkg = JSON.parse(
              (await exists(archive))
                ? extractFile(archive, 'package.json').toString('utf8')
                : await fs.readFile(path.join(resources, 'app/package.json'), 'utf8'),
            );
            if (pkg.main === '.terminal-electron.cjs') continue;
          } catch {}
          const { stdout } = await exec(
            '/usr/bin/plutil',
            ['-convert', 'json', '-o', '-', path.join(file, 'Contents/Info.plist')],
            { timeout: 2000, maxBuffer: 1024 * 1024 },
          );
          const info = JSON.parse(stdout);
          if (
            !info.CFBundleExecutable ||
            !(await exists(path.join(file, 'Contents/MacOS', info.CFBundleExecutable)))
          )
            continue;
          apps.push({
            name: info.CFBundleDisplayName || path.basename(file, '.app') || info.CFBundleName,
            path: file,
          });
        } catch {}
      }
    }),
  );
  return apps.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
