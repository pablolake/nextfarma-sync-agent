/**
 * sync.js — Orquestador de sincronización.
 * Exporta runSync() para ser invocado por Electron (main.js) o por CLI.
 */

const farmatic = require('./farmatic-client');
const api      = require('./api-client');
const log      = require('./logger');
const { syncCronicos, syncCronicosClientes } = require('./cronicos_sync');

const { PVL_FACTOR } = farmatic;

// Lab map leído en tiempo de ejecución para que los cambios de wizard se apliquen sin reinicio
function getLabMap() {
  return {
    [process.env.LAB_KERN   || 'E0863']: 'KERN',
    [process.env.LAB_NORMON || 'E0426']: 'NORMON',
    [process.env.LAB_TEVA   || 'E1079']: 'TEVA',
    [process.env.LAB_CINFA  || 'E0111']: 'CINFA',
  };
}

function labNombre(cod) {
  return (getLabMap()[cod?.trim()] || cod || '').toUpperCase().trim();
}

function calcularSCporLabMes(ventas, productos) {
  const umbral = parseFloat(process.env.SC_UMBRAL)       || 2500;
  const scCN   = parseFloat(process.env.SC_CINFA_NORMON) || 0.05;
  const scKT   = parseFloat(process.env.SC_KERN_TEVA)    || 0.10;

  const catalogoPorCN = new Map(productos.map(p => [p.codigo_nacional, p]));
  const compra = new Map();
  for (const v of ventas) {
    const prod = catalogoPorCN.get(v.codigo_nacional);
    if (!prod || !prod.pvl || !prod.laboratorio) continue;
    const lab   = labNombre(prod.laboratorio);
    const clave = `${lab}_${v.anio}_${v.mes}`;
    const importePVL = (prod.pvl * (1 - (prod.dto || 0))) * v.unidades;
    compra.set(clave, (compra.get(clave) || 0) + importePVL);
  }
  const sc = new Map();
  for (const [clave, importe] of compra) {
    const lab = clave.split('_')[0];
    let scVal = 0;
    if (['CINFA', 'NORMON'].includes(lab) && importe >= umbral) scVal = scCN;
    if (['KERN',  'TEVA' ].includes(lab) && importe >= umbral) scVal = scKT;
    if (scVal > 0) sc.set(clave, scVal);
  }
  return sc;
}

