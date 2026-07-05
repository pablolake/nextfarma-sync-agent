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

async function enviarSchemaInfo(schema) {
  try {
    return await request('/api/sync/schema-info', { method: 'POST', body: schema });
  } catch (err) {
    log.warn('enviarSchemaInfo falló:', err.message);
    return { ok: false };
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

// Flags remotas del tenant: si se puede escribir en Farmatic y si está activada la
// auto-creación de listas de categoría cuando no existe ninguna (ver farmatic-client.js).
async function obtenerConfigSync() {
  try {
    return await request('/api/sync/config');
  } catch (err) {
    log.warn('obtenerConfigSync falló:', err.message);
    return { farmatic_write_enabled: false, farmatic_autocrear_listas: false };
  }
}

async function obtenerCategoriasActuales() {
  try {
    const r = await request('/api/sync/categorias-actuales');
    return r.categorias || [];
  } catch (err) {
    log.warn('obtenerCategoriasActuales falló:', err.message);
    return [];
  }
}

async function reportarListasCreadas(payload) {
  try {
    return await request('/api/sync/listas-creadas', { method: 'POST', body: payload });
  } catch (err) {
    log.warn('reportarListasCreadas falló:', err.message);
    return { ok: false };
  }
}

// Mapeo de esquema Farmatic ya resuelto para este tenant (columnas/tablas reales por
// entidad.atributo) — se carga una vez al arrancar cada sync y se usa como memoria: lo
// ya resuelto no se vuelve a interpretar (ver resolverAtributoColumna en farmatic-client.js).
async function obtenerMapeoEsquema() {
  try {
    const r = await request('/api/sync/mapeo-esquema');
    return r.mapeo || {};
  } catch (err) {
    log.warn('obtenerMapeoEsquema falló:', err.message);
    return {};
  }
}

// La heurística local encontró un candidato válido — se persiste tal cual (gratis,
// determinista, sin pasar por IA) para que el próximo sync ya lo tenga resuelto.
async function reportarMapeoResuelto(entidad, atributo, valor_resuelto, confianza) {
  try {
    return await request('/api/sync/mapeo-resuelto', { method: 'POST', body: { entidad, atributo, valor_resuelto, confianza } });
  } catch (err) {
    log.warn('reportarMapeoResuelto falló:', err.message);
    return { ok: false };
  }
}

// La heurística local no encontró nada — se le pide a la IA que decida entre las
// columnas/tablas reales de esta instalación. El backend decide si la confianza basta
// para aplicarla sola o si se marca como error para el panel de admin.
async function resolverConIA(entidad, atributo, descripcion, candidatos) {
  try {
    return await request('/api/sync/mapeo-ia', { method: 'POST', body: { entidad, atributo, descripcion, candidatos } });
  } catch (err) {
    log.warn('resolverConIA falló:', err.message);
    return { ok: false, aplicar: false };
  }
}

// Avisa al SaaS de que hay categorías de favoritos configuradas solo a medias, para que
// el titular vea un aviso y termine el asistente. El backend hace el dedup (no repite
// el aviso mientras el anterior siga sin leer), así que aquí solo se reporta sin más.
async function reportarCategoriasSinResolver(categorias) {
  try {
    return await request('/api/sync/categorias-sin-resolver', { method: 'POST', body: { categorias } });
  } catch (err) {
    log.warn('reportarCategoriasSinResolver falló:', err.message);
    return { ok: false };
  }
}

// Sugerencia por IA de a qué lista de Farmatic corresponde cada categoría sin resolver
// (ni config guardada ni detección por nombre) — solo lectura, nunca se aplica sola en
// el wizard, solo pre-rellena con una insignia que pide revisión.
async function sugerirListas(listas, categorias) {
  try {
    return await request('/api/sync/sugerir-listas', { method: 'POST', body: { listas, categorias } });
  } catch (err) {
    log.warn('sugerirListas falló:', err.message);
    return { ok: false };
  }
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
  // getListaNegraPendiente/marcarListaNegraProcesada estaban definidas pero nunca
  // exportadas — sync.js las llamaba vía api.getListaNegraPendiente() y siempre
  // fallaba en silencio (atrapado por el try/catch de "Lista Negra omitida").
  getListaNegraPendiente,
  marcarListaNegraProcesada,
  enviarSchemaInfo,
  obtenerConfigSync,
  obtenerCategoriasActuales,
  reportarListasCreadas,
  reportarCategoriasSinResolver,
  sugerirListas,
  obtenerMapeoEsquema,
  reportarMapeoResuelto,
  resolverConIA,
  requestAbort,
  resetAbort,
  isAbortRequested,
  SyncAbortedError,
};
