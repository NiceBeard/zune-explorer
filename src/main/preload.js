const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectoryContents: (path) => ipcRenderer.invoke('get-directory-contents', path),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  getAppIcon: (path) => ipcRenderer.invoke('get-app-icon', path),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  scanApplications: () => ipcRenderer.invoke('scan-applications'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close')
});