async function runSync() {
  const t0 = Date.now();
  log.info('═══════════════════════════════════════════');
  log.info('Iniciando sincronización');

  // Track partial results to inform the user at the end
  const resultados = { ok: [], warn: [], error: [] };
  const ok   = (msg) => { resultados.ok.push(msg);    log.info('✓ ' + msg); };
  const warn = (msg) => { resultados.warn.push(msg);  log.warn('⚠ ' + msg); };
  const err  = (msg) => { resultados.error.push(msg); log.error('✗ ' + msg); };

  try {
    const s = await api.status();
    ok(`API conectada · Farmacia: ${s.tenant?.nombre || '—'}`);
  } catch (e) {
    err('API inalcanzable: ' + e.message);
    err('Sync cancelado: sin conexión con NextFarma.');
    return { ...resultados, elapsed: '0s' };
  }

  const anioActual   = new Date().getFullYear();
  const anioAnterior = anioActual - 1;
  let todasVentas    = [];
  let sinFiltroFacturada = false;
  const origWarn = log.warn.bind(log);
  const warnProxy = (msg, ...args) => {
    if (typeof msg === 'string' && msg.includes('no se detectó columna Facturada')) sinFiltroFacturada = true;
    origWarn(msg, ...args);
  };
  log.warn = warnProxy;
  try {
    const vActual   = await farmatic.fetchVentasMensuales(anioActual);
    const vAnterior = await farmatic.fetchVentasMensuales(anioAnterior);
    todasVentas = [...vActual, ...vAnterior];
    ok(`Ventas: ${vActual.length} (${anioActual}) + ${vAnterior.length} (${anioAnterior})`);
    if (sinFiltroFacturada) warn('Columna Facturada no detectada en Farmatic — ventas incluyen borradores/anulados');
  } catch (e) {
    warn('Ventas no disponibles: ' + e.message + ' — Los análisis de ventas no se actualizarán.');
  } finally {
    log.warn = origWarn;
  }

  let productos = [];
  try {
    productos = await farmatic.fetchProductos();
    ok(`${productos.length} productos leídos`);
    // Inform about products with missing key fields
    const sinPvl = productos.filter(p => !p.pvl).length;
    const sinDto = productos.filter(p => !p.dto).length;
    if (sinPvl > 0) warn(`${sinPvl} productos sin PVL — precio de compra se estimará por ratio`);
    if (sinDto > 0 && sinDto < productos.length * 0.5)
      warn(`${sinDto} productos sin descuento Cofares — SC no calculable para esos CNs`);
  } catch (e) {
    warn('Catálogo de productos no disponible: ' + e.message + ' — El resto del sync continúa.');
  }

  // Load recepciones early so we can use bonificacion as dto fallback
  let recepciones = [];
  try {
    recepciones = await farmatic.fetchRecepcionesRecientes(12);
    log.info(`✓ ${recepciones.length} recepciones leídas (último año)`);
  } catch (err) {
    log.warn('Recepciones no disponibles:', err.message);
  }

  // Priority 1: 4DB (Cofares Conecta 4D) — most accurate, normalized to decimal in farmatic-client
  try {
    const datos4DB = await farmatic.fetch4DBDescuentos();
    if (datos4DB.length > 0) {
      const map4DB = new Map(datos4DB.map(d => [d.codigo_nacional, d]));
      let n4db = 0;
      for (const prod of productos) {
        const d = map4DB.get(prod.codigo_nacional);
        if (d) {
          prod.tipo       = d.es_generico ? 'GENÉRICO' : 'ÉTICO';
          prod.dto        = d.dto_pct > 0 ? d.dto_pct : (prod.dto || 0);
          prod.pvl        = d.pvl_4db || prod.pvl;
          prod.modelo_4db = d.modelo;
          if (d.dto_pct > 0) n4db++;
        }
      }
      log.info(`✓ 4DB: ${datos4DB.length} CNs, ${n4db} con dto`);
    }
  } catch (err) {
    log.warn('4DB omitido:', err.message);
  }

  // Priority 2: LineaRecep.bonificacion — last real albaran discount, for products still without dto
  if (recepciones.length > 0) {
    const mapRecep = new Map(recepciones.map(r => [r.codigo_nacional, r]));
    let nRecep = 0;
    for (const prod of productos) {
      if (prod.dto > 0) continue;
      const r = mapRecep.get(prod.codigo_nacional);
      if (!r || r.bonificacion == null || r.bonificacion <= 0) continue;
      // bonificacion stored as 0-100 (%), normalize to decimal
      prod.dto = +(r.bonificacion / 100).toFixed(4);
      nRecep++;
    }
    if (nRecep > 0) log.info(`✓ LineaRecep fallback: ${nRecep} productos con dto de albarán`);
  }

  if (todasVentas.length > 0 && productos.length > 0) {
    const scMap     = calcularSCporLabMes(todasVentas, productos);
    const mesActual = new Date().getMonth() + 1;
    for (const prod of productos) {
      if (!prod.laboratorio) continue;
      const lab   = labNombre(prod.laboratorio);
      const clave = `${lab}_${anioActual}_${mesActual}`;
      prod.sc     = scMap.get(clave) || 0;
      const dto   = prod.dto || 0;
      const sc    = prod.sc  || 0;
      if (prod.puc == null && prod.pvl != null) {
        prod.pc = +(prod.pvl * (1 - dto - sc) * 1.045).toFixed(4);
      }
      prod.dto_sc = +(dto + sc).toFixed(4);
    }
    const conSC = productos.filter(p => p.sc > 0).length;
    log.info(`✓ SC calculado: ${conSC} productos con Selección Genéricos activa`);
  }

  if ((process.env.SYNC_SOLO_VENDIDOS || '').toLowerCase() === 'true' && todasVentas.length > 0) {
    const cnsConVenta = new Set(todasVentas.map(v => v.codigo_nacional));
    const antes = productos.length;
    productos = productos.filter(p => cnsConVenta.has(p.codigo_nacional));
    log.info(`✓ Filtro SOLO_VENDIDOS: ${productos.length}/${antes} productos con ventas`);
  }

  if (productos.length > 0) {
    try {
      const r = await api.enviarProductos(productos);
      ok(`Productos: ${r.inserted} nuevos, ${r.updated} actualizados${r.errors > 0 ? `, ${r.errors} errores` : ''}`);
      if (r.errors > 0) warn(`${r.errors} productos rechazados por la API — puede haber CNs con datos incompletos`);
    } catch (e) {
      err('Error enviando productos: ' + e.message);
    }
  } else {
    warn('Sin productos que enviar — el catálogo no se actualizará');
  }

  if (todasVentas.length > 0) {
    try {
      const r = await api.enviarVentas(todasVentas);
      ok(`Ventas: ${r.upserts} actualizadas${r.errors > 0 ? `, ${r.errors} errores` : ''}`);
    } catch (e) {
      err('Error enviando ventas: ' + e.message);
    }
  } else {
    warn('Sin ventas que enviar — tablas Venta/LineaVenta no accesibles o vacías');
  }

  try {
    const vAnuales = await farmatic.fetchVentasAnuales(anioAnterior);
    if (vAnuales.length > 0) {
      const r = await api.enviarVentas(vAnuales);
      log.info(`✓ Ventas anuales ${anioAnterior}: ${r.upserts} actualizadas`);
    }
  } catch (err) {
    log.warn('Ventas anuales omitidas:', err.message);
  }

  if (recepciones.length > 0) {
    try {
      const r = await api.enviarRecepciones(recepciones);
      log.info(`✓ Recepciones: ${r.upserts} productos con precio real de albarán`);
    } catch (err) {
      log.warn('Error enviando recepciones:', err.message);
    }
  } else {
    log.info('Recepciones: sin datos o tablas no disponibles.');
  }

  try {
    const favoritos = await farmatic.fetchFavoritosListas();
    if (favoritos.length > 0) {
      const r = await api.enviarFavoritos(favoritos);
      log.info(`✓ Favoritos: ${r.updated} GHs actualizados desde listas de Farmatic`);
    } else {
      log.warn('Favoritos: no se encontraron ítems en las listas de Farmatic.');
    }
  } catch (err) {
    log.warn('Favoritos omitidos:', err.message);
  }

  try {
    const favActuales = await farmatic.fetchFavoritosActuales();
    if (favActuales.size > 0) {
      const cambios = [];
      for (const [ch, cn] of favActuales) cambios.push({ ch, cn_favorito: cn });
      const r = await api.request('/api/sync/favoritos-historico', { method: 'POST', body: { cambios } });
      log.info(`✓ Favoritos histórico: ${r.upserts} registros actualizados`);
    }
  } catch (err) {
    log.warn('Favoritos histórico omitido:', err.message);
  }

  try {
    const curMes  = new Date().getMonth() + 1;
    const curAnio = new Date().getFullYear();
    const r = await api.request('/api/sync/check-cierre', {
      method: 'POST',
      body: { ejercicio: curAnio, mes: curMes }
    });
    if (r.cerrados && r.cerrados.length > 0) {
      for (const c of r.cerrados) {
        if (!c.skipped) log.info(`✓ Cierre automático: ${c.mes}/${c.ejercicio} — ${c.ghs_count} GHs`);
      }
    } else {
      log.info('Cierre mensual: sin meses nuevos que cerrar');
    }
  } catch (err) {
    log.warn('Cierre mensual omitido:', err.message);
  }

  try {
    const ticketActual   = await farmatic.fetchTicketMedio(new Date().getFullYear());
    const ticketAnterior = await farmatic.fetchTicketMedio(new Date().getFullYear() - 1);
    const allTicket      = [...ticketActual, ...ticketAnterior];
    if (allTicket.length > 0) {
      const r = await api.request('/api/sync/ticket-medio', { method: 'POST', body: { datos: allTicket } });
      log.info(`✓ Ticket medio: ${r.upserts} registros`);
    }
  } catch (err) {
    log.warn('Ticket medio omitido:', err.message);
  }

  try {
    const vendedores = await farmatic.fetchVendedoresFarmatic();
    if (vendedores.length > 0) {
      const r = await api.request('/api/sync/vendedores', { method: 'POST', body: { vendedores } });
      log.info(`✓ Vendedores: ${r.upserts} registros`);
    }
  } catch (err) {
    log.warn('Sync vendedores omitido:', err.message);
  }

  await syncEncargos();

  try {
    const pool = await farmatic.getPool();
    await syncCronicos(pool, api, log);
  } catch (err) {
    log.warn('syncCronicos omitido:', err.message);
  }

  try {
    const pool = await farmatic.getPool();
    await syncNuevosCronicos(pool, api, log);
  } catch (err) {
    log.warn('syncNuevosCronicos omitido:', err.message);
  }

  try {
    await syncCronicosAlertas(api, log);
  } catch (err) {
    log.warn('syncCronicosAlertas omitido:', err.message);
  }

  try {
    await syncCronicosClientes(api, log);
  } catch (err) {
    log.warn('syncCronicosClientes omitido:', err.message);
  }

  try {
    await syncEncargosVencidos(api, log);
  } catch (err) {
    log.warn('syncEncargosVencidos omitido:', err.message);
  }

  try {
    const tenantId = process.env.TENANT_ID;
    if (tenantId) {
      const { cambios } = await api.getCambiosPendientes(tenantId);
      if (cambios && cambios.length > 0) {
        log.info('Cambios pendientes: ' + cambios.length + ' a procesar');
        const r = await farmatic.procesarCambiosPendientes(cambios);
        log.info(`Cambios procesados: ${r.procesados} OK, ${r.errores} errores`);
        if (r.ids_procesados && r.ids_procesados.length > 0) {
          await api.marcarCambiosProcesados(tenantId, r.ids_procesados);
        }
      } else {
        log.info('Sin cambios pendientes.');
      }
    }
  } catch (err) {
    log.warn('Cambios pendientes omitidos:', err.message);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info('═══════════════════════════════════════════');
  if (resultados.error.length > 0 || resultados.warn.length > 0) {
    log.info(`Sync completado en ${elapsed}s con avisos:`);
    resultados.warn.forEach(m  => log.warn('  ⚠ ' + m));
    resultados.error.forEach(m => log.error('  ✗ ' + m));
    if (resultados.error.length > 0)
      log.error('Revisa la configuración de conexión o contacta con soporte.');
  } else {
    log.info(`Sync completado correctamente en ${elapsed}s`);
  }
  return { ...resultados, elapsed };
}

async function syncEncargos() {
  try {
    const p = await farmatic.getPool();

    const result = await p.request().query(`
      SELECT TOP 50
        e.IdContador,
        e.XArt_IdArticu AS cn,
        a.Descripcion   AS nombre_articulo,
        e.XCli_IdCliente AS cliente_id,
        e.Vendedor       AS vendedor_id,
        e.Unidades,
        e.FechaRecepcion,
        e.Estado,
        e.Situacion,
        e.NumTicket
      FROM Encargo e
      LEFT JOIN Articu a ON a.IdArticu = e.XArt_IdArticu
      WHERE e.FechaRecepcion >= DATEADD(day, -7, GETDATE())
        AND e.Estado IS NOT NULL
      ORDER BY e.FechaRecepcion DESC
    `).catch(err => { log.warn('syncEncargos falló:', err.message); return { recordset: [] }; });

    if (!result.recordset.length) return;

    const encargos = result.recordset.map(r => ({
      id:           String(r.IdContador),
      cn:           String(r.cn || ''),
      nombre:       r.nombre_articulo || 'Encargo',
      cliente_id:   String(r.cliente_id ?? ''),
      vendedor_id:  r.vendedor_id || null,
      unidades:     r.Unidades || 1,
      fecha_recepcion: r.FechaRecepcion,
      estado:       r.Estado,
    }));

    const resp = await api.request('/api/sync/encargos', {
      method: 'POST',
      body: { encargos }
    });
    log.info(`✓ Encargos: ${resp.tareas_creadas} tareas creadas`);
  } catch (err) {
    log.warn('syncEncargos error:', err.message);
  }
}

async function syncNuevosCronicos(farmaticPool, apiClient, log) {
  const Database = require('better-sqlite3');
  const path     = require('path');
  const dbPath   = process.env.USERDATA_PATH
    ? require('path').join(process.env.USERDATA_PATH, 'cronicos.db')
    : require('path').join(__dirname, 'cronicos.db');
  const db = new Database(dbPath);

  try {
    const result = await farmaticPool.request().query(`
      SELECT
        CAST(r.XClie_IdCliente AS INT) AS id_farmatic,
        c.Nombre    AS nombre,
        c.Apellido1 AS apellido1,
        c.Apellido2 AS apellido2,
        c.Telefono  AS telefono,
        c.Telefono2 AS telefono2
      FROM ClienteRGPD r
      LEFT JOIN Cliente c ON CAST(c.IdCliente AS VARCHAR) = LTRIM(RTRIM(r.XClie_IdCliente))
      WHERE r.OpcRGPD = ${parseInt(process.env.RGPD_OPCION, 10) || 31}
    `).catch(err => { log.warn('RGPD query error:', err.message); return { recordset: [] }; });

    if (!result.recordset.length) return;

    const existentes = new Set(
      db.prepare('SELECT id_farmatic FROM cronicos').all().map(r => r.id_farmatic)
    );
    const nuevos = result.recordset.filter(r => !existentes.has(r.id_farmatic));

    if (!nuevos.length) {
      log.info('Crónicos RGPD: sin nuevas fidelizaciones');
      return;
    }

    log.info(`Crónicos RGPD: ${nuevos.length} nuevas fidelizaciones detectadas`);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO cronicos (id_farmatic, nombre, apellido1, apellido2, telefono, consentimiento)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        insert.run(r.id_farmatic, r.nombre || '', r.apellido1 || '', r.apellido2 || '', r.telefono || r.telefono2 || '');
      }
    });
    tx(nuevos);

    for (const n of nuevos) {
      await apiClient.request('/api/sync/fidelizaciones', {
        method: 'POST',
        body: { id_farmatic: n.id_farmatic }
      }).catch(() => {});
    }

    log.info(`✓ ${nuevos.length} nuevos crónicos añadidos a la BD local`);
  } finally {
    db.close();
  }
}

