const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const paths = dialog.showOpenDialogSync({
    title: 'Choose a fixture folder',
    defaultPath: process.env.TERMINAL_ELECTRON_DIALOG_DEFAULT,
    properties: ['openDirectory'],
  });
  fs.writeFileSync(
    path.join(app.getPath('userData'), 'dialog-result.json'),
    JSON.stringify({ paths, pid: process.pid }),
  );
  app.quit();
});
