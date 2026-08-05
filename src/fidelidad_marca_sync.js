/**
 * fidelidad_marca_sync.js — Detecta pacientes que compran siempre el mismo CN no óptimo
 * de un grupo homogéneo (fidelidad de marca) y cuánto margen se pierde con cada uno.
 *
 * RGPD: el cruce venta↔paciente↔producto se hace 100% aquí, en local — igual que
 * cronicos_medicacion (ver cronicos_sync.js), ese cruce nunca sale de la farmacia tal cual.
 * A Railway solo se envían dos cosas:
 *   (a) detalle CON NOMBRE de los pacientes que ya están en el programa de crónicos con
 *       consentimiento explícito (mismo patrón que syncCronicosClientes).
 *   (b) un agregado anónimo (cuántos pacientes, cuánto margen) para TODOS los casos
 *       detectados, con o sin consentimiento — así el titular ve el impacto real aunque
 *       nadie haya dado consentimiento todavía (mismo patrón que syncClientesResumen).
 */

const Database = require('better-sqlite3');
const path = require('path');

function getDbPath() {
  if (process.env.USERDATA_PATH) return path.join(process.env.USERDATA_PATH, 'cronicos.db');
  return path.join(__dirname, 'cronicos.db');
}

const VENTANA_MESES = 6;
// Umbrales para considerar "fidelidad de marca" real, no ruido de una compra puntual:
const DOMINANCIA_MIN = 0.8; // ≥80% de sus unidades del GH son siempre el mismo CN
const MESES_MIN = 3;        // presente en al menos 3 de los VENTANA_MESES meses

