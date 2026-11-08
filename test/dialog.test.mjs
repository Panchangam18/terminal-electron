import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Harness } from './harness.mjs';
import { canceledDialog } from '../src/dialog.mjs';

test(
  'shared dialog host handles sync open/message and async save/cancel through original app APIs',
  { timeout: 25000 },
  async (t) => {
    assert.equal(canceledDialog('message', { buttons: ['Continue', 'Cancel'] }).response, 1);
    assert.equal(canceledDialog('message', { buttons: ['Continue', 'Maybe'] }).response, 0);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-dialog-api-'));
    const source = path.join(directory, 'app');
    fs.mkdirSync(source);
    const selected = path.join(directory, 'café 日本語.txt');
    fs.writeFileSync(selected, 'fixture');
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'terminal-electron-dialog-api-proof',
        version: '1.0.0',
        main: 'main.cjs',
      }),
    );
    fs.writeFileSync(
      path.join(source, 'main.cjs'),
      `const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');app.whenReady().then(async()=>{const opened=dialog.showOpenDialogSync({properties:['openFile'],filters:[{name:'Text',extensions:['txt']}]});const saved=await dialog.showSaveDialog({filters:[{name:'Text',extensions:['txt']}]});fs.writeFileSync(saved.filePath,'saved by original backend');const response=dialog.showMessageBoxSync({message:'Continue the fixture?',buttons:['Cancel','Continue'],cancelId:0,defaultId:1,checkboxLabel:'Remember fixture',checkboxChecked:false});const canceled=await dialog.showOpenDialog({properties:['openDirectory']});fs.writeFileSync(path.join(app.getPath('userData'),'dialogs.json'),JSON.stringify({opened,saved,response,canceled}));app.quit();});`,
    );
    const h = new Harness(source);
    t.after(async () => {
      await h.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await h.start();
    await h.wait(() => h.dialog?.kind === 'open', 'sync open dialog');
    const first = h.dialog;
    first.value = path.join(directory, 'wrong.json');
    first.submit();
    assert.equal(h.dialog, first);
    assert(first.error);
    first.value = selected;
    first.submit();
    await h.wait(() => h.dialog?.kind === 'save', 'async save dialog');
    h.dialog.value = path.join(directory, 'new-file');
    h.dialog.submit();
    await h.wait(() => h.dialog?.kind === 'message', 'sync message dialog');
    const checkbox = h.dialog.batch.find(
      (op) => op.op === 'create' && op.props.text?.includes('Remember fixture'),
    ).id;
    h.dialog.handle({ type: 'click', node: checkbox });
    h.dialog.handle({ type: 'key', key: 'enter', kind: 'press', mods: {} });
    await h.wait(() => h.dialog?.kind === 'open', 'async open dialog');
    const exited = new Promise((resolve) => h.session.once('exit', resolve));
    h.dialog.handle({ type: 'key', key: 'escape', kind: 'press', mods: {} });
    assert.equal(await exited, 0);
    const result = JSON.parse(fs.readFileSync(path.join(h.session.profile, 'dialogs.json')));
    assert.deepEqual(result.opened, [selected]);
    assert.equal(result.saved.filePath, path.join(directory, 'new-file.txt'));
    assert.equal(result.saved.canceled, false);
    assert.equal(fs.readFileSync(result.saved.filePath, 'utf8'), 'saved by original backend');
    assert.equal(result.response, 1);
    assert.deepEqual(result.canceled, { canceled: true, filePaths: [] });
    fs.mkdirSync('proof', { recursive: true });
    fs.writeFileSync(
      'proof/dialog-api.json',
      JSON.stringify(
        {
          status: 'pass',
          checks: [
            'sync open validates filters and returns Unicode paths',
            'async save appends the selected extension',
            'original backend writes selected file',
            'sync message box default action',
            'async directory dialog cancellation',
          ],
          nativeDialogsUsed: false,
        },
        null,
        2,
      ),
    );
  },
);
