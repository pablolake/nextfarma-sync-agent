/* ── State ──────────────────────────────────────────────────────────── */
let syncEnabled = false;
let nextSyncAt  = null;
let countdownTimer = null;

// Wizard state
const wz = {
  step: 0,
  vendors: [],          // all vendors from Farmatic
  excludedIds: new Set(),
  labs: [],             // all lab codes from Farmatic
  labCinfa: '', labNormon: '', labKern: '', labTeva: '',
  scUmbral: 2500, scCN: 5, scKT: 10,
  lists: [],            // all lists from Farmatic
  listStar: null, listInc: null, listMrotA: null, listMrotB: null, listResto: null, listPar: null,
};

/* ── Init ───────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  await loadAndApplyConfig();
  refreshStatus();

  window.sync.onLog(addLogEntry);
  window.sync.onSyncStatus(onSyncStatus);
  window.sync.onSyncEnabled(onSyncEnabled);
  window.sync.onSetupShow = () => switchTab('config');
});

// Called by main.js when API key is missing
window.addEventListener('message', (e) => {
  if (e.data === 'show-setup') switchTab('config');
});

/* ── Config ─────────────────────────────────────────────────────────── */
async function loadAndApplyConfig() {
  const cfg = await window.sync.loadConfig();
  if (!cfg) return;

  document.getElementById('cfg-apikey').value      = cfg.apiKey       || '';
  document.getElementById('cfg-db-server').value   = cfg.db?.server   || 'localhost';
  document.getElementById('cfg-db-instance').value = cfg.db?.instance || '';
  document.getElementById('cfg-db-port').value     = cfg.db?.port     || 1433;
  document.getElementById('cfg-db-user').value     = cfg.db?.user     || 'sa';
  document.getElementById('cfg-db-password').value = cfg.db?.password || '';
  document.getElementById('cfg-db-name').value     = cfg.db?.name     || 'Farmatic';
  document.getElementById('cfg-db-consejo').value  = cfg.db?.consejo  || 'Consejo';
  document.getElementById('cfg-interval').value    = cfg.syncIntervalMinutes || 15;
  document.getElementById('cfg-autostart').checked = cfg.autostart  !== false;
  document.getElementById('cfg-autosync').checked  = cfg.autosync   !== false;

  if (cfg.apiKey) {
    document.getElementById('tenant-name').textContent = cfg.tenantName || 'Farmacia';
  }

  // Show wizard badge if not yet configured
  if (!cfg.wizard || !cfg.wizard.excludedVendors) {
    document.getElementById('wizard-badge').style.display = '';
  }
}

async function saveConfig() {
  const apiKey = document.getElementById('cfg-apikey').value.trim();
  if (!apiKey) { showResult('save-result', 'La API Key es obligatoria', 'error'); return; }

  const cfg = {
    apiKey,
    tenantName: document.getElementById('tenant-name').textContent || '',
    db: {
      server:   document.getElementById('cfg-db-server').value.trim()   || 'localhost',
      instance: document.getElementById('cfg-db-instance').value.trim() || '',
      port:     parseInt(document.getElementById('cfg-db-port').value)  || 1433,
      user:     document.getElementById('cfg-db-user').value.trim()     || 'sa',
      password: document.getElementById('cfg-db-password').value,
      name:     document.getElementById('cfg-db-name').value.trim()     || 'Farmatic',
      consejo:  document.getElementById('cfg-db-consejo').value.trim()  || 'Consejo',
    },
    syncIntervalMinutes: parseInt(document.getElementById('cfg-interval').value) || 15,
    autostart: document.getElementById('cfg-autostart').checked,
    autosync:  document.getElementById('cfg-autosync').checked,
  };

  await window.sync.saveConfig(cfg);
  showResult('save-result', '✓ Configuración guardada', 'ok');

  // Restart sync with new config
  if (syncEnabled) {
    await window.sync.stopSync();
    await window.sync.startSync();
  } else if (cfg.autosync) {
    await window.sync.startSync();
  }

  refreshStatus();
}

/* ── API Key verification ────────────────────────────────────────────── */
async function verifyApiKey() {
  const key = document.getElementById('cfg-apikey').value.trim();
  if (!key) { showResult('api-verify-result', 'Introduce la API Key', 'error'); return; }

  showResult('api-verify-result', 'Verificando…', 'warn');
  const res = await window.sync.testApiKey(key);
  if (res.ok) {
    showResult('api-verify-result', `✓ Farmacia: ${res.nombre}`, 'ok');
    document.getElementById('tenant-name').textContent = res.nombre;
  } else {
    showResult('api-verify-result', `✗ Error: ${res.error}`, 'error');
  }
}

