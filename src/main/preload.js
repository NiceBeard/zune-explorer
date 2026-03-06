const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectoryContents: (path) => ipcRenderer.invoke('get-directory-contents', path),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  getAppIcon: (path) => ipcRenderer.invoke('get-app-icon', path),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getSpecialFolders: () => ipcRenderer.invoke('get-special-folders'),
  getExternalVolumes: () => ipcRenderer.invoke('get-external-volumes'),
  scanApplications: () => ipcRenderer.invoke('scan-applications'),
  getAudioMetadata: (path) => ipcRenderer.invoke('get-audio-metadata', path),
  batchScanAudioMetadata: (paths, options) => ipcRenderer.invoke('batch-scan-audio-metadata', paths, options),
  onMusicScanProgress: (callback) => ipcRenderer.on('music-scan-progress', (event, data) => callback(data)),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Zune sync
  zuneGetStatus: () => ipcRenderer.invoke('zune-get-status'),
  zuneDeviceInfo: () => ipcRenderer.invoke('zune-device-info'),
  zuneSendFiles: (paths) => ipcRenderer.invoke('zune-send-files', paths),
  zuneCancelTransfer: () => ipcRenderer.invoke('zune-cancel-transfer'),
  zuneBrowseContents: () => ipcRenderer.invoke('zune-browse-contents'),
  zuneDeleteObjects: (handles) => ipcRenderer.invoke('zune-delete-objects', handles),
  zuneEject: () => ipcRenderer.invoke('zune-eject'),
  zuneCacheLoad: (deviceKey) => ipcRenderer.invoke('zune-cache-load', deviceKey),
  zuneCacheSave: (deviceKey, data) => ipcRenderer.invoke('zune-cache-save', deviceKey, data),
  zuneCacheInvalidate: (deviceKey) => ipcRenderer.invoke('zune-cache-invalidate', deviceKey),
  pickPullDestination: () => ipcRenderer.invoke('pick-pull-destination'),
  zunePullFile: (handle, filename, destDir, metadata) => ipcRenderer.invoke('zune-pull-file', handle, filename, destDir, metadata),
  zuneProbeProperties: (handle) => ipcRenderer.invoke('zune-probe-properties', handle),
  zuneProbeWmdrmpd: () => ipcRenderer.invoke('zune-probe-wmdrmpd'),
  zuneInstallDriver: () => ipcRenderer.invoke('zune-install-driver'),
  onZuneStatus: (callback) => ipcRenderer.on('zune-status', (event, status) => callback(status)),
  onZuneTransferProgress: (callback) => ipcRenderer.on('zune-transfer-progress', (event, progress) => callback(progress)),
  onZuneBrowseProgress: (callback) => ipcRenderer.on('zune-browse-progress', (event, data) => callback(data)),

  // Metadata enrichment
  metadataSearch: (album, artist) => ipcRenderer.invoke('metadata-search', album, artist),
  metadataThumbnail: (mbid) => ipcRenderer.invoke('metadata-thumbnail', mbid),
  metadataFetch: (mbid) => ipcRenderer.invoke('metadata-fetch', mbid),
  metadataCacheGet: (artist, album) => ipcRenderer.invoke('metadata-cache-get', artist, album),
  metadataCacheSet: (artist, album, data) => ipcRenderer.invoke('metadata-cache-set', artist, album, data),
  metadataCacheGetAll: () => ipcRenderer.invoke('metadata-cache-get-all'),

  // Drag-and-drop path resolution (sandbox-safe)
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
