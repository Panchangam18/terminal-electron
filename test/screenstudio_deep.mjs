import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from './harness.mjs';
import { testApp } from './paths.mjs';
const h = new Harness(testApp('Screen Studio'));
try {
  await h.step('original Screen Studio renders recording controls', async () => {
    await h.start();
    await h.wait(
      async () => h.frame && (await h.evaluate('document.body.innerText')).includes('No camera'),
      'recording controls',
      30000,
    );
    h.hidden();
  });
  await h.step('unpacked native helpers retain executable permissions', async () => {
    for (const binary of ['list-windows', 'file-icon', 'ffmpeg-darwin-arm64']) {
      assert(
        fs.statSync(
          path.join(h.session.preparedPath, 'Contents/Resources/app.asar.unpacked/bin', binary),
        ).mode & 0o111,
      );
    }
    assert(!fs.readFileSync(h.session.logPath, 'utf8').includes('EACCES'));
  });
  await h.step('window picker and display picker respond to terminal mouse input', async () => {
    const controls = h.windows.selected;
    const before = h.windows.windows.length;
    await h.clickText('Window', 'div,span');
    await h.wait(() => h.windows.windows.length > before, 'window picker opened');
    h.session.send({ type: 'select-window', id: controls });
    await h.wait(() => h.windows.selected === controls, 'return to recording controls');
    await h.wait(async () => (await h.evaluate('document.body.innerText')).includes('No camera'));
    await h.clickText('Display', 'div,span');
    await h.settle();
    h.session.send({ type: 'select-window', id: controls });
    await h.wait(() => h.windows.selected === controls, 'return from display picker');
    await h.wait(async () => (await h.evaluate('document.body.innerText')).includes('No camera'));
  });
  await h.step(
    'Ctrl+Tab switches between app windows without selecting hidden utility windows',
    async () => {
      const selected = h.windows.selected;
      h.key(9, 4);
      await h.wait(() => h.windows.selected !== selected, 'window switch');
      assert(h.windows.windows.find((w) => w.id === h.windows.selected).logicalVisible);
      h.key(9, 4);
      await h.wait(() => h.windows.selected !== selected, 'another window switch');
      h.hidden();
    },
  );
  await h.step('resize selected app surface', async () => {
    console.log(
      'Selected size constraints',
      await h.evaluate(
        '({size:selected.getContentSize(),min:selected.getMinimumSize(),max:selected.getMaximumSize(),resizable:selected.isResizable()})',
        true,
      ),
    );
    await h.resize(1100, 760);
  });
  await h.step('clean Ctrl+Q shutdown', () => h.quit());
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  h.save('proof/screen-studio/deep');
  await h.stop();
}