async function syncCronicosAlertas(apiClient, log) {
  const Database = require('better-sqlite3');
  const dbPath = process.env.USERDATA_PATH
    ? require('path').join(process.env.USERDATA_PATH, 'cronicos.db')
    : require('path').join(__dirname, 'cronicos.db');

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    log.warn('syncCronicosAlertas: cronicos.db no encontrada, omitido');
    return;
  }

  try {
    // Pacientes con medicación que vence en -3..+7 días y consentimiento RGPD
    const alertas = db.prepare(`
      SELECT
        c.id_farmatic,
        TRIM(c.nombre)    AS nombre,
        TRIM(COALESCE(c.apellido1, '')) AS apellido,
        COALESCE(NULLIF(TRIM(c.tel_representante),''), TRIM(c.telefono), '') AS telefono,
        CASE WHEN COUNT(m.cn) = 1
          THEN MAX(m.cn)
          ELSE COUNT(m.cn) || ' medicamentos'
        END AS medicamento,
        CAST(MIN(julianday(m.fecha_estimada_salida)) - julianday('now') AS INTEGER) AS dias
      FROM cronicos c
      JOIN cronicos_medicacion m ON m.id_farmatic = c.id_farmatic
      WHERE c.consentimiento = 1
        AND COALESCE(c.activo, 1) = 1
        AND m.aviso_enviado = 0
        AND julianday(m.fecha_estimada_salida) - julianday('now') <= 7
        AND julianday(m.fecha_estimada_salida) - julianday('now') >= -3
      GROUP BY c.id_farmatic
      ORDER BY dias ASC
    `).all();

    if (!alertas.length) {
      log.info('Crónicos alertas: sin pacientes próximos a quedarse sin stock');
      return;
    }

    const r = await apiClient.request('/api/sync/cronicos-alertas', {
      method: 'POST',
      body: { alertas }
    });
    log.info(`✓ Crónicos: ${r.avisos_actualizados} avisos · ${r.tareas_creadas} tareas nuevas`);
  } catch (err) {
    log.warn('syncCronicosAlertas omitido:', err.message);
  } finally {
    db.close();
  }
}

async function syncEncargosVencidos(apiClient, log) {
  try {
    const r = await apiClient.request('/api/sync/encargos-vencidos', { method: 'POST', body: {} });
    if (r.actualizados > 0) log.info(`✓ Encargos vencidos: ${r.actualizados} con fase devolver generada`);
  } catch (err) {
    log.warn('syncEncargosVencidos error:', err.message);
  }
}

module.exports = { runSync };
