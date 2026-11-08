import { app, BrowserWindow } from 'electron';
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadURL(
    'data:text/html,<title>ES module app</title><body style="background:%2310151d;color:white;font:32px system-ui;padding:50px">Named Electron imports work.</body>',
  );
});
app.on('window-all-closed', () => app.quit());
