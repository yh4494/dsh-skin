const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSkin', {
  retry: () => ipcRenderer.send('dsh-skin:retry'),
});
