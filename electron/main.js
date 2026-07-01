const {
  app, BrowserWindow, Tray, Menu,
  ipcMain, nativeImage, shell,
} = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({ name: 'nextfarma-sync' });

const API_BASE = process.env.OVERRIDE_API_BASE || 'https://api-production-3d66.up.railway.app';

let mainWindow      = null;
let tray            = null;
let syncTimer       = null;
let isSyncing       = false;
let lastSyncAt      = null;
let tenantName      = null;
let syncEnabled     = false;
let localServerStarted = false;
let lastSyncResults = null;  // { ok: [], warn: [], error: [], elapsed }

// ── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

// ── Config helpers ───────────────────────────────────────────────────────────
function applyConfig(cfg) {
  process.env.API_BASE_URL  = API_BASE;
  process.env.API_KEY       = cfg.apiKey       || '';
  process.env.TENANT_ID     = cfg.tenantId     || '';
  process.env.DB_SERVER     = cfg.db?.server   || 'localhost';
  process.env.DB_NAME       = cfg.db?.name     || 'Farmatic';
  process.env.DB_CONSEJO    = cfg.db?.consejo  || 'Consejo';
  process.env.DB_USER       = cfg.db?.user     || 'sa';
  process.env.DB_PASSWORD   = cfg.db?.password || '';
  process.env.DB_PORT       = String(cfg.db?.port || 1433);
  process.env.DB_INSTANCE     = cfg.db?.instance    || '';
  process.env.DB_WINDOWS_AUTH = String(cfg.db?.windowsAuth === true);
  process.env.DB_ENCRYPT      = 'false';
  process.env.DB_TRUST_CERT   = 'true';
  process.env.BATCH_SIZE    = '500';
  process.env.LOG_LEVEL     = 'info';
  process.env.USERDATA_PATH = app.getPath('userData');

  // Wizard values (all optional, defaults are built into the sync engine)
  const w = cfg.wizard || {};
  if (w.excludedVendors?.length)     process.env.EXCLUDED_VENDORS  = w.excludedVendors.join(',');
  if (w.labKern)                     process.env.LAB_KERN          = w.labKern;
  if (w.labNormon)                   process.env.LAB_NORMON        = w.labNormon;
  if (w.labTeva)                     process.env.LAB_TEVA          = w.labTeva;
  if (w.labCinfa)                    process.env.LAB_CINFA         = w.labCinfa;
  if (w.labSecundarios)              process.env.LAB_SECUNDARIOS   = w.labSecundarios;
  if (w.listIncentivadosStar)        process.env.LIST_INCENTIVADOS_STAR = String(w.listIncentivadosStar);
  if (w.listIncentivados)            process.env.LIST_INCENTIVADOS      = String(w.listIncentivados);
  if (w.listMaxRotA)                 process.env.LIST_MAX_ROT_A         = String(w.listMaxRotA);
  if (w.listMaxRotB)                 process.env.LIST_MAX_ROT_B         = String(w.listMaxRotB);
  if (w.listResto)                   process.env.LIST_RESTO             = String(w.listResto);
  if (w.listParados)                 process.env.LIST_PARADOS           = String(w.listParados);
  if (w.scUmbral)                    process.env.SC_UMBRAL              = String(w.scUmbral);
  if (w.opcRGPD)                     process.env.RGPD_OPCION            = String(w.opcRGPD);
  if (w.scCinfaNormon)               process.env.SC_CINFA_NORMON        = String(w.scCinfaNormon);
  if (w.scKernTeva)                  process.env.SC_KERN_TEVA           = String(w.scKernTeva);
}

// ── IPC utilities ────────────────────────────────────────────────────────────
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Sync engine ──────────────────────────────────────────────────────────────
async function runSyncOnce() {
  if (isSyncing) return;
  isSyncing = true;
  send('sync-status', { running: true });
  tray?.setToolTip('NextFarma Sync · sincronizando…');
  try {
    const { runSync } = require('../src/sync');
    lastSyncResults = await runSync({
      onStep: (stepData) => send('sync-step', stepData),
    });
    lastSyncAt = new Date().toISOString();
    send('sync-status', { running: false, lastSyncAt });
    tray?.setToolTip('NextFarma Sync · activo');
  } catch (err) {
    const log = require('../src/logger');
    log.error('Error en sync:', err.message);
    send('sync-status', { running: false, error: err.message });
    tray?.setToolTip('NextFarma Sync · error');
  } finally {
    isSyncing = false;
    refreshTray();
  }
}

