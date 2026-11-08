import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Session } from '../src/session.mjs';
import { Input } from './driver.mjs';
import { testApp } from './paths.mjs';

const proof = path.resolve('proof');
fs.mkdirSync(proof, { recursive: true });
const note = path.join(proof, 'vscode-note.txt');
fs.writeFileSync(note, 'Original desktop VS Code.\n');
const target = testApp('Visual Studio Code');
const session = new Session(target, {
  test: true,
  args: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--new-window', note],
});
fs.mkdirSync(path.join(session.profile, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(session.profile, 'User/settings.json'),
  JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
  }),
);
let next = 0;
let latestFrame;
let windowState;
const pending = new Map();
session.on('message', (m) => {
  if (m.type === 'frame') latestFrame = m;
  if (m.type === 'windows' && m.windows.length) windowState = m;
  if (m.type === 'result') {
    const request = pending.get(m.request);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(m.request);
      m.error ? request.reject(new Error(m.error)) : request.resolve(m.value);
    }
  }
});
session.on('app-error', (error) => console.error(error.message));
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const request = ++next;
    const timer = setTimeout(() => {
      pending.delete(request);
      reject(new Error('Evaluation timed out'));
    }, 10000);
    pending.set(request, { resolve, reject, timer });
    session.send({ type: 'evaluate', request, expression });
  });
}
async function waitFor(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition timed out. Log: ${session.logPath}`);
}
try {
  await session.start();
  await waitFor(async () =>
    String(
      await evaluate(`document.querySelector('.monaco-editor .view-lines')?.textContent`),
    ).includes('Original'),
  );
  const area = await evaluate(
    `(()=>{const r=document.querySelector('.monaco-editor').getBoundingClientRect();return{x:r.x+180,y:r.y+35};})()`,
  );
  const input = new Input(session);
  input.clickAt(area.x, area.y);
  input.key(97, 8);
  const text = 'Typed through terminal input into the actual desktop VS Code.';
  input.paste(text);
  await waitFor(async () =>
    String(await evaluate(`document.querySelector('.monaco-editor .view-lines').textContent`))
      .replace(/\u00a0/g, ' ')
      .includes(text),
  );
  input.key(115, 8);
  await waitFor(() => fs.readFileSync(note, 'utf8') === text);
  session.send({ type: 'resize', width: 1100, height: 750 });
  await waitFor(async () => (await evaluate('innerWidth')) === 1100 && latestFrame?.width === 1100);
  assert(windowState.windows.every((w) => w.offscreen && !w.nativeVisible));
  fs.writeFileSync(path.join(proof, 'vscode.png'), Buffer.from(latestFrame.png, 'base64'));
  fs.writeFileSync(
    path.join(proof, 'vscode.json'),
    JSON.stringify(
      {
        runtime: session.installation,
        originalBundle: target,
        windowState,
        typedText: fs.readFileSync(note, 'utf8'),
        checks: [
          'original desktop app and bundled Electron runtime',
          'rendered workbench',
          'terminal mouse focus',
          'terminal Cmd+A and typing',
          'terminal Cmd+S saved through original VS Code logic',
          'resize',
          'no visible native app window',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: desktop VS Code / Electron ${session.installation.electron}; terminal input edited and saved a file; viewport resized; native window hidden.`,
  );
} finally {
  if (latestFrame)
    fs.writeFileSync(path.join(proof, 'vscode-last.png'), Buffer.from(latestFrame.png, 'base64'));
  try {
    console.log(
      'Last app state:',
      JSON.stringify(
        await evaluate('({title:document.title,text:document.body.innerText.slice(0,1000)})'),
      ),
    );
  } catch {}
  await session.stop();
}
