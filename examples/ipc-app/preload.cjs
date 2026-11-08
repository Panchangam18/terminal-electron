const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  increment: () => ipcRenderer.invoke('increment'),
  save: (text) => ipcRenderer.invoke('save', text),
  secondWindow: () => ipcRenderer.invoke('second-window'),
});
