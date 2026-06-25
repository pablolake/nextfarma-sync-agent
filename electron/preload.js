const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sync', {
  loadConfig:     ()       => ipcRenderer.invoke('load-config'),
  saveConfig:     (cfg)    => ipcRenderer.invoke('save-config', cfg),
  testApiKey:     (key)    => ipcRenderer.invoke('test-api-key', key),
  testDb:         (dbCfg)  => ipcRenderer.invoke('test-db', dbCfg),
  runSyncNow:     ()       => ipcRenderer.invoke('run-sync-now'),
  startSync:      ()       => ipcRenderer.invoke('start-sync'),
  stopSync:       ()       => ipcRenderer.invoke('stop-sync'),
  getStatus:      ()       => ipcRenderer.invoke('get-status'),
  openLogsFolder: ()       => ipcRenderer.invoke('open-logs-folder'),

  // Wizard
  wizardGetVendors: () => ipcRenderer.invoke('wizard-get-vendors'),
  wizardGetLabs:    () => ipcRenderer.invoke('wizard-get-labs'),
  wizardGetLists:   () => ipcRenderer.invoke('wizard-get-lists'),
  wizardSave:  (cfg) => ipcRenderer.invoke('wizard-save', cfg),

  onLog:         (cb) => { ipcRenderer.on('log',          (_, d) => cb(d)); },
  onSyncStatus:  (cb) => { ipcRenderer.on('sync-status',  (_, d) => cb(d)); },
  onSyncEnabled: (cb) => { ipcRenderer.on('sync-enabled', (_, d) => cb(d)); },
});
