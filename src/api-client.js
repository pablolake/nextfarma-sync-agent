const log = require('./logger');

const API_BASE_URL = () => (process.env.API_BASE_URL || '').replace(/\/$/, '');

// ── Cancelación de sync en curso ─────────────────────────────────────────────
let abortRequested = false;
function requestAbort()  { abortRequested = true; }
function resetAbort()    { abortRequested = false; }
function isAbortRequested() { return abortRequested; }
class SyncAbortedError extends Error {
  constructor() { super('Sync cancelado por el usuario'); this.name = 'SyncAbortedError'; }
}

async function request(path, { method = 'GET', body } = {}, _retries = 2) {
  const base = API_BASE_URL();
  if (!base) throw new Error('API_BASE_URL no configurada');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_KEY) headers['X-API-Key'] = process.env.API_KEY;
  const timeout = parseInt(process.env.API_TIMEOUT_MS, 10) || 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  } catch (err) {
    const isTransient = err.name === 'AbortError' || /HTTP 5\d\d/.test(err.message);
    if (_retries > 0 && isTransient) {
      await new Promise(r => setTimeout(r, 1500 * (3 - _retries)));
      return request(path, { method, body }, _retries - 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function status() { return request('/api/sync/status'); }

async function enviarProductos(productos) {
  const batchSize = parseInt(process.env.BATCH_SIZE, 10) || 500;
  const batches   = chunk(productos, batchSize);
  const totals    = { total: 0, inserted: 0, updated: 0, errors: 0 };
  for (let i = 0; i < batches.length; i++) {
    if (abortRequested) { log.warn(`Envío de productos cancelado (${i}/${batches.length} lotes enviados)`); throw new SyncAbortedError(); }
    log.info(`Enviando lote productos ${i + 1}/${batches.length} (${batches[i].length})...`);
    try {
      const r = await request('/api/sync/productos', { method: 'POST', body: { productos: batches[i] } });
      totals.total += r.total; totals.inserted += r.inserted;
      totals.updated += r.updated; totals.errors += r.errors;
      if (r.errors > 0 && r.errorDetails?.length) {
        log.warn(`Lote ${i + 1} · primeros errores:`);
        for (const e of r.errorDetails) log.warn(`  CN ${e.cn}: ${e.error}`);
      }
    } catch (err) {
      log.error(`Lote ${i + 1} falló:`, err.message);
      totals.errors += batches[i].length;
    }
  }
  return totals;
}

async function enviarVentas(ventas) {
  const batchSize = parseInt(process.env.BATCH_SIZE, 10) || 500;
  const batches   = chunk(ventas, batchSize);
  const totals    = { total: 0, upserts: 0, errors: 0 };
  for (let i = 0; i < batches.length; i++) {
    if (abortRequested) { log.warn(`Envío de ventas cancelado (${i}/${batches.length} lotes enviados)`); throw new SyncAbortedError(); }
    log.info(`Enviando lote ventas ${i + 1}/${batches.length} (${batches[i].length})...`);
    try {
      const r = await request('/api/sync/ventas', { method: 'POST', body: { ventas: batches[i] } });
      totals.total += r.total; totals.upserts += r.upserts; totals.errors += r.errors;
    } catch (err) {
      log.error(`Lote ${i + 1} falló:`, err.message);
      totals.errors += batches[i].length;
    }
  }
  return totals;
}

async function enviarRecepciones(recepciones) {
  const batchSize = parseInt(process.env.BATCH_SIZE, 10) || 500;
  const batches   = chunk(recepciones, batchSize);
  const totals    = { total: 0, upserts: 0, errors: 0 };
  for (let i = 0; i < batches.length; i++) {
    if (abortRequested) { log.warn(`Envío de recepciones cancelado (${i}/${batches.length} lotes enviados)`); throw new SyncAbortedError(); }
    log.info(`Enviando lote recepciones ${i + 1}/${batches.length} (${batches[i].length})...`);
    try {
      const r = await request('/api/sync/recepciones', { method: 'POST', body: { recepciones: batches[i] } });
      totals.total += r.total; totals.upserts += r.upserts; totals.errors += r.errors;
    } catch (err) {
      log.error(`Lote ${i + 1} falló:`, err.message);
      totals.errors += batches[i].length;
    }
  }
  return totals;
}

async function enviarFavoritos(favoritos) {
  try {
    return await request('/api/sync/favoritos', { method: 'POST', body: { favoritos } });
  } catch (err) {
    log.error('enviarFavoritos falló:', err.message);
    return { updated: 0, errors: favoritos.length };
  }
}

async function getCambiosPendientes(tenantId) {
  return request(`/api/${tenantId}/cambios-pendientes`);
}

async function marcarCambiosProcesados(tenantId, ids) {
  return request(`/api/${tenantId}/cambios-pendientes/procesar`, {
    method: 'POST',
    body: { ids },
  });
}

async function getListaNegraPendiente(tenantId) {
  return request(`/api/${tenantId}/lista-negra-pendiente`);
}

async function marcarListaNegraProcesada(tenantId, ids) {
  return request(`/api/${tenantId}/lista-negra-pendiente/procesar`, {
    method: 'POST',
    body: { ids },
  });
}

module.exports = {
  request,
  status,
  enviarProductos,
  enviarVentas,
  enviarRecepciones,
  enviarFavoritos,
  getCambiosPendientes,
  marcarCambiosProcesados,
  requestAbort,
  resetAbort,
  isAbortRequested,
  SyncAbortedError,
};
