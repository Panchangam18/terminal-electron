import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from './harness.mjs';
import { testApp, testDirectory } from './paths.mjs';
const directory = testDirectory('vscode');
const note = path.join(directory, 'note.txt'),
  marker = path.join(directory, 'backend-proof.txt');
fs.writeFileSync(note, 'Original test note.\n');
const h = new Harness(testApp('Visual Studio Code'), {
  args: [
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    note,
  ],
});
fs.mkdirSync(path.join(h.session.profile, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(h.session.profile, 'User/settings.json'),
  JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'terminal.integrated.shellIntegration.enabled': false,
  }),
);
const text = 'Terminal Electron editor proof.\nUnicode: café 日本語 🚀\n';
try {
  await h.step('VS Code workbench renders original note', async () => {
    await h.start();
    await h.wait(
      async () =>
        h.frame &&
        (
          await h.evaluate(`document.querySelector('.monaco-editor .view-lines')?.textContent??''`)
        ).includes('Original'),
    );
  });
  await h.step('terminal select-all, Unicode paste, Cmd+S save', async () => {
    const point = await h.evaluate(
      `(()=>{const r=document.querySelector('.monaco-editor').getBoundingClientRect();return{x:r.x+180,y:r.y+35};})()`,
    );
    h.clickAt(point.x, point.y);
    await h.wait(
      async () => await h.evaluate(`!!document.activeElement.closest('.monaco-editor')`),
      'focused editor',
    );
    h.key(97, 8);
    h.paste(text);
    await h.wait(async () =>
      (
        await h.evaluate(`document.querySelector('.monaco-editor .view-lines').textContent`)
      ).includes('Unicode:'),
    );
    h.key(115, 8);
    await h.wait(() => fs.readFileSync(note, 'utf8') === text, 'saved note');
  });
  await h
    .step('undo/redo operate on original editor model', async () => {
      h.key(57351);
      await h.settle();
      h.paste('UNDO_PROOF');
      await h.wait(async () =>
        (
          await h.evaluate(`document.querySelector('.monaco-editor .view-lines').textContent`)
        ).includes('UNDO_PROOF'),
      );
      h.key(122, 8);
      await h.wait(
        async () =>
          !(
            await h.evaluate(`document.querySelector('.monaco-editor .view-lines').textContent`)
          ).includes('UNDO_PROOF'),
      );
      h.key(122, 9);
      await h.wait(async () =>
        (
          await h.evaluate(`document.querySelector('.monaco-editor .view-lines').textContent`)
        ).includes('UNDO_PROOF'),
      );
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
  await h.step(
    'integrated terminal starts and its real shell writes a local proof file',
    async () => {
      h.key(112, 9);
      await h.wait(
        async () => await h.evaluate(`!!document.querySelector('.quick-input-box input')`),
        'command palette',
      );
      await h.click('.quick-input-box input');
      h.paste('Terminal: Create New Terminal');
      await h.wait(
        async () =>
          await h.evaluate(
            `document.querySelector('.quick-input-box input').value.includes('Terminal: Create New Terminal')&&[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(e=>e.textContent.includes('Terminal: Create New Terminal'))`,
          ),
        'terminal command result',
      );
      h.key(13);
      await h.wait(
        async () =>
          await h.evaluate(
            `(document.querySelector('.part.panel')?.getBoundingClientRect().height??0)>100`,
          ),
        'integrated terminal panel',
      );
      const point = await h.evaluate(
        `(()=>{const r=document.querySelector('.part.panel').getBoundingClientRect();return{x:r.x+100,y:r.y+60};})()`,
      );
      h.clickAt(point.x, point.y);
      await h.settle();
      const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
      await h.wait(
        async () =>
          await h.evaluate(
            `document.activeElement.tagName==='TEXTAREA'&&!!document.activeElement.closest('.xterm')`,
          ),
        'focused terminal',
      );
      h.paste(`printf 'terminal backend proof\\n' > ${quoted}`);
      h.key(13);
      await h.wait(
        () =>
          fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'terminal backend proof\n',
        'shell backend write',
      );
    },
  );
  await h.step(
    'resize with integrated terminal and editor, native windows stay hidden',
    async () => {
      await h.resize(1200, 850);
      await h.resize(1000, 700);
      h.hidden();
    },
  );
  await h.step('clean Ctrl+Q shutdown', () => h.quit());
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  h.save('proof/vscode-deep');
  await h.stop();
}