/* ── DB connection test ──────────────────────────────────────────────── */
async function testDbConnection() {
  const dbCfg = {
    server:   document.getElementById('cfg-db-server').value.trim(),
    instance: document.getElementById('cfg-db-instance').value.trim(),
    port:     parseInt(document.getElementById('cfg-db-port').value)  || 1433,
    user:     document.getElementById('cfg-db-user').value.trim(),
    password: document.getElementById('cfg-db-password').value,
    name:     document.getElementById('cfg-db-name').value.trim(),
    consejo:  document.getElementById('cfg-db-consejo').value.trim(),
  };

  showResult('db-test-result', 'Conectando…', 'warn');
  const res = await window.sync.testDb(dbCfg);
  if (res.ok) {
    const falta = res.tablas?.farmatic?.faltan?.length ? ` (faltan: ${res.tablas.farmatic.faltan.join(', ')})` : '';
    showResult('db-test-result', `✓ Conectado · Farmatic${falta}`, 'ok');
    document.getElementById('db-status').textContent = dbCfg.server + (dbCfg.instance ? '\\' + dbCfg.instance : '');
    setBadge('db-badge', 'ok', 'Conectado');
  } else {
    showResult('db-test-result', `✗ ${res.error}`, 'error');
    setBadge('db-badge', 'error', 'Error');
  }
}

/* ── Sync actions ────────────────────────────────────────────────────── */
async function syncNow() {
  const btn = document.getElementById('btn-sync-now');
  btn.disabled = true;
  btn.textContent = '⏳ Sincronizando…';
  await window.sync.runSyncNow();
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🔄 Sincronizar ahora';
  }, 3000);
}

async function toggleSync(on) {
  if (on) {
    await window.sync.startSync();
  } else {
    await window.sync.stopSync();
  }
}

/* ── Status polling ──────────────────────────────────────────────────── */
async function refreshStatus() {
  const s = await window.sync.getStatus();
  syncEnabled = s.syncEnabled;
  updateSyncUI(s);
}

function onSyncStatus(data) {
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');

  if (data.running) {
    dot.className = 'status-dot syncing';
    label.textContent = 'Sincronizando…';
  } else if (data.error) {
    dot.className = 'status-dot error';
    label.textContent = 'Error en sync';
  } else {
    dot.className = 'status-dot ok';
    label.textContent = 'Activo';
    if (data.lastSyncAt) {
      document.getElementById('last-sync-label').textContent = 'Última sync: ' + formatRelative(data.lastSyncAt);
    }
  }
}

function onSyncEnabled(data) {
  syncEnabled = data.enabled;
  const toggle = document.getElementById('toggle-sync');
  toggle.checked = data.enabled;
  document.getElementById('sync-toggle-label').textContent = data.enabled ? 'Activa' : 'Desactivada';

  if (data.enabled && data.intervalMinutes) {
    startCountdown(data.intervalMinutes * 60);
    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot ok';
    document.getElementById('status-label').textContent = 'Activo';
  } else {
    stopCountdown();
    document.getElementById('sync-info').textContent = '';
  }
}

function updateSyncUI(s) {
  const toggle = document.getElementById('toggle-sync');
  toggle.checked = s.syncEnabled;
  document.getElementById('sync-toggle-label').textContent = s.syncEnabled ? 'Activa' : 'Desactivada';
  if (s.tenantName) document.getElementById('tenant-name').textContent = s.tenantName;
  if (s.lastSyncAt) {
    document.getElementById('last-sync-label').textContent = 'Última sync: ' + formatRelative(s.lastSyncAt);
  }
  if (s.syncEnabled) {
    document.getElementById('status-dot').className = 'status-dot ok';
    document.getElementById('status-label').textContent = 'Activo';
  }
  // Update status cards
  checkLocalServer();
}

async function checkLocalServer() {
  try {
    const res = await fetch('http://localhost:3001/health');
    if (res.ok) {
      setBadge('local-badge', 'ok', 'Activo');
    } else {
      setBadge('local-badge', 'warn', 'Error');
    }
  } catch {
    setBadge('local-badge', 'warn', 'No iniciado');
  }
}

