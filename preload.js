const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    checkAdmin:          () => ipcRenderer.invoke('check-admin'),
    getIphoneLocation:   () => ipcRenderer.invoke('get-iphone-location'),
    detectTool:          () => ipcRenderer.invoke('detect-tool'),
    getDevices:        () => ipcRenderer.invoke('get-devices'),
    setLocation:       (lat, lng, udid) => ipcRenderer.invoke('set-location', { lat, lng, udid }),
    resetLocation:     (udid) => ipcRenderer.invoke('reset-location', { udid }),
    installTool:       () => ipcRenderer.invoke('install-tool'),
    getPython:         () => ipcRenderer.invoke('get-python'),
    openUrl:           (url) => ipcRenderer.invoke('open-url', url),
    setupTunnel:       (udid) => ipcRenderer.invoke('setup-tunnel', { udid }),
    teardownTunnel:    () => ipcRenderer.invoke('teardown-tunnel'),
    getTunnelStatus:   () => ipcRenderer.invoke('get-tunnel-status'),
    minimize:          () => ipcRenderer.send('win-minimize'),
    maximize:          () => ipcRenderer.send('win-maximize'),
    close:             () => ipcRenderer.send('win-close'),
    onInstallProgress: (cb) => ipcRenderer.on('install-progress', (_, data) => cb(data)),
    onTunnelStatus:    (cb) => ipcRenderer.on('tunnel-status-changed', (_, data) => cb(data)),
    onWorkerReady:     (cb) => ipcRenderer.on('worker-ready', (_, data) => cb(data)),
});
