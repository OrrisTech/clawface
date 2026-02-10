const { contextBridge, ipcRenderer, shell } = require('electron');

/** Expose a safe IPC API to the renderer process via contextBridge. */
contextBridge.exposeInMainWorld('clawface', {
  // Push channels: main → renderer
  onStatusUpdate: (cb) => {
    ipcRenderer.on('status:update', (_e, status) => cb(status));
  },
  onGatewayState: (cb) => {
    ipcRenderer.on('gateway:state', (_e, state) => cb(state));
  },
  onPairCode: (cb) => {
    ipcRenderer.on('pair:code', (_e, data) => cb(data));
  },

  // Request channels: renderer → main
  getPairData: () => ipcRenderer.invoke('pair:get'),
  unpair: () => ipcRenderer.invoke('pair:unpair'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  toggleAutoLaunch: (enabled) => ipcRenderer.invoke('app:toggle-auto-launch', enabled),
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
  openExternal: (url) => shell.openExternal(url),
});