async function syncFidelidadMarca(farmaticPool, apiClient, log) {
  let margen;
  try {
    margen = await apiClient.request('/api/sync/margen-por-cn');
  } catch (e) {
    log.warn('Fidelidad de marca: no se pudo leer margen-por-cn de Railway, omitido:', e.message);
    return;
  }
  if (!margen?.ghs?.length) {
    log.info('Fidelidad de marca: sin grupos homogéneos con margen calculado todavía, omitido');
    return;
  }
  const ghPorCh = new Map(margen.ghs.map(g => [g.ch, g]));         // ch → {cn_optimo, mu_optimo, gh_nombre}
  const muPorCn = new Map(margen.cns.map(c => [String(c.cn), c])); // cn → {ch, mu}
  if (!muPorCn.size) return;

  // Ventas del paciente por CN y mes — se trae TODO lo vendido a clientes identificados
  // en la ventana (no se filtra por CN en SQL Server, evita una IN-list de miles de
  // códigos); el filtro "¿pertenece a un GH?" se hace después, en memoria, con muPorCn.
  const ventasR = await farmaticPool.request().query(`
    SELECT v.XClie_IdCliente AS id_farmatic, lv.Codigo AS cn, v.Ejercicio AS ejercicio, v.Mes AS mes,
           SUM(lv.Cantidad) AS uds
    FROM LineaVenta lv
    INNER JOIN Venta v ON v.IdVenta = lv.IdVenta
    WHERE v.TipoVenta = 'C' AND v.XClie_IdCliente > 0
      AND v.FechaHora >= DATEADD(month, -${VENTANA_MESES}, GETDATE())
    GROUP BY v.XClie_IdCliente, lv.Codigo, v.Ejercicio, v.Mes
  `).catch(err => { log.warn('Fidelidad de marca: query de ventas falló:', err.message); return { recordset: [] }; });

  if (!ventasR.recordset.length) {
    log.info('Fidelidad de marca: sin ventas recientes a clientes identificados');
    return;
  }

  // Agrupar en memoria: paciente+ch → unidades por CN + meses en los que compró algo de ese GH.
  const porPacienteCh = new Map();
  for (const r of ventasR.recordset) {
    const info = muPorCn.get(String(r.cn));
    if (!info) continue; // CN sin grupo homogéneo (venta libre) — no entra en este análisis
    const key = `${r.id_farmatic}:${info.ch}`;
    if (!porPacienteCh.has(key)) {
      porPacienteCh.set(key, { id_farmatic: r.id_farmatic, ch: info.ch, porCn: new Map(), meses: new Set() });
    }
    const entry = porPacienteCh.get(key);
    const cnKey = String(r.cn);
    const acc = entry.porCn.get(cnKey) || { uds: 0 };
    acc.uds += Number(r.uds) || 0;
    entry.porCn.set(cnKey, acc);
    entry.meses.add(`${r.ejercicio}-${r.mes}`);
  }

  // Detectar fidelidad: el CN que concentra ≥80% de las unidades del paciente en ese GH,
  // presente en ≥3 meses distintos de la ventana, y que NO es el CN óptimo del grupo.
  const casos = [];
  for (const { id_farmatic, ch, porCn, meses } of porPacienteCh.values()) {
    const ghInfo = ghPorCh.get(ch);
    if (!ghInfo) continue;
    const totalUds = [...porCn.values()].reduce((s, v) => s + v.uds, 0);
    if (!totalUds) continue;

    let dominanteCn = null, dominanteUds = 0;
    for (const [cn, v] of porCn) {
      if (v.uds > dominanteUds) { dominanteUds = v.uds; dominanteCn = cn; }
    }
    if (!dominanteCn) continue;
    if (dominanteUds / totalUds < DOMINANCIA_MIN) continue;
    if (meses.size < MESES_MIN) continue;
    if (String(dominanteCn) === String(ghInfo.cn_optimo)) continue; // ya compra el óptimo

    const infoDominante = muPorCn.get(dominanteCn);
    if (!infoDominante) continue;
    const deltaMu = ghInfo.mu_optimo - infoDominante.mu;
    if (deltaMu <= 0) continue; // el "dominante" ya iguala/supera el óptimo, no hay pérdida real

    const mesesFidelidad = meses.size;
    const udsMensuales = dominanteUds / mesesFidelidad;
    casos.push({
      id_farmatic, ch, gh_nombre: ghInfo.gh_nombre,
      cn_actual: Number(dominanteCn), cn_optimo: ghInfo.cn_optimo,
      uds_mensuales: +udsMensuales.toFixed(2),
      perdida_mensual_eur: +(udsMensuales * deltaMu).toFixed(2),
      meses_fidelidad: mesesFidelidad,
    });
  }

  if (!casos.length) {
    log.info('Fidelidad de marca: ningún caso detectado en esta sincronización');
  }

  // Descripciones de producto — solo para los CN que aparecen en los casos detectados.
  const cnsDescribir = [...new Set(casos.flatMap(c => [c.cn_actual, c.cn_optimo]))];
  const descPorCn = new Map();
  if (cnsDescribir.length) {
    const descR = await farmaticPool.request().query(`
      SELECT IdArticu AS cn, Descripcion AS descripcion FROM Articu WHERE IdArticu IN (${cnsDescribir.join(',')})
    `).catch(() => ({ recordset: [] }));
    for (const r of descR.recordset) descPorCn.set(String(r.cn), r.descripcion);
  }

  // Nombre/apellido/teléfono SOLO para pacientes ya en el programa de crónicos con
  // consentimiento explícito — el resto entra únicamente en el agregado anónimo de abajo.
  let consentidos = new Map();
  try {
    const db = new Database(getDbPath(), { readonly: true });
    try {
      const rows = db.prepare(`SELECT id_farmatic, nombre, apellido1, telefono FROM cronicos WHERE consentimiento=1 AND activo=1`).all();
      consentidos = new Map(rows.map(r => [String(r.id_farmatic), r]));
    } finally {
      db.close();
    }
  } catch {
    // cronicos.db o la tabla cronicos pueden no existir todavía si nunca se usó ese módulo
  }

  const casosDetalle = [];
  for (const c of casos) {
    const consentido = consentidos.get(String(c.id_farmatic));
    if (!consentido) continue;
    casosDetalle.push({
      ...c,
      nombre: consentido.nombre || null,
      apellido: consentido.apellido1 || null,
      telefono: consentido.telefono || null,
      descripcion_actual: descPorCn.get(String(c.cn_actual)) || null,
      descripcion_optimo: descPorCn.get(String(c.cn_optimo)) || null,
    });
  }

  // Se manda SIEMPRE, incluso vacío — si un paciente antes calificaba y ya no (cambió de
  // favorito, dejó de venir), el backend debe poder BORRAR su fila vieja; si solo se llama
  // cuando hay casos, un titular vería un caso "fantasma" para siempre.
  await apiClient.request('/api/sync/fidelidad-marca-clientes', { method: 'POST', body: { casos: casosDetalle } })
    .then(r => log.info(`✓ Fidelidad de marca: ${r.actualizados} pacientes con consentimiento con detalle (de ${casos.length} casos totales)`))
    .catch(err => log.warn('fidelidad-marca-clientes sync error:', err.message));

  // Agregado anónimo SIEMPRE (incluye a los pacientes con y sin consentimiento, y el caso
  // 0/0 para corregir un resumen viejo si ya no hay ningún caso) — así el titular ve el
  // impacto total real, sea el que sea, no uno desactualizado.
  const totalPerdida = casos.reduce((s, c) => s + c.perdida_mensual_eur, 0);
  const porGh = new Map();
  for (const c of casos) {
    const acc = porGh.get(c.ch) || { ch: c.ch, gh_nombre: c.gh_nombre, n_pacientes: 0, perdida_mensual_eur: 0 };
    acc.n_pacientes++;
    acc.perdida_mensual_eur += c.perdida_mensual_eur;
    porGh.set(c.ch, acc);
  }
  const topGrupos = [...porGh.values()]
    .map(g => ({ ...g, perdida_mensual_eur: +g.perdida_mensual_eur.toFixed(2) }))
    .sort((a, b) => b.perdida_mensual_eur - a.perdida_mensual_eur)
    .slice(0, 15);

  await apiClient.request('/api/sync/fidelidad-marca-resumen', {
    method: 'POST',
    body: { total_pacientes: casos.length, total_perdida_mensual_eur: +totalPerdida.toFixed(2), top_grupos: topGrupos },
  })
    .then(() => log.info(`✓ Fidelidad de marca: resumen agregado enviado (${casos.length} pacientes, ${totalPerdida.toFixed(0)}€/mes)`))
    .catch(err => log.warn('fidelidad-marca-resumen sync error:', err.message));
}

module.exports = { syncFidelidadMarca };
