/**
 * sync.js — Orquestador de sincronización.
 * Exporta runSync() para ser invocado por Electron (main.js) o por CLI.
 */

const farmatic = require('./farmatic-client');
const api      = require('./api-client');
const log      = require('./logger');
const { syncCronicos, syncCronicosClientes, syncClientesResumen } = require('./cronicos_sync');

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

async function runSync(opts = {}) {
  const { onStep } = opts;
  const step = (key, label, status) => onStep?.({ key, label, status });

  const t0 = Date.now();
  log.info('═══════════════════════════════════════════');
  log.info('Iniciando sincronización');

  // Track partial results to inform the user at the end
  const resultados = { ok: [], warn: [], error: [] };
  let listasCreadas = null; // {categoria: nuevoId} si se crearon listas de categoría este ciclo
  const ok   = (msg) => { resultados.ok.push(msg);    log.info('✓ ' + msg); };
  const warn = (msg) => { resultados.warn.push(msg);  log.warn('⚠ ' + msg); };
  const err  = (msg) => { resultados.error.push(msg); log.error('✗ ' + msg); };

  // ── PASO 1: Verificar API ────────────────────────────────────────────
  step('api', 'Verificando conexión con NextFarma…', 'running');
  try {
    const s = await api.status();
    ok(`API conectada · Farmacia: ${s.tenant?.nombre || '—'}`);
    step('api', `API OK · ${s.tenant?.nombre || '—'}`, 'ok');
  } catch (e) {
    err('API inalcanzable: ' + e.message);
    step('api', 'API inalcanzable — verifica la conexión a internet', 'error');
    err('Sync cancelado: sin conexión con NextFarma.');
    return { ...resultados, elapsed: '0s' };
  }

  // ── PASO 1b: Barrido de esquema Farmatic ─────────────────────────────
  // Se cachea por ciclo (farmatic.resetSchemaCache() la limpia en cada runSync)
  // y se manda a NextFarma para poder ver de qué tablas/columnas dispone esta
  // instalación concreta sin depender de que la farmacia pegue logs.
  farmatic.resetSchemaCache();
  try {
    const schema = await farmatic.discoverSchema();
    // Calidad de datos (filas totales + nulos por columna) es una consulta
    // pesada — discoverDataQuality se autolimita a una vez al día y devuelve
    // null el resto de ciclos, así que esto no ralentiza cada sync.
    const calidad = await farmatic.discoverDataQuality(schema).catch(e => {
      log.warn('discoverDataQuality omitido:', e.message);
      return null;
    });
    // Distribución de códigos OpcRGPD + el código que este agente tiene configurado como
    // "consentimiento firmado" — permite ver desde Railway si están desalineados sin pedirle
    // a la farmacia que pulse el botón de verificación del asistente.
    const rgpdDistribucion = await farmatic.fetchRGPDDistribucion();
    const rgpd = rgpdDistribucion
      ? { opcion_configurada: parseInt(process.env.RGPD_OPCION, 10) || 31, distribucion: rgpdDistribucion }
      : null;
    // Listas de artículos reales (id + nombre + nº de ítems) — permite ver desde Railway
    // qué listas usa esta farmacia y con cuántos artículos, sin depender de que el wizard
    // de Listas se haya rellenado ni de preguntarle a la farmacia cómo organiza sus favoritos.
    const listasFarmatic = await farmatic.fetchListasWizard().catch(e => {
      log.warn('fetchListasWizard (diagnóstico) omitido:', e.message);
      return null;
    });
    await api.enviarSchemaInfo({
      ...schema,
      ...(calidad ? { calidad } : {}),
      ...(rgpd ? { rgpd } : {}),
      ...(listasFarmatic ? { listas: listasFarmatic } : {}),
    });
  } catch (e) {
    log.warn('Barrido de esquema omitido:', e.message);
  }

  api.resetAbort();
  const sendPing = async (status, elapsedS) => {
    try {
      await api.request('/api/sync/ping', {
        method: 'POST',
        body: {
          status,
          duration_s: Math.round(parseFloat(elapsedS)),
          warnings:   resultados.warn.length,
          errors:     resultados.error.length,
        },
      });
    } catch (e) {
      log.warn('sync/ping omitido:', e.message);
    }
  };

  const anioActual   = new Date().getFullYear();
  const anioAnterior = anioActual - 1;
  let todasVentas    = [];
  let sinFiltroFacturada = false;
  const origWarn = log.warn.bind(log);
  const warnProxy = (msg, ...args) => {
    if (typeof msg === 'string' && msg.includes('no se detectó columna Facturada')) sinFiltroFacturada = true;
    origWarn(msg, ...args);
  };

  // ── PASO 2: Leer ventas de Farmatic ─────────────────────────────────
  step('ventas', 'Leyendo ventas de Farmatic…', 'running');
  log.warn = warnProxy;
  try {
    const vActual   = await farmatic.fetchVentasMensuales(anioActual);
    const vAnterior = await farmatic.fetchVentasMensuales(anioAnterior);
    todasVentas = [...vActual, ...vAnterior];
    ok(`Ventas: ${vActual.length} (${anioActual}) + ${vAnterior.length} (${anioAnterior})`);
    if (sinFiltroFacturada) warn('Columna Facturada no detectada en Farmatic — ventas incluyen borradores/anulados');
    step('ventas', `Ventas: ${vActual.length} este año · ${vAnterior.length} año anterior`, 'ok');
  } catch (e) {
    warn('Ventas no disponibles: ' + e.message + ' — Los análisis de ventas no se actualizarán.');
    step('ventas', 'Ventas no disponibles — análisis de ventas omitido. Verifica la tabla Venta/LineaVenta en Farmatic.', 'warn');
  } finally {
    log.warn = origWarn;
  }

  // ── PASO 3: Leer catálogo de Farmatic ───────────────────────────────
  let productos = [];
  step('catalogo', 'Leyendo catálogo de productos…', 'running');
  try {
    productos = await farmatic.fetchProductos();
    ok(`${productos.length} productos leídos`);
    const sinPvl = productos.filter(p => !p.pvl).length;
    const sinDto = productos.filter(p => !p.dto).length;
    if (sinPvl > 0) warn(`${sinPvl} productos sin PVL — precio de compra se estimará por ratio`);
    if (sinDto > 0 && sinDto < productos.length * 0.5)
      warn(`${sinDto} productos sin descuento Cofares — SC no calculable para esos CNs`);
    step('catalogo', `Catálogo: ${productos.length} productos leídos`, 'ok');
  } catch (e) {
    warn('Catálogo de productos no disponible: ' + e.message + ' — El resto del sync continúa.');
    step('catalogo', 'Catálogo no disponible — verifica la tabla Articu en Farmatic', 'warn');
  }

  // ── PASO 4: Leer recepciones (precios reales de albarán) ────────────
  let recepciones = [];
  step('recepciones', 'Leyendo recepciones de albarán…', 'running');
  try {
    recepciones = await farmatic.fetchRecepcionesRecientes(12);
    log.info(`✓ ${recepciones.length} recepciones leídas (último año)`);
    step('recepciones', `Recepciones: ${recepciones.length} albaranes leídos`, 'ok');
  } catch (e) {
    log.warn('Recepciones no disponibles:', e.message);
    step('recepciones', 'Recepciones no disponibles — precios de albarán omitidos', 'warn');
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
  } catch (e) {
    log.warn('4DB omitido:', e.message);
  }

  // Priority 2: LineaRecep.bonificacion — last real albaran discount, for products still without dto
  if (recepciones.length > 0) {
    const mapRecep = new Map(recepciones.map(r => [r.codigo_nacional, r]));
    let nRecep = 0;
    for (const prod of productos) {
      if (prod.dto > 0) continue;
      const r = mapRecep.get(prod.codigo_nacional);
      if (!r || r.bonificacion == null || r.bonificacion <= 0) continue;
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

  // ── PASO 5: Enviar catálogo a NextFarma ─────────────────────────────
  if (productos.length > 0) {
    step('env-cat', 'Enviando catálogo a NextFarma…', 'running');
    try {
      const r = await api.enviarProductos(productos);
      ok(`Productos: ${r.inserted} nuevos, ${r.updated} actualizados${r.errors > 0 ? `, ${r.errors} errores` : ''}`);
      if (r.errors > 0) warn(`${r.errors} productos rechazados por la API — puede haber CNs con datos incompletos`);
      step('env-cat', `Catálogo: ${r.inserted} nuevos · ${r.updated} actualizados`, r.errors > 0 ? 'warn' : 'ok');
    } catch (e) {
      err('Error enviando productos: ' + e.message);
      step('env-cat', 'Error enviando catálogo: ' + e.message, 'error');
    }
  } else {
    warn('Sin productos que enviar — el catálogo no se actualizará');
    step('env-cat', 'Sin catálogo que enviar', 'warn');
  }

  // ── PASO 6: Enviar ventas a NextFarma ───────────────────────────────
  if (todasVentas.length > 0) {
    step('env-ven', 'Enviando ventas a NextFarma…', 'running');
    try {
      const r = await api.enviarVentas(todasVentas);
      ok(`Ventas: ${r.upserts} actualizadas${r.errors > 0 ? `, ${r.errors} errores` : ''}`);
      step('env-ven', `Ventas: ${r.upserts} registros enviados`, r.errors > 0 ? 'warn' : 'ok');
    } catch (e) {
      err('Error enviando ventas: ' + e.message);
      step('env-ven', 'Error enviando ventas: ' + e.message, 'error');
    }
  } else {
    warn('Sin ventas que enviar — tablas Venta/LineaVenta no accesibles o vacías');
    step('env-ven', 'Sin ventas que enviar', 'warn');
  }

  try {
    const vAnuales = await farmatic.fetchVentasAnuales(anioAnterior);
    if (vAnuales.length > 0) {
      const r = await api.enviarVentas(vAnuales);
      log.info(`✓ Ventas anuales ${anioAnterior}: ${r.upserts} actualizadas`);
    }
  } catch (e) {
    log.warn('Ventas anuales omitidas:', e.message);
  }

  if (recepciones.length > 0) {
    try {
      const r = await api.enviarRecepciones(recepciones);
      log.info(`✓ Recepciones: ${r.upserts} productos con precio real de albarán`);
    } catch (e) {
      log.warn('Error enviando recepciones:', e.message);
    }
  } else {
    log.info('Recepciones: sin datos o tablas no disponibles.');
  }

  if (api.isAbortRequested()) {
    warn('Sync cancelado por el usuario — se omite el resto del ciclo.');
    step('misc', 'Sync cancelado por el usuario', 'warn');
    const elapsedAbort = ((Date.now() - t0) / 1000).toFixed(1);
    log.info(`Sync cancelado tras ${elapsedAbort}s`);
    await sendPing('cancelled', elapsedAbort);
    return { ...resultados, elapsed: elapsedAbort, cancelled: true };
  }

  // ── PASO 7: Favoritos, cierre, ticket medio, vendedores ─────────────
  step('misc', 'Favoritos, cierre mensual, ticket medio…', 'running');
  try {
    const favoritos = await farmatic.fetchFavoritosListas();
    if (favoritos.length > 0) {
      const r = await api.enviarFavoritos(favoritos);
      log.info(`✓ Favoritos: ${r.updated} GHs actualizados desde listas de Farmatic`);
    } else {
      log.warn('Favoritos: no se encontraron ítems en las listas de Farmatic.');
    }
  } catch (e) {
    log.warn('Favoritos omitidos:', e.message);
  }

  try {
    const favActuales = await farmatic.fetchFavoritosActuales();
    if (favActuales.size > 0) {
      const cambios = [];
      for (const [ch, cn] of favActuales) cambios.push({ ch, cn_favorito: cn });
      const r = await api.request('/api/sync/favoritos-historico', { method: 'POST', body: { cambios } });
      log.info(`✓ Favoritos histórico: ${r.upserts} registros actualizados`);
    }
  } catch (e) {
    log.warn('Favoritos histórico omitido:', e.message);
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
  } catch (e) {
    log.warn('Cierre mensual omitido:', e.message);
  }

  try {
    const ticketActual   = await farmatic.fetchTicketMedio(new Date().getFullYear());
    const ticketAnterior = await farmatic.fetchTicketMedio(new Date().getFullYear() - 1);
    const allTicket      = [...ticketActual, ...ticketAnterior];
    if (allTicket.length > 0) {
      const r = await api.request('/api/sync/ticket-medio', { method: 'POST', body: { datos: allTicket } });
      log.info(`✓ Ticket medio: ${r.upserts} registros`);
    }
  } catch (e) {
    log.warn('Ticket medio omitido:', e.message);
  }

  try {
    const vendedores = await farmatic.fetchVendedoresFarmatic();
    if (vendedores.length > 0) {
      const r = await api.request('/api/sync/vendedores', { method: 'POST', body: { vendedores } });
      log.info(`✓ Vendedores: ${r.upserts} registros`);
    } else {
      warn('Vendedores: 0 activos encontrados en la tabla Vendedor de Farmatic (excluyendo IdVendedor=99) — revisa que existan vendedores dados de alta y sin baja.');
    }
  } catch (e) {
    log.warn('Sync vendedores omitido:', e.message);
  }

  step('misc', 'Favoritos y datos auxiliares enviados', 'ok');

  // ── PASO 8: Crónicos, encargos, cambios pendientes ─────────────────
  step('cronicos', 'Sincronizando encargos y crónicos RGPD…', 'running');

  await syncEncargos();

  try {
    const pool = await farmatic.getPool();
    await syncCronicos(pool, api, log);
  } catch (e) {
    log.warn('syncCronicos omitido:', e.message);
  }

  try {
    const pool = await farmatic.getPool();
    await syncNuevosCronicos(pool, api, log);
  } catch (e) {
    log.warn('syncNuevosCronicos omitido:', e.message);
  }

  try {
    await syncCronicosAlertas(api, log);
  } catch (e) {
    log.warn('syncCronicosAlertas omitido:', e.message);
  }

  try {
    await syncCronicosClientes(api, log);
  } catch (e) {
    log.warn('syncCronicosClientes omitido:', e.message);
  }

  try {
    await syncClientesResumen(api, log);
  } catch (e) {
    log.warn('syncClientesResumen omitido:', e.message);
  }

  try {
    await syncEncargosVencidos(api, log);
  } catch (e) {
    log.warn('syncEncargosVencidos omitido:', e.message);
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
  } catch (e) {
    log.warn('Cambios pendientes omitidos:', e.message);
  }

  try {
    const tenantId = process.env.TENANT_ID;
    if (tenantId) {
      const { cambios } = await api.getListaNegraPendiente(tenantId);
      if (cambios && cambios.length > 0) {
        log.info('Lista Negra: ' + cambios.length + ' cambios a procesar');
        const r = await farmatic.procesarListaNegraPendiente(cambios);
        log.info(`Lista Negra procesada: ${r.procesados} OK, ${r.errores} errores`);
        if (r.ids_procesados && r.ids_procesados.length > 0) {
          await api.marcarListaNegraProcesada(tenantId, r.ids_procesados);
        }
      }
    }
  } catch (e) {
    log.warn('Lista Negra omitida:', e.message);
  }

  // Auto-creación de listas de categoría cuando esta instalación no usa Listas de
  // Farmatic para favoritos. Doble candado, por defecto todo apagado: solo corre si el
  // tenant tiene farmatic_write_enabled Y farmatic_autocrear_listas activos en Railway
  // (ver [[project_sync_electron]] — jose no la necesita y se queda desactivada como
  // el resto hasta que se active a mano en algún tenant piloto), y solo si de verdad no
  // hay ninguna lista real en Farmatic (si hubiera alguna sin mapear, no se toca nada).
  try {
    if (!farmatic.getCategoriaLista()) {
      const cfgTenant = await api.obtenerConfigSync();
      if (cfgTenant.farmatic_write_enabled && cfgTenant.farmatic_autocrear_listas) {
        const listasExistentes = await farmatic.fetchListasWizard();
        if (!listasExistentes || listasExistentes.length === 0) {
          const categorias = await api.obtenerCategoriasActuales();
          const resultado = await farmatic.crearListasCategoriaYFavoritosIniciales(categorias);
          if (resultado?.creadas?.length) {
            listasCreadas = Object.fromEntries(resultado.creadas.map(c => [c.categoria, c.lista_id]));
            await api.reportarListasCreadas(resultado);
            log.info(`✓ Listas de favoritos creadas en Farmatic: ${resultado.creadas.length}`);
          }
        }
      }
    }
  } catch (e) {
    log.warn('Auto-creación de listas omitida:', e.message);
  }

  step('cronicos', 'Crónicos y encargos sincronizados', 'ok');

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

  await sendPing(resultados.error.length > 0 ? 'error' : resultados.warn.length > 0 ? 'warn' : 'ok', elapsed)

  return { ...resultados, elapsed, listasCreadas };
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
    `).catch(e => { log.warn('syncEncargos falló:', e.message); return { recordset: [] }; });

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
  } catch (e) {
    log.warn('syncEncargos error:', e.message);
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
    // El esquema de Cliente varía mucho entre instalaciones de Farmatic — se detectan
    // las columnas reales en vez de asumir nombres fijos (mismo patrón que
    // fetchProductos()/fetchVendedoresFarmatic()). Caso real (farmacia jose): no existen
    // Nombre/Apellido1/Apellido2/Telefono/IdCliente — en su lugar hay PER_NOMBRE/
    // FIS_NOMBRE (nombre personal vs. fiscal/facturación), PER_TELEFONO/FIS_TELEFONO
    // e IDCLIENTE. Se prioriza siempre la variante "personal" sobre la "fiscal": la
    // fiscal puede ser una empresa o un familiar distinto del paciente real.
    const colsR = await farmaticPool.request().query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Cliente'`
    ).catch(() => ({ recordset: [] }));
    const colsCliente = new Set(colsR.recordset.map(r => String(r.COLUMN_NAME)));
    const pick = (...candidatos) => {
      const encontrada = candidatos.find(c => colsCliente.has(c));
      return encontrada ? `c.${encontrada}` : 'NULL';
    };
    const selNombre    = pick('Nombre', 'PER_NOMBRE', 'FIS_NOMBRE');
    const selApellido1 = pick('Apellido1');
    const selApellido2 = pick('Apellido2');
    const selTelefono  = pick('Telefono', 'PER_TELEFONO', 'FIS_TELEFONO');
    const selTelefono2 = pick('Telefono2');
    const colIdCliente = colsCliente.has('IdCliente') ? 'IdCliente' : colsCliente.has('IDCLIENTE') ? 'IDCLIENTE' : 'IdCliente';

    const result = await farmaticPool.request().query(`
      SELECT
        CAST(r.XClie_IdCliente AS INT) AS id_farmatic,
        ${selNombre}    AS nombre,
        ${selApellido1} AS apellido1,
        ${selApellido2} AS apellido2,
        ${selTelefono}  AS telefono,
        ${selTelefono2} AS telefono2
      FROM ClienteRGPD r
      LEFT JOIN Cliente c ON CAST(c.${colIdCliente} AS VARCHAR) = LTRIM(RTRIM(r.XClie_IdCliente))
      WHERE r.OpcRGPD = ${parseInt(process.env.RGPD_OPCION, 10) || 31}
    `).catch(e => { log.warn('RGPD query error:', e.message); return { recordset: [] }; });

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
  } catch (e) {
    log.warn('syncCronicosAlertas omitido:', e.message);
  } finally {
    db.close();
  }
}

async function syncEncargosVencidos(apiClient, log) {
  try {
    const r = await apiClient.request('/api/sync/encargos-vencidos', { method: 'POST', body: {} });
    if (r.actualizados > 0) log.info(`✓ Encargos vencidos: ${r.actualizados} con fase devolver generada`);
  } catch (e) {
    log.warn('syncEncargosVencidos error:', e.message);
  }
}

module.exports = { runSync };
