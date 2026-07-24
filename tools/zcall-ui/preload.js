const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcallUI', {
  onPartner: (cb) => ipcRenderer.on('zcall-ui:partner', (_e, p) => cb(p)),
  onState:   (cb) => ipcRenderer.on('zcall-ui:state',   (_e, s) => cb(s)),
  onDevices: (cb) => ipcRenderer.on('zcall-ui:devices', (_e, d) => cb(d)),
  action:    (action, value) => ipcRenderer.send('zcall-ui:action', { action: action, value: value }),
});
