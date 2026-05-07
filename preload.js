const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    detectTool:      () => ipcRenderer.invoke('detect-tool'),
    getDevices:      () => ipcRenderer.invoke('get-devices'),
    setLocation:     (lat, lng, udid) => ipcRenderer.invoke('set-location', { lat, lng, udid }),
    resetLocation:   (udid) => ipcRenderer.invoke('reset-location', { udid }),
    installTool:     () => ipcRenderer.invoke('install-tool'),
    getPython:       () => ipcRenderer.invoke('get-python'),
    openUrl:         (url) => ipcRenderer.invoke('open-url', url),
    minimize:        () => ipcRenderer.send('win-minimize'),
    maximize:        () => ipcRenderer.send('win-maximize'),
    close:           () => ipcRenderer.send('win-close'),
    onInstallProgress: (cb) => ipcRenderer.on('install-progress', (_, data) => cb(data)),
});
