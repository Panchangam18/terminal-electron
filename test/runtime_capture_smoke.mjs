import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from './harness.mjs';

const target = process.argv[2];
if (!target)
  throw new Error('Pass an Electron .app path. This check only reads the UI, resizes and quits.');
const evidence = path.resolve('proof/runtime-capture');
fs.mkdirSync(evidence, { recursive: true });
const results = [];
let profile;
for (let attempt = 1; attempt <= Number(process.argv[3] ?? 3); attempt++) {
  const started = performance.now();
  const h = new Harness(target, { profile });
  const phases = [];
  h.session.on('progress', ({ message }) =>
    phases.push({ message, ms: Math.round(performance.now() - started) }),
  );
  try {
    await h.start();
    profile = h.session.profile;
    await h.wait(() => h.frames > 0, 'first app frame', 40000);
    const firstFrameMs = Math.round(performance.now() - started);
    await h.wait(
      () =>
        h.evaluate(`document.readyState==='complete'&&document.body.innerText.trim().length>100`),
      'loaded app UI',
      30000,
    );
    const uiReadyMs = Math.round(performance.now() - started);
    await h.resize(1100, 740);
    await h.resize(1000, 700);
    h.hidden();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(h.frame && !h.exit);
    h.save(path.join(evidence, String(attempt)));
    const windows = h.windows;
    await h.quit(20000);
    results.push({
      attempt,
      status: 'pass',
      firstFrameMs,
      uiReadyMs,
      elapsedMs: Math.round(performance.now() - started),
      phases,
      frames: h.frames,
      windows,
      exit: h.exit,
      log: h.session.logPath,
    });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    await h.stop();
    fs.writeFileSync(
      path.join(evidence, 'restarts.json'),
      JSON.stringify({ target, messagesSent: 0, results }, null, 2),
    );
  }
}
