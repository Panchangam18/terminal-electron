import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Inspector } from './inspector.mjs';
import { requireOffscreenBundle } from './bundle.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareSnapshot(source, profile) {
  const databases = [];
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith('Singleton') ||
        entry.name === 'DevToolsActivePort' ||
        /^Login Data(?:-|$)/.test(entry.name)
      ) {
        fs.rmSync(file, { force: true, recursive: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) visit(file);
      else if (entry.name === 'Cookies')
        databases.push([path.join(source, path.relative(profile, file)), file]);
    }
  };
  visit(profile);
  if (databases.length)
    execFileSync(
      'python3',
      [
        '-c',
        `import json,sqlite3,sys,os,time
from pathlib import Path
deadline=time.monotonic()+15
def progress(*args):
 if time.monotonic()>deadline:raise TimeoutError('Cookie snapshot timed out')
for source,destination in json.loads(sys.argv[1]):
 temporary=destination+'.snapshot'
 with sqlite3.connect(Path(source).as_uri()+'?mode=ro',uri=True,timeout=5) as original:
  with sqlite3.connect(temporary) as target:original.backup(target,pages=512,progress=progress,sleep=0.05)
 os.chmod(temporary,0o600)
 for suffix in ['-wal','-shm','-journal']:
  try:os.unlink(destination+suffix)
  except FileNotFoundError:pass
 os.replace(temporary,destination)
`,
        JSON.stringify(databases),
      ],
      { stdio: 'pipe', timeout: 20000 },
    );
}

function ownedProcesses(profile) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  const flags = [`--user-data-dir=${profile}`, `--database=${path.join(profile, 'Crashpad')}`];
  return (result.stdout ?? '')
    .split('\n')
    .filter(
      (line) =>
        !line.includes('/bin/ps') &&
        flags.some((flag) => {
          const index = line.indexOf(flag);
          const end = index + flag.length;
          return index >= 0 && (end === line.length || /\s/.test(line[end]));
        }),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Number.isInteger);
}

export async function stopProfileProcesses(profile, { graceMs = 1500 } = {}) {
  const signalOwned = (signal) => {
    for (const pid of ownedProcesses(profile))
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
  };
  signalOwned('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (ownedProcesses(profile).length && Date.now() < deadline) await pause(50);
  signalOwned('SIGKILL');
  const killedDeadline = Date.now() + 1000;
  while (ownedProcesses(profile).length && Date.now() < killedDeadline) await pause(50);
  if (ownedProcesses(profile).length)
    throw new Error('The temporary session-import app did not stop.');
}

export async function exportProfileSession(target, source, directory) {
  if (process.platform !== 'darwin' || !target.endsWith('.app'))
    throw new Error('Profile import currently requires a macOS Electron bundle.');
  source = fs.realpathSync(source);
  const profile = path.join(directory, 'desktop-profile-snapshot');
  const bundle = fs.realpathSync(target);
  await requireOffscreenBundle(bundle);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
  execFileSync('/bin/cp', ['-cR', source, profile]);
  fs.chmodSync(profile, 0o700);
  prepareSnapshot(source, profile);
  let client;
  let cookies;
  let exported = false;
  try {
    execFileSync(
      '/usr/bin/open',
      [
        '-g',
        '-j',
        '-n',
        '-a',
        bundle,
        '--stdout',
        '/dev/null',
        '--stderr',
        '/dev/null',
        '--args',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
      ],
      { stdio: 'pipe' },
    );
    const endpoint = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(endpoint) && Date.now() < deadline) await pause(100);
    if (!fs.existsSync(endpoint))
      throw new Error(
        'The unmodified app did not expose a debugging endpoint in the isolated profile.',
      );
    const [port, route] = fs.readFileSync(endpoint, 'utf8').trim().split('\n');
    if (!/^\d+$/.test(port) || !route?.startsWith('/devtools/browser/'))
      throw new Error('Invalid isolated app debugging endpoint.');
    client = new Inspector(`ws://127.0.0.1:${port}${route}`);
    // Wait for the network context to read and decrypt its persistent cookies.
    for (let i = 0; i < 30; i++) {
      cookies = (await client.call('Storage.getCookies')).cookies;
      if (cookies.length) break;
      await pause(100);
    }
    if (!cookies.length) throw new Error('The isolated vendor app exposed no cookies to import.');
    await client.call('Browser.close').catch(() => {});
    for (let i = 0; i < 40 && ownedProcesses(profile).length; i++) await pause(100);
    exported = true;
    return { profile, cookies };
  } catch (error) {
    if (error.message === 'Inspector timed out: Storage.getCookies')
      throw new Error(
        'Desktop session import timed out reading cookies. The temporary app will be stopped. You can launch with a new private profile and sign in instead.',
        { cause: error },
      );
    throw error;
  } finally {
    client?.close();
    await stopProfileProcesses(profile);
    if (!exported) fs.rmSync(profile, { recursive: true, force: true });
  }
}

export function installProfileSnapshot(snapshot, destination, cookies, directory) {
  const entries = fs
    .readdirSync(destination)
    .filter((name) => name !== '.terminal-electron-profile.json');
  if (entries.length) throw new Error('Import requires a new empty terminal-electron profile.');
  const removeEncryptedStores = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) removeEncryptedStores(file);
      else if (
        /^(Cookies|Login Data)(-(journal|wal|shm))?$/.test(entry.name) ||
        entry.name === 'DevToolsActivePort' ||
        entry.name.startsWith('Singleton') ||
        entry.name === '.terminal-electron-profile.json'
      )
        fs.rmSync(file, { force: true });
    }
  };
  removeEncryptedStores(snapshot);
  fs.cpSync(snapshot, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  fs.chmodSync(destination, 0o700);
  const cookieFile = path.join(directory, 'import-cookies.json');
  fs.writeFileSync(cookieFile, JSON.stringify(cookies), { mode: 0o600 });
  return cookieFile;
}