/* ── Logs ────────────────────────────────────────────────────────────── */
const MAX_LOG_ENTRIES = 500;

function addLogEntry(entry) {
  const container = document.getElementById('log-container');
  const el        = document.createElement('div');
  el.className    = 'log-entry';

  const time = entry.ts ? entry.ts.slice(11, 19) : '';
  el.innerHTML =
    `<span class="log-ts">${time}</span>` +
    `<span class="log-level ${entry.level}">${(entry.level || 'info').toUpperCase()}</span>` +
    `<span class="log-msg">${escapeHtml(entry.msg || '')}</span>`;

  container.appendChild(el);

  // Trim old entries
  while (container.children.length > MAX_LOG_ENTRIES) {
    container.removeChild(container.firstChild);
  }

  const auto = document.getElementById('log-autoscroll');
  if (auto?.checked) container.scrollTop = container.scrollHeight;

  // Also update status indicator if it's a sync marker
  if (entry.msg?.includes('═══')) {
    onSyncStatus({ running: true });
  } else if (entry.msg?.includes('✨ Sincronización completada')) {
    onSyncStatus({ running: false, lastSyncAt: new Date().toISOString() });
  }
}

function clearLogs() {
  document.getElementById('log-container').innerHTML = '';
}

function openLogsFolder() {
  window.sync.openLogsFolder();
}

/* ── Tabs ────────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
  document.getElementById('tab-' + name).classList.add('active');
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function setBadge(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'card-badge ' + type;
  el.textContent = text;
}

function showResult(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className   = `verify-result result-${type}`;
  el.textContent = msg;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRelative(isoStr) {
  const ms   = Date.now() - new Date(isoStr).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60)  return 'hace ' + secs + 's';
  const mins = Math.round(secs / 60);
  if (mins < 60)  return 'hace ' + mins + ' min';
  const hrs = Math.round(mins / 60);
  return 'hace ' + hrs + 'h';
}

function startCountdown(totalSecs) {
  stopCountdown();
  let remaining = totalSecs;
  updateCountdown(remaining);
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) remaining = totalSecs;
    updateCountdown(remaining);
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function updateCountdown(secs) {
  const el = document.getElementById('next-sync-label');
  if (!el) return;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  el.textContent = `Próxima sync en ${m}:${String(s).padStart(2, '0')}`;
}

/* ── Wizard ──────────────────────────────────────────────────────────── */

async function wizardNext(step) {
  // Validate current step before advancing
  if (step > wz.step) {
    if (wz.step === 0) wizardCollectVendors();
    if (wz.step === 1) wizardCollectLabs();
    if (wz.step === 2) wizardCollectLists();
  }

  // Activate new step
  document.querySelectorAll('.wpage').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.wstep').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < step) el.classList.add('done');
    if (i === step) el.classList.add('active');
  });
  document.getElementById('wp-' + step).classList.add('active');
  wz.step = step;

  // Load data if needed
  if (step === 0 && wz.vendors.length === 0) await wizardLoadVendors();
  if (step === 1 && wz.labs.length === 0)    await wizardLoadLabs();
  if (step === 2 && wz.lists.length === 0)   await wizardLoadLists();
  if (step === 3) renderWizardSummary();
}

async function wizardLoadVendors() {
  document.getElementById('w0-loading').style.display = '';
  document.getElementById('w0-error').style.display   = 'none';
  document.getElementById('w0-list').style.display    = 'none';

  const res = await window.sync.wizardGetVendors();
  document.getElementById('w0-loading').style.display = 'none';

  if (!res.ok) {
    const el = document.getElementById('w0-error');
    el.style.display  = '';
    el.textContent = '⚠ No se pudo conectar a Farmatic: ' + res.error +
      '\n\nAsegúrate de configurar la conexión SQL en la pestaña Configuración primero.';
    return;
  }

  wz.vendors = res.data;

  // Load saved exclusions
  const cfg = await window.sync.loadConfig();
  const savedExcluded = new Set(cfg.wizard?.excludedVendors || [99]);
  wz.excludedIds = savedExcluded;

  const container = document.getElementById('w0-list');
  container.innerHTML = '';
  for (const v of wz.vendors) {
    const isExcluded = wz.excludedIds.has(v.id);
    const item = document.createElement('label');
    item.className = 'wcheck-item';
    item.innerHTML =
      `<input type="checkbox" ${isExcluded ? 'checked' : ''} data-vid="${v.id}">` +
      `<span class="wcheck-id">${v.id}</span>` +
      `<span class="wcheck-name">${escapeHtml(v.nombre || '(sin nombre)')}</span>` +
      (v.id === 99 ? `<span class="wcheck-tag">autoconsumo</span>` : '');
    container.appendChild(item);
  }
  container.style.display = '';
}

