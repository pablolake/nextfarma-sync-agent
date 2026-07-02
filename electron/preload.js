const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sync', {
  loadConfig:     ()       => ipcRenderer.invoke('load-config'),
  saveConfig:     (cfg)    => ipcRenderer.invoke('save-config', cfg),
  testApiKey:     (key)    => ipcRenderer.invoke('test-api-key', key),
  testDb:         (dbCfg)  => ipcRenderer.invoke('test-db', dbCfg),
  runSyncNow:     ()       => ipcRenderer.invoke('run-sync-now'),
  cancelSync:     ()       => ipcRenderer.invoke('cancel-sync'),
  startSync:      ()       => ipcRenderer.invoke('start-sync'),
  stopSync:       ()       => ipcRenderer.invoke('stop-sync'),
  getStatus:        ()       => ipcRenderer.invoke('get-status'),
  getCronicosStats: ()       => ipcRenderer.invoke('get-cronicos-stats'),
  openLogsFolder:   ()       => ipcRenderer.invoke('open-logs-folder'),

  // Wizard
  wizardGetVendors:  ()        => ipcRenderer.invoke('wizard-get-vendors'),
  wizardGetLabs:     ()        => ipcRenderer.invoke('wizard-get-labs'),
  wizardGetLists:    ()        => ipcRenderer.invoke('wizard-get-lists'),
  wizardRunDiagnostic: (key)    => ipcRenderer.invoke('wizard-run-diagnostic', key),
  wizardVerifyRGPD:    (opcion) => ipcRenderer.invoke('wizard-verify-rgpd', opcion),
  wizardSave:        (cfg)     => ipcRenderer.invoke('wizard-save', cfg),

  onLog:         (cb) => { ipcRenderer.on('log',          (_, d) => cb(d)); },
  onSyncStatus:  (cb) => { ipcRenderer.on('sync-status',  (_, d) => cb(d)); },
  onSyncEnabled: (cb) => { ipcRenderer.on('sync-enabled', (_, d) => cb(d)); },
  onShowSetup:   (cb) => { ipcRenderer.on('show-setup',   (_, d) => cb(d)); },
  onSyncStep:    (cb) => { ipcRenderer.on('sync-step',    (_, d) => cb(d)); },
  setLogLevel:   (level) => ipcRenderer.invoke('set-log-level', level),
});
