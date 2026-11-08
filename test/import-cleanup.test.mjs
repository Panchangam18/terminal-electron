import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopProfileProcesses } from '../src/profile-import.mjs';

test(
  'import cleanup kills an unresponsive owned helper and preserves other app instances',
  { timeout: 10000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-cleanup-'));
    const spawnHelper = (profile) =>
      spawn(
        process.execPath,
        [
          '-e',
          `process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);`,
          '--',
          `--user-data-dir=${profile}`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    const owned = spawnHelper(path.join(directory, 'snapshot'));
    const unrelated = spawnHelper(path.join(directory, 'snapshot-other-profile'));
    t.after(() => {
      for (const child of [owned, unrelated]) if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await Promise.all([once(owned.stdout, 'data'), once(unrelated.stdout, 'data')]);
    const exited = once(owned, 'exit');
    await stopProfileProcesses(path.join(directory, 'snapshot'), { graceMs: 150 });
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  },
);