function wizardCollectVendors() {
  wz.excludedIds = new Set();
  document.querySelectorAll('#w0-list input[type="checkbox"]').forEach(cb => {
    if (cb.checked) wz.excludedIds.add(Number(cb.dataset.vid));
  });
}

async function wizardLoadLabs() {
  document.getElementById('w1-loading').style.display = '';
  document.getElementById('w1-error').style.display   = 'none';
  document.getElementById('w1-form').style.display    = 'none';

  const res = await window.sync.wizardGetLabs();
  document.getElementById('w1-loading').style.display = 'none';

  if (!res.ok) {
    const el = document.getElementById('w1-error');
    el.style.display = '';
    el.textContent   = '⚠ ' + res.error;
    return;
  }

  wz.labs = res.data;

  const cfg    = await window.sync.loadConfig();
  const saved  = cfg.wizard || {};

  const NONE_OPT = `<option value="">— No usar —</option>`;
  const opts = NONE_OPT + wz.labs.map(l =>
    `<option value="${escapeHtml(l.codigo)}">${escapeHtml(l.codigo)} (${l.n_cns} CNs)</option>`
  ).join('');

  ['cinfa', 'normon', 'kern', 'teva'].forEach(k => {
    const sel = document.getElementById('wz-lab-' + k);
    sel.innerHTML = opts;
    const savedVal = saved['lab' + k.charAt(0).toUpperCase() + k.slice(1)] || '';
    if (savedVal) sel.value = savedVal;
    // Auto-suggest: match label containing the lab name
    if (!sel.value) {
      const match = wz.labs.find(l => l.codigo.toUpperCase().includes(k.toUpperCase()));
      if (match) sel.value = match.codigo;
    }
  });

  document.getElementById('wz-sc-umbral').value = saved.scUmbral    || 2500;
  document.getElementById('wz-sc-cn').value     = saved.scCinfaNormon != null ? (saved.scCinfaNormon * 100) : 5;
  document.getElementById('wz-sc-kt').value     = saved.scKernTeva   != null ? (saved.scKernTeva   * 100) : 10;

  document.getElementById('w1-form').style.display = '';
}

function wizardCollectLabs() {
  wz.labCinfa  = document.getElementById('wz-lab-cinfa').value;
  wz.labNormon = document.getElementById('wz-lab-normon').value;
  wz.labKern   = document.getElementById('wz-lab-kern').value;
  wz.labTeva   = document.getElementById('wz-lab-teva').value;
  wz.scUmbral  = parseFloat(document.getElementById('wz-sc-umbral').value) || 2500;
  wz.scCN      = parseFloat(document.getElementById('wz-sc-cn').value)     || 5;
  wz.scKT      = parseFloat(document.getElementById('wz-sc-kt').value)     || 10;
}

async function wizardLoadLists() {
  document.getElementById('w2-loading').style.display = '';
  document.getElementById('w2-error').style.display   = 'none';
  document.getElementById('w2-form').style.display    = 'none';

  const res = await window.sync.wizardGetLists();
  document.getElementById('w2-loading').style.display = 'none';

  if (!res.ok) {
    const el = document.getElementById('w2-error');
    el.style.display = '';
    el.textContent   = '⚠ ' + res.error;
    return;
  }

  wz.lists = res.data;
  const cfg   = await window.sync.loadConfig();
  const saved = cfg.wizard || {};

  const NONE_OPT = `<option value="">— Sin asignar —</option>`;
  const opts = NONE_OPT + wz.lists.map(l =>
    `<option value="${l.id}">Lista ${l.id} — ${escapeHtml(l.nombre)} (${l.n_items} ítems)</option>`
  ).join('');

  const fields = [
    ['wz-list-star',  'listIncentivadosStar', 67],
    ['wz-list-inc',   'listIncentivados',    102],
    ['wz-list-mrota', 'listMaxRotA',         103],
    ['wz-list-mrotb', 'listMaxRotB',         104],
    ['wz-list-resto', 'listResto',           105],
    ['wz-list-par',   'listParados',         106],
  ];
  for (const [selId, key, def] of fields) {
    const sel = document.getElementById(selId);
    sel.innerHTML = opts;
    const val = saved[key] || def;
    if (val) sel.value = String(val);
  }

  document.getElementById('w2-form').style.display = '';
}

