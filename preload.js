'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pkgApi', {
  // Navigation
  openDirectory:   ()      => ipcRenderer.invoke('open-directory'),
  showInFolder:    (p)     => ipcRenderer.invoke('show-in-folder', p),
  openExternal:    (url)   => ipcRenderer.invoke('open-external', url),
  copyToClipboard: (text)  => ipcRenderer.invoke('clipboard-write', text),
  getAllDrives:     ()      => ipcRenderer.invoke('get-all-drives'),

  // Network
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),

  // Local scan
  scanPkgs:        (sourceDir) => ipcRenderer.invoke('scan-pkgs', sourceDir),
  cancelOperation: ()          => ipcRenderer.invoke('cancel-operation'),

  // FTP
  ftpScanPkgs: (cfg)       => ipcRenderer.invoke('ftp-scan-pkgs', cfg),
  ftpTestConn: (cfg)       => ipcRenderer.invoke('ftp-test-conn', cfg),

  // File ops
  deletePkgs:       (items)                        => ipcRenderer.invoke('delete-pkgs', items),
  renamePkg:        (item, newName)                => ipcRenderer.invoke('rename-pkg', item, newName),
  checkPkgConflicts:(items, dest, layout, fmt)     => ipcRenderer.invoke('check-pkg-conflicts', items, dest, layout, fmt),
  goPkgs:           (items, dest, act, lay, fmt, ftpDest) => ipcRenderer.invoke('go-pkgs', items, dest, act, lay, fmt, ftpDest),

  // Remote install (webMAN)
  remoteInstall: (items, ps3Ip, ps3Port, srvPort) => ipcRenderer.invoke('remote-install', items, ps3Ip, ps3Port, srvPort),
  stopPkgServer: ()                               => ipcRenderer.invoke('stop-pkg-server'),

  // PS3 discovery
  findPs3: () => ipcRenderer.invoke('find-ps3'),

  // Progress events
  onScanProgress:      (cb) => ipcRenderer.on('scan-progress',      (_e, d) => cb(d)),
  offScanProgress:     ()   => ipcRenderer.removeAllListeners('scan-progress'),
  onGoProgress:        (cb) => ipcRenderer.on('go-progress',        (_e, d) => cb(d)),
  offGoProgress:       ()   => ipcRenderer.removeAllListeners('go-progress'),
  onInstallProgress:   (cb) => ipcRenderer.on('install-progress',   (_e, d) => cb(d)),
  offInstallProgress:  ()   => ipcRenderer.removeAllListeners('install-progress'),
  onFindPs3Progress:   (cb) => ipcRenderer.on('find-ps3-progress',  (_e, d) => cb(d)),
  offFindPs3Progress:  ()   => ipcRenderer.removeAllListeners('find-ps3-progress'),
});
