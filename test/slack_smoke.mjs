import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Session } from '../src/session.mjs';
import { Input } from './driver.mjs';
import { testApp } from './paths.mjs';

const target = testApp('Slack', process.argv[2]);
const proof = path.resolve('proof');
fs.mkdirSync(proof, { recursive: true });
const archive = path.join(target, 'Contents/Resources/app.asar');
const digest = () => createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const originalHash = digest();
const session = new Session(target, { test: true, width: 1000, height: 700 });
let latestFrame,
  windowState,
  frames = 0,
  next = 0;
const pending = new Map();
session.on('message', (message) => {
  if (message.type === 'frame') {
    latestFrame = message;
    frames++;
  }
  if (message.type === 'windows' && message.windows.length) windowState = message;
  if (message.type === 'result') {
    const request = pending.get(message.request);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.request);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
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
    }, 5000);
    pending.set(request, { resolve, reject, timer });
    session.send({ type: 'evaluate', request, expression });
  });
}
async function waitFor(check, description) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} timed out. Log: ${session.logPath}`);
}
const input = new Input(session);
try {
  await session.start();
  await waitFor(
    async () =>
      latestFrame && (await evaluate('document.body.innerText')).includes('Sign In to Slack'),
    'Slack sign-in UI',
  );
  await waitFor(() => latestFrame.png.length > 30000, 'Painted Slack content');
  const initial = await evaluate(
    '({title:document.title,url:location.href,text:document.body.innerText})',
  );
  const button = await evaluate(`(() => {
    const element = [...document.querySelectorAll('button,a')].find(e => e.textContent.includes('Sign In to Slack'));
    const r = element.getBoundingClientRect();
    return {x:r.x + r.width / 2, y:r.y + r.height / 2};
  })()`);
  // Hover the actual button without starting an authentication flow.
  input.move(button.x, button.y);
  await waitFor(
    async () =>
      await evaluate(
        `!![...document.querySelectorAll('button:hover,a:hover')].find(e=>e.textContent.includes('Sign In to Slack'))`,
      ),
    'Terminal mouse hover',
  );
  // Click inert background, then navigate to the button using terminal Tab.
  const beforeFocus = latestFrame.seq;
  input.clickAt(5, 5);
  input.key(9);
  await waitFor(
    async () =>
      (await evaluate('document.activeElement.textContent')).trim() === 'Sign In to Slack',
    'Terminal keyboard focus',
  );
  await waitFor(() => latestFrame.seq > beforeFocus, 'Keyboard focus paint');
  fs.writeFileSync(path.join(proof, 'slack.png'), Buffer.from(latestFrame.png, 'base64'));
  session.send({ type: 'resize', width: 1100, height: 760 });
  await waitFor(
    async () =>
      latestFrame?.width === 1100 &&
      latestFrame?.height === 760 &&
      (await evaluate('innerWidth===1100 && innerHeight===760')),
    'Resize',
  );
  assert(windowState.windows.every((window) => window.offscreen && !window.nativeVisible));
  assert.equal(digest(), originalHash, 'Original Slack archive changed');
  const exit = new Promise((resolve) =>
    session.once('exit', (code, signal) => resolve({ code, signal })),
  );
  input.key(113, 4);
  const timeout = setTimeout(() => session.stop(), 6000);
  const result = await exit;
  clearTimeout(timeout);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  fs.writeFileSync(
    path.join(proof, 'slack.json'),
    JSON.stringify(
      {
        target,
        runtime: session.installation,
        originalArchiveSHA256: originalHash,
        archiveUnchanged: true,
        frames,
        initial,
        windowState,
        exit: result,
        checks: [
          'Slack desktop app using its bundled Electron',
          'real sign-in UI',
          'terminal mouse hover',
          'terminal mouse click on background',
          'terminal Tab keyboard focus',
          'resized renderer and frame',
          'native windows hidden',
          'source ASAR unchanged',
          'terminal Ctrl+Q clean shutdown',
        ],
        unverified: [
          'signed-in workspace and messaging',
          'browser sign-in callback to private copy',
          'live Ghostty display (computer-use access denied)',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: Slack / Electron ${session.installation.electron}; ${frames} frames, mouse hover, Tab focus, resize, hidden native window, original archive unchanged, clean Ctrl+Q.`,
  );
} finally {
  if (latestFrame)
    fs.writeFileSync(path.join(proof, 'slack-last.png'), Buffer.from(latestFrame.png, 'base64'));
  await session.stop();
}
