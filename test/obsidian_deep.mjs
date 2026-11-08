import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from './harness.mjs';
import { testApp, testDirectory } from './paths.mjs';
const directory = testDirectory('obsidian');
const vaultParent = path.join(directory, 'vaults');
fs.mkdirSync(vaultParent);
const h = new Harness(testApp('Obsidian'), { profile: path.join(directory, 'profile') });
const vault = path.join(vaultParent, 'Terminal proof');
try {
  await h.step('launch original Obsidian and render vault picker', async () => {
    await h.start();
    await h.wait(
      async () =>
        h.frame && (await h.evaluate('document.body.innerText')).includes('Create new vault'),
    );
  });
  await h.step('create vault through the shared synchronous terminal folder picker', async () => {
    await h.clickText('Create');
    await h.wait(
      async () => await h.evaluate(`!!document.querySelector('input[placeholder="Vault name"]')`),
    );
    await h.click('input[placeholder="Vault name"]');
    await h.wait(
      async () =>
        await h.evaluate(`document.activeElement?.getAttribute('placeholder')==='Vault name'`),
      'focused vault name',
    );
    h.paste('Terminal proof');
    await h.wait(
      async () =>
        await h.evaluate(
          `document.querySelector('input[placeholder="Vault name"]').value==='Terminal proof'`,
        ),
      'entered vault name',
    );
    await h.clickText('Browse');
    await h.wait(() => h.dialog?.kind === 'open', 'terminal folder picker');
    h.dialog.handle({ type: 'change', node: h.dialog.input, text: vaultParent });
    h.dialog.handle({ type: 'submit', node: h.dialog.input, text: vaultParent });
    await h.wait(
      async () => (await h.evaluate('document.body.innerText')).includes(vaultParent),
      'selected vault folder',
    );
    await h.clickText('Create');
    await h.wait(
      async () => await h.evaluate(`!!document.querySelector('.workspace')`),
      'vault editor',
      60000,
    );
    assert(fs.existsSync(vault));
  });
  const text = '# Terminal Electron\n\nEdited through terminal input.\nUnicode: café 日本語 🚀\n';
  await h.step(
    'Cmd+N creates note, bracketed paste edits it, original backend saves Markdown',
    async () => {
      h.key(110, 8);
      await h.wait(
        async () => await h.evaluate(`!!document.querySelector('.cm-content')`),
        'new note',
      );
      await h.settle();
      await h.click('.workspace-leaf.mod-active .cm-content');
      await h.wait(
        async () => await h.evaluate(`!!document.activeElement.closest('.cm-content')`),
        'focused note body',
      );
      h.paste(text);
      await h.wait(
        () =>
          fs
            .readdirSync(vault)
            .filter((n) => n.endsWith('.md'))
            .some((n) =>
              fs.readFileSync(path.join(vault, n), 'utf8').includes('Unicode: café 日本語 🚀'),
            ),
        'saved Markdown',
      );
    },
  );
  await h.step('terminal undo and redo update the actual document', async () => {
    h.key(122, 8);
    await h.wait(
      async () =>
        !(
          await h.evaluate(
            `document.querySelector('.workspace-leaf.mod-active .cm-content').innerText`,
          )
        ).includes('Unicode:'),
      'undo',
    );
    h.key(122, 9);
    await h.wait(
      async () =>
        (
          await h.evaluate(
            `document.querySelector('.workspace-leaf.mod-active .cm-content').innerText`,
          )
        ).includes('Unicode:'),
      'redo',
    );
  });
  await h.step('command palette opens and Escape closes it', async () => {
    h.key(112, 8);
    await h.wait(
      async () => await h.evaluate(`!!document.querySelector('.prompt')`),
      'command palette',
    );
    h.key(27);
    await h.wait(
      async () => await h.evaluate(`!document.querySelector('.prompt')`),
      'close palette',
    );
  });
  await h.step('multiple resizes preserve editor and hidden native window', async () => {
    await h.resize(1200, 800);
    await h.resize(800, 600);
    await h.resize(1000, 700);
    h.hidden();
  });
  await h.step('clean Ctrl+Q shutdown', () => h.quit());
} catch (error) {
  console.error(error);
  try {
    console.log(
      'state',
      await h.evaluate(
        `electron.BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),loading:w.webContents.isLoading(),crashed:w.webContents.isCrashed()}))`,
        true,
      ),
    );
  } catch {}
  process.exitCode = 1;
} finally {
  h.save('proof/obsidian/deep');
  await h.stop();
}