function startAutoSync() {
  stopAutoSync();
  const cfg     = store.get('config', {});
  const minutes = cfg.syncIntervalMinutes || 15;
  syncEnabled   = true;
  runSyncOnce();
  syncTimer = setInterval(() => runSyncOnce(), minutes * 60 * 1000);
  send('sync-enabled', { enabled: true, intervalMinutes: minutes });
  refreshTray();
}

function stopAutoSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  syncEnabled = false;
  send('sync-enabled', { enabled: false });
  refreshTray();
}

function startLocalServerIfNeeded() {
  if (localServerStarted) return;
  const log = require('../src/logger');
  try {
    const { startLocalServer } = require('../src/local-server');
    startLocalServer(log, (port) => {
      localServerStarted = true;
      if (port && port !== 3001) {
        log.warn(`Servidor local iniciado en puerto ${port} (3001 estaba ocupado)`);
        process.env.LOCAL_SERVER_PORT = String(port);
      }
    });
  } catch (err) {
    log.error('Error iniciando servidor local:', err.message);
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('load-config', () => store.get('config', {}));

ipcMain.handle('save-config', (_, cfg) => {
  store.set('config', cfg);
  applyConfig(cfg);
  app.setLoginItemSettings({ openAtLogin: cfg.autostart === true });
});

ipcMain.handle('test-api-key', async (_, apiKey) => {
  const prev = process.env.API_KEY;
  process.env.API_KEY = apiKey;
  process.env.API_BASE_URL = API_BASE;
  try {
    const api = require('../src/api-client');
    const s   = await api.status();
    const nombre = s.tenant?.nombre || s.nombre || 'Farmacia';
    tenantName = nombre;
    return { ok: true, nombre };
  } catch (err) {
    process.env.API_KEY = prev;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('test-db', async (_, dbCfg) => {
  const farmatic = require('../src/farmatic-client');
  const prevEnv  = {
    DB_SERVER: process.env.DB_SERVER, DB_NAME:        process.env.DB_NAME,
    DB_USER:   process.env.DB_USER,   DB_PASSWORD:    process.env.DB_PASSWORD,
    DB_PORT:   process.env.DB_PORT,   DB_INSTANCE:    process.env.DB_INSTANCE,
    DB_CONSEJO: process.env.DB_CONSEJO, DB_WINDOWS_AUTH: process.env.DB_WINDOWS_AUTH,
  };
  process.env.DB_SERVER       = dbCfg.server   || 'localhost';
  process.env.DB_NAME         = dbCfg.name     || 'Farmatic';
  process.env.DB_CONSEJO      = dbCfg.consejo  || 'Consejo';
  process.env.DB_USER         = dbCfg.user     || 'sa';
  process.env.DB_PASSWORD     = dbCfg.password || '';
  process.env.DB_PORT         = String(dbCfg.port || 1433);
  process.env.DB_INSTANCE     = dbCfg.instance || '';
  process.env.DB_WINDOWS_AUTH = String(dbCfg.windowsAuth === true);
  try {
    await farmatic.closePool();
    const tablas = await farmatic.verificarTablas();
    await farmatic.closePool();
    return { ok: true, tablas };
  } catch (err) {
    Object.assign(process.env, prevEnv);
    await farmatic.closePool();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('run-sync-now', async () => {
  await runSyncOnce();
  return { ok: true };
});

ipcMain.handle('start-sync', () => {
  startAutoSync();
  return { ok: true };
});

ipcMain.handle('stop-sync', () => {
  stopAutoSync();
  return { ok: true };
});

ipcMain.handle('get-status', () => ({
  isSyncing,
  lastSyncAt,
  tenantName,
  syncEnabled,
  lastSyncResults,
}));

ipcMain.handle('get-cronicos-stats', () => {
  const path = require('path');
  const dbPath = process.env.USERDATA_PATH
    ? path.join(process.env.USERDATA_PATH, 'cronicos.db')
    : path.join(__dirname, '..', 'src', 'cronicos.db');
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const total      = db.prepare('SELECT COUNT(*) AS n FROM cronicos').get()?.n || 0;
    const consentidos = db.prepare('SELECT COUNT(*) AS n FROM cronicos WHERE consentimiento=1').get()?.n || 0;
    const pendientes = db.prepare(`
      SELECT COUNT(DISTINCT id_farmatic) AS n FROM cronicos_medicacion
      WHERE aviso_enviado=0
        AND julianday(fecha_estimada_salida) - julianday('now') <= 7
        AND julianday(fecha_estimada_salida) - julianday('now') >= -3
    `).get()?.n || 0;
    db.close();
    return { ok: true, total, consentidos, pendientes };
  } catch {
    return { ok: false, total: 0, consentidos: 0, pendientes: 0 };
  }
});

ipcMain.handle('open-logs-folder', () => {
  shell.openPath(app.getPath('userData'));
});

ipcMain.handle('set-log-level', (_, level) => {
  const valid = ['debug', 'info', 'warn', 'error'];
  if (valid.includes(level)) process.env.LOG_LEVEL = level;
  return { ok: true, level: process.env.LOG_LEVEL };
});

// ── Wizard IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('wizard-get-vendors', async () => {
  try {
    const farmatic = require('../src/farmatic-client');
    return { ok: true, data: await farmatic.fetchVendedoresWizard() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard-get-labs', async () => {
  try {
    const farmatic = require('../src/farmatic-client');
    return { ok: true, data: await farmatic.fetchLabsWizard() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard-get-lists', async () => {
  try {
    const farmatic = require('../src/farmatic-client');
    return { ok: true, data: await farmatic.fetchListasWizard() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard-run-diagnostic', async (_, key) => {
  try {
    const farmatic = require('../src/farmatic-client');
    const result = await farmatic.runDiagnostic(key);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard-verify-rgpd', async (_, opcion) => {
  try {
    const farmatic = require('../src/farmatic-client');
    const count = await farmatic.fetchRGPDCount(opcion);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard-save', async (_, wizardCfg) => {
  const cfg = store.get('config', {});
  cfg.wizard = wizardCfg;
  store.set('config', cfg);
  applyConfig(cfg);
  return { ok: true };
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:     940,
    height:    680,
    minWidth:  700,
    minHeight: 520,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    title:           'NextFarma Sync',
    backgroundColor: '#0f172a',
    show:            false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Close → minimize to tray
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide(); });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Abrir NextFarma Sync',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: syncEnabled ? '⏸ Detener sincronización' : '▶ Iniciar sincronización',
      click: () => syncEnabled ? stopAutoSync() : startAutoSync(),
    },
    {
      label:   '🔄 Sincronizar ahora',
      enabled: !isSyncing,
      click:   () => runSyncOnce(),
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.quit(); } },
  ]);
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: cuadrado 16×16 azul oscuro generado en memoria (BGRA: B=129 G=76 R=15 A=255)
    try {
      const size = 16;
      const buf  = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        buf[i*4] = 129; buf[i*4+1] = 76; buf[i*4+2] = 15; buf[i*4+3] = 255;
      }
      icon = nativeImage.createFromBitmap(buf, { width: size, height: size });
    } catch {
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      );
    }
  }
  tray = new Tray(icon);
  tray.setToolTip('NextFarma Sync');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// Refresh tray menu when sync state changes
function refreshTray() { tray?.setContextMenu(buildTrayMenu()); }

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const cfg = store.get('config', {});

  if (cfg.apiKey) {
    applyConfig(cfg);
    // Wire logger → renderer
    const log = require('../src/logger');
    log.emitter.on('log', (entry) => send('log', entry));
    startLocalServerIfNeeded();
    if (cfg.autosync !== false) startAutoSync();
  }

  createWindow();
  createTray();

  // Show setup tab if not configured
  mainWindow.webContents.once('did-finish-load', () => {
    if (!cfg.apiKey) send('show-setup', {});
  });
});

// ── Quit ──────────────────────────────────────────────────────────────────────
app.on('before-quit', async () => {
  stopAutoSync();
  try {
    const farmatic = require('../src/farmatic-client');
    await farmatic.closePool();
  } catch {}
});

app.on('window-all-closed', (e) => e.preventDefault());