function wizardCollectLists() {
  wz.listStar  = parseInt(document.getElementById('wz-list-star').value)  || null;
  wz.listInc   = parseInt(document.getElementById('wz-list-inc').value)   || null;
  wz.listMrotA = parseInt(document.getElementById('wz-list-mrota').value) || null;
  wz.listMrotB = parseInt(document.getElementById('wz-list-mrotb').value) || null;
  wz.listResto = parseInt(document.getElementById('wz-list-resto').value) || null;
  wz.listPar   = parseInt(document.getElementById('wz-list-par').value)   || null;
}

function renderWizardSummary() {
  wizardCollectVendors();
  wizardCollectLabs();
  wizardCollectLists();

  const excl = wz.vendors
    .filter(v => wz.excludedIds.has(v.id))
    .map(v => `${v.nombre} (ID ${v.id})`);

  const labLines = [
    wz.labCinfa  ? `CINFA → ${wz.labCinfa}`   : null,
    wz.labNormon ? `NORMON → ${wz.labNormon}` : null,
    wz.labKern   ? `KERN → ${wz.labKern}`     : null,
    wz.labTeva   ? `TEVA → ${wz.labTeva}`     : null,
  ].filter(Boolean);

  const listMap = {
    'INCENTIVADOS STAR': wz.listStar,
    'INCENTIVADOS':      wz.listInc,
    'MÁX. ROT. A':       wz.listMrotA,
    'MÁX. ROT. B':       wz.listMrotB,
    'RESTO':             wz.listResto,
    'PARADOS':           wz.listPar,
  };
  const listLines = Object.entries(listMap)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} → Lista ${v}`);

  const container = document.getElementById('wizard-summary');
  container.innerHTML = [
    item('👥', 'Vendedores excluidos',
      excl.length ? excl.join(', ') : '⚠ Ninguno seleccionado (se incluirán todos)'),
    item('🧪', 'Laboratorios SC',
      labLines.length ? labLines.join(' · ') : '⚠ Sin configurar (SC no se calculará)'),
    item('📊', 'Umbrales SC',
      `Umbral ${wz.scUmbral}€/mes · CINFA/NORMON ${wz.scCN}% · KERN/TEVA ${wz.scKT}%`),
    item('📋', 'Listas de favoritos',
      listLines.length ? listLines.join(' · ') : '⚠ Sin asignar (favoritos omitidos)'),
  ].join('');

  function item(icon, label, value) {
    return `<div class="wsummary-item">
      <span class="wsummary-icon">${icon}</span>
      <div class="wsummary-body">
        <div class="wsummary-label">${label}</div>
        <div class="wsummary-value">${escapeHtml(String(value))}</div>
      </div>
    </div>`;
  }
}

async function wizardFinish() {
  wizardCollectVendors();
  wizardCollectLabs();
  wizardCollectLists();

  const wizardCfg = {
    excludedVendors:    [...wz.excludedIds],
    labCinfa:           wz.labCinfa   || null,
    labNormon:          wz.labNormon  || null,
    labKern:            wz.labKern    || null,
    labTeva:            wz.labTeva    || null,
    scUmbral:           wz.scUmbral,
    scCinfaNormon:      wz.scCN / 100,
    scKernTeva:         wz.scKT / 100,
    listIncentivadosStar: wz.listStar,
    listIncentivados:     wz.listInc,
    listMaxRotA:          wz.listMrotA,
    listMaxRotB:          wz.listMrotB,
    listResto:            wz.listResto,
    listParados:          wz.listPar,
  };

  await window.sync.wizardSave(wizardCfg);

  // Hide badge
  document.getElementById('wizard-badge').style.display = 'none';

  // Show success and jump to status tab
  switchTab('estado');
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot ok';
  document.getElementById('status-label').textContent = 'Configuración guardada';

  // Restart sync with new settings
  await window.sync.stopSync();
  await window.sync.startSync();
}

// ── Refresh "last sync" label every 30s
setInterval(() => {
  window.sync.getStatus().then(s => {
    if (s.lastSyncAt) {
      document.getElementById('last-sync-label').textContent = 'Última sync: ' + formatRelative(s.lastSyncAt);
    }
  });
}, 30000);
