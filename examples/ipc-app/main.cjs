const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
ipcMain.handle('increment', () => ({
  count: ++count,
  pid: process.pid,
  electron: process.versions.electron,
}));
ipcMain.handle('save', (_, text) => {
  const target = path.join(app.getPath('userData'), 'note.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
});
ipcMain.handle('second-window', () => {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      offscreen: process.argv.includes('--fixture-high-dpi') ? { deviceScaleFactor: 2 } : undefined,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      offscreen: process.argv.includes('--fixture-high-dpi') ? { deviceScaleFactor: 2 } : undefined,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
