/**
 * farmatic-client.js — Cliente SQL Server para Farmatic + BD del Consejo.
 * Compatible con cualquier instalación de Farmatic (no hay IDs hardcodeados).
 */

const sql  = require('mssql');
const log  = require('./logger');
const path = require('path');
const fs   = require('fs');

let XLSX;
try { XLSX = require('xlsx'); } catch { XLSX = null; }

const IVA_MEDICAMENTOS = 0.04;
const RE               = 0.005;
const PVL_FACTOR       = 0.6406;

// SC constants: configurable via env (set by wizard)
const UMBRAL_SC       = () => parseFloat(process.env.SC_UMBRAL)       || 2500;
const SC_CINFA_NORMON = () => parseFloat(process.env.SC_CINFA_NORMON) || 0.05;
const SC_KERN_TEVA    = () => parseFloat(process.env.SC_KERN_TEVA)    || 0.10;

// Vendor IDs to exclude from sales analysis (99 = autoconsumo por defecto)
const excludedVendors = () =>
  (process.env.EXCLUDED_VENDORS || '99')
    .split(',').map(Number).filter(n => !isNaN(n) && n > 0);

function buildConfig() {
  const instance    = process.env.DB_INSTANCE     || '';
  const windowsAuth = process.env.DB_WINDOWS_AUTH === 'true';
  const cfg = {
    server:   process.env.DB_SERVER || 'localhost',
    database: process.env.DB_NAME   || 'Farmatic',
    options: {
      encrypt:                process.env.DB_ENCRYPT    === 'true',
      trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
      instanceName:           instance || undefined,
      trustedConnection:      windowsAuth,
    },
    connectionTimeout: 30000,   // era 15 000 — muy ajustado para SQL Server Express en arranque en frío
    requestTimeout:    120000,
  };
  // Con named instance el driver resuelve el puerto via SQL Browser; no pasar port explícito
  if (!instance) cfg.port = parseInt(process.env.DB_PORT, 10) || 1433;
  // Windows Auth no usa usuario/contraseña
  if (!windowsAuth) { cfg.user = process.env.DB_USER; cfg.password = process.env.DB_PASSWORD; }
  return cfg;
}

let pool = null;
async function getPool() {
  if (pool) {
    try { await pool.request().query('SELECT 1') }
    catch { pool = null }
  }
  if (!pool) pool = await new sql.ConnectionPool(buildConfig()).connect();
  return pool;
}
async function closePool() {
  if (pool) { await pool.close(); pool = null; }
}

const CONSEJO_DB    = () => process.env.DB_CONSEJO || 'Consejo';
const DESCUENTOS_DIR = () => process.env.DESCUENTOS_DIR || path.join(process.env.USERDATA_PATH || process.cwd(), 'descuentos');

// ── Barrido de esquema ───────────────────────────────────────────────────────
// Farmatic no es uniforme entre instalaciones (tablas/columnas que en unas
// existen y en otras no — el caso real que motivó esto: Vendedor.Baja y
// Cliente.Telefono2 ausentes en una instalación). En vez de descubrir estas
// diferencias una a una cuando algo falla en producción, se hace un barrido al
// principio de cada sync sobre las tablas que el agente usa, y se manda a
// NextFarma para poder diagnosticar instalaciones concretas sin depender de
// que la farmacia pegue logs.
// 'Lista'/'Listas' NO están aquí a propósito: no existen como nombre de tabla real en
// ninguna instalación de Farmatic vista hasta ahora (la tabla de cabeceras de listas se
// llama ListaArticu, ya incluida) — tenerlas en la lista solo generaba un falso "tabla
// esperada faltante" en todas las farmacias, sin ser un problema real.
const TABLAS_ESPERADAS = [
  'Articu', 'GeneArti', 'LineaVenta', 'Venta', 'Vendedor', 'Cliente', 'ClienteRGPD',
  'Recep', 'LineaRecep', 'ListaArticu', 'ItemListaArticu',
  '_4DB_CAT_CatalogoArt', '_4DB_CAT_Models',
];

let schemaCache = null;
function resetSchemaCache() { schemaCache = null; }

async function discoverSchema() {
  if (schemaCache) return schemaCache;
  const p   = await getPool();
  const cdb = CONSEJO_DB();
  const tablas = {};

  try {
    const tablasR = await p.request().query(
      `SELECT name FROM sys.tables WHERE name IN (${TABLAS_ESPERADAS.map(t => `'${t}'`).join(',')})`
    );
    const existentes = new Set(tablasR.recordset.map(r => r.name));
    if (existentes.size > 0) {
      const colsR = await p.request().query(`
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME IN (${[...existentes].map(t => `'${t}'`).join(',')})
      `);
      for (const t of existentes) tablas[t] = [];
      for (const row of colsR.recordset) tablas[row.TABLE_NAME].push({ nombre: row.COLUMN_NAME, tipo: row.DATA_TYPE });
    }

    // BP_CONJARTI/BP_CONJUNTOS viven en la BD del Consejo, no en la de Farmatic.
    const consejoR = await p.request().query(
      `SELECT name FROM ${cdb}.sys.tables WHERE name IN ('BP_CONJARTI','BP_CONJUNTOS')`
    ).catch(() => ({ recordset: [] }));
    const existentesConsejo = new Set(consejoR.recordset.map(r => r.name));
    if (existentesConsejo.size > 0) {
      const colsConsejoR = await p.request().query(`
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ${cdb}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME IN (${[...existentesConsejo].map(t => `'${t}'`).join(',')})
      `).catch(() => ({ recordset: [] }));
      for (const t of existentesConsejo) tablas[t] = [];
      for (const row of colsConsejoR.recordset) tablas[row.TABLE_NAME].push({ nombre: row.COLUMN_NAME, tipo: row.DATA_TYPE });
    }

    const faltantes = TABLAS_ESPERADAS.filter(t => !tablas[t]);
    schemaCache = { tablas, tablas_esperadas_faltantes: faltantes };
    if (faltantes.length > 0) {
      log.warn(`Esquema Farmatic: no se encontraron estas tablas esperadas: ${faltantes.join(', ')}`);
    }
  } catch (err) {
    log.warn('discoverSchema falló:', err.message);
    schemaCache = { tablas: {}, tablas_esperadas_faltantes: TABLAS_ESPERADAS, error: err.message };
  }
  return schemaCache;
}

// ── Calidad de datos por tabla ────────────────────────────────────────────────
// Cuenta filas totales y nulos por columna de las tablas ya descubiertas.
// Nunca sale una fila real, solo números — pensado para detectar en remoto
// instalaciones donde una columna clave viene vacía (el caso real que motivó
// esto: dto_pct NULL en el 96% del catálogo de una farmacia) sin depender de
// que alguien lo reporte. Es una consulta pesada (recorre cada tabla entera),
// así que se limita a una vez al día por instalación, no en cada ciclo.
function ultimaEjecucionPath() {
  const dir = process.env.USERDATA_PATH || __dirname;
  return path.join(dir, 'schema-calidad-last-run.json');
}

function yaCorrioHoy() {
  try {
    const raw = fs.readFileSync(ultimaEjecucionPath(), 'utf8');
    const { fecha } = JSON.parse(raw);
    return fecha === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

function marcarEjecutadoHoy() {
  try {
    fs.writeFileSync(ultimaEjecucionPath(), JSON.stringify({ fecha: new Date().toISOString().slice(0, 10) }));
  } catch { /* no crítico */ }
}

async function discoverDataQuality(schema) {
  if (yaCorrioHoy()) return null;
  const p = await getPool();
  const cdb = CONSEJO_DB();
  const calidad = {};

  for (const [tabla, columnas] of Object.entries(schema.tablas || {})) {
    if (!columnas.length) continue;
    const esConsejo = tabla === 'BP_CONJARTI' || tabla === 'BP_CONJUNTOS';
    const prefijo = esConsejo ? `${cdb}.dbo.` : '';
    const nullExprs = columnas.map(c => `SUM(CASE WHEN [${c.nombre}] IS NULL THEN 1 ELSE 0 END) AS [${c.nombre}]`).join(',\n        ');
    try {
      const r = await p.request().query(`
        SELECT COUNT(*) AS total_filas,
        ${nullExprs}
        FROM ${prefijo}[${tabla}]
      `);
      const row = r.recordset[0] || {};
      calidad[tabla] = {
        total_filas: row.total_filas || 0,
        columnas: columnas.map(c => ({ nombre: c.nombre, tipo: c.tipo, nulos: row[c.nombre] || 0 })),
      };
    } catch (err) {
      log.warn(`discoverDataQuality falló en ${tabla}:`, err.message);
    }
  }
  marcarEjecutadoHoy();
  return calidad;
}

function cargarDescuentosExcel() {
  const dtos = new Map();
  const dir  = DESCUENTOS_DIR();
  if (!XLSX) { log.warn('xlsx no instalado, descuentos Excel omitidos'); return dtos; }
  if (!fs.existsSync(dir)) { log.warn(`Carpeta descuentos no encontrada: ${dir}`); return dtos; }
  const LABS = { cinfa: 'CINFA', kern: 'KERN', teva: 'TEVA', normon: 'NORMON' };
  const archivos = fs.readdirSync(dir).filter(f => f.match(/\.(xlsx|xls)$/i));
  for (const archivo of archivos) {
    const lab = Object.keys(LABS).find(k => archivo.toLowerCase().includes(k));
    if (!lab) continue;
    try {
      const wb   = XLSX.readFile(path.join(dir, archivo));
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
      let cargados = 0;
      for (const row of rows) {
        const cols = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toUpperCase().trim(), v]));
        const cn   = cols['CN'] != null ? String(cols['CN']).trim() : null;
        const dto  = cols['DESCUENTO'] ?? cols['DESCUENTO_2026'] ?? cols['DTO'];
        if (!cn || dto == null) continue;
        const dtoRaw = parseFloat(String(dto).replace(',', '.'));
        if (isNaN(dtoRaw) || dtoRaw <= 0) continue;
        // Cofares exports can be % (5) or decimal (0.05) — normalize to decimal
        const dtoNum = dtoRaw > 1 ? +(dtoRaw / 100).toFixed(4) : +dtoRaw.toFixed(4);
        dtos.set(cn, { dto: dtoNum, lab: LABS[lab] });
        cargados++;
      }
      log.info(`Descuentos ${LABS[lab]}: ${cargados} CNs de ${archivo}`);
    } catch (err) {
      log.error(`Error leyendo ${archivo}:`, err.message);
    }
  }
  return dtos;
}

async function fetchProductos() {
  const p    = await getPool();
  const dtos = cargarDescuentosExcel();

  const colsR = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Articu'`
  );
  const colsArticu = new Set(colsR.recordset.map(r => String(r.COLUMN_NAME)));
  const has     = c => colsArticu.has(c);
  const pickCol = (...candidates) => candidates.find(has) || null;

  const colPvl  = pickCol('Pvl', 'PVL', 'PVLIVA', 'PvlIva', 'PrecioVentaLab', 'PrecioAlmacen');
  const colPuc  = pickCol('Puc', 'PUC', 'PrecioCompra', 'PrecioUltimaCompra');
  const colPmc  = pickCol('Pmc', 'PMC', 'PrecioMedioCompra');
  const colIva  = pickCol('IVA', 'Iva', 'TipoIva', 'TipoIVA', 'XGrup_IdGrupoIva');
  const selPvl  = colPvl ? `a.${colPvl} AS pvl,` : `NULL AS pvl,`;
  const selPuc  = colPuc ? `a.${colPuc} AS puc,` : `NULL AS puc,`;
  const selPmc  = colPmc ? `a.${colPmc} AS pmc,` : `NULL AS pmc,`;
  const selIva  = colIva ? `CAST(a.${colIva} AS VARCHAR(16)) AS iva,` : `NULL AS iva,`;

  log.info(`Columnas Articu: pvl=${colPvl||'—'} puc=${colPuc||'—'} iva=${colIva||'—'}`);

  const cdb = CONSEJO_DB();
  const result = await p.request().query(`
    SELECT
      LTRIM(RTRIM(a.IdArticu))          AS cn,
      LTRIM(RTRIM(a.Descripcion))       AS nombre,
      LTRIM(RTRIM(a.Laboratorio))       AS laboratorio,
      a.Pvp                             AS pvp,
      ${selPvl}
      ${selPuc}
      ${selPmc}
      ${selIva}
      a.Efp                             AS efp,
      a.Receta                          AS receta,
      a.ExcluidoSS                      AS excluido_ss,
      COALESCE((
        SELECT TOP 1 ga2.EFG
        FROM GeneArti ga2
        WHERE LTRIM(RTRIM(ga2.IdArticu)) = LTRIM(RTRIM(a.IdArticu))
        ORDER BY ga2.EFG DESC
      ), 0)                             AS efg,
      CAST(bpc.CODConjunto AS VARCHAR)  AS ch,
      bpj.NOMBRE                        AS gh,
      bpj.PVPMENOR                      AS pvp_menor,
      bpj.TIPO                          AS tipo_conjunto,
      (
        SELECT COUNT(*)
        FROM ${cdb}.dbo.BP_CONJARTI bpc2
        WHERE bpc2.CODConjunto = bpc.CODConjunto AND bpc2.CODCCAA = 0
      ) AS n_en_gh
    FROM Articu a
    LEFT JOIN ${cdb}.dbo.BP_CONJARTI bpc
      ON LTRIM(RTRIM(a.IdArticu)) = LTRIM(RTRIM(bpc.CODIGO)) AND bpc.CODCCAA = 0
    LEFT JOIN ${cdb}.dbo.BP_CONJUNTOS bpj
      ON bpc.CODConjunto = bpj.CODCONJUNTO AND bpj.CODCCAA = 0
    WHERE a.Baja = 0
  `);

  const LABS_SECUNDARIOS = new Set(
    (process.env.LAB_SECUNDARIOS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  );
  const vistos = new Set();
  let descartados = { sinCN: 0, cnInvalido: 0, sinNombre: 0, pvpInvalido: 0, duplicado: 0, pvpSuperior: 0 };

  const productos = result.recordset.map(r => {
    const cn     = String(r.cn  || '').trim();
    const pvp    = r.pvp != null ? Number(r.pvp) : null;
    const nombre = r.nombre ? String(r.nombre).trim() : '';

    if (!cn)                     { descartados.sinCN++;       return null; }
    if (!/^\d{5,}$/.test(cn))    { descartados.cnInvalido++;  return null; }
    if (!nombre)                 { descartados.sinNombre++;   return null; }
    if (pvp == null || pvp <= 0) { descartados.pvpInvalido++; return null; }
    if (vistos.has(cn))          { descartados.duplicado++;   return null; }

    const pvpMenor = r.pvp_menor != null ? Number(r.pvp_menor) : null;
    if (pvpMenor != null && pvp > pvpMenor * 1.01) {
      descartados.pvpSuperior++;
      return null;
    }

    vistos.add(cn);

    let pvl = r.pvl != null
      ? +Number(r.pvl).toFixed(4)
      : (pvp != null ? +(pvp * PVL_FACTOR).toFixed(4) : null);
    if (pvl != null && pvl <= 0) pvl = null;

    const dtoEntry = dtos.get(cn);
    const dto      = dtoEntry ? dtoEntry.dto : 0;

    let pc;
    if (r.puc != null && Number(r.puc) > 0)     pc = +Number(r.puc).toFixed(4);
    else if (r.pmc != null && Number(r.pmc) > 0) pc = +Number(r.pmc).toFixed(4);
    else if (pvl != null)                         pc = +(pvl * (1 - dto)).toFixed(4);
    else                                          pc = null;

    const tieneGH = r.ch != null;
    const nEnGH   = Number(r.n_en_gh || 0);
    let universo;
    if      (tieneGH && nEnGH === 1)               universo = 'ÚNICO';
    else if (tieneGH && nEnGH > 1)                 universo = 'HOMOGÉNEO';
    else if (r.efp)                                universo = 'PUBLICITARIO';
    else if (r.receta && r.excluido_ss)            universo = 'HOMOGÉNEO';
    else if (!r.receta && r.excluido_ss && !r.efp) universo = 'PARAFARMACIA';
    else                                           universo = 'PARAFARMACIA';

    const tipo             = tieneGH ? (r.efg ? 'GENÉRICO' : 'ÉTICO') : null;
    const labNombreCorto   = (r.laboratorio || '').trim().toUpperCase();
    const es_secundario    = LABS_SECUNDARIOS.has(labNombreCorto);

    return {
      codigo_nacional:  cn,
      nombre,
      laboratorio:      r.laboratorio ? String(r.laboratorio).trim() : null,
      principio_activo: null,
      grupo_homogeneo:  r.gh      || null,
      codigo_gh:        r.ch      || null,
      pvp_menor:        pvpMenor,
      pvp,
      pvl,
      puc:              r.puc != null && Number(r.puc) > 0 ? +Number(r.puc).toFixed(4) : null,
      iva:              r.iva != null ? String(r.iva).trim() : null,
      dto:              dto > 0 ? dto : null,
      sc:               null,
      pc,
      universo,
      tipo,
      es_generico:      r.efg === 1 || r.efg === true,
      es_secundario,
    };
  }).filter(Boolean);

  const totalDescartados = Object.values(descartados).reduce((a, b) => a + b, 0);
  if (totalDescartados > 0) {
    log.info(`Descartados: ${totalDescartados} (sinCN=${descartados.sinCN}, cnInvalido=${descartados.cnInvalido}, sinNombre=${descartados.sinNombre}, pvpInvalido=${descartados.pvpInvalido}, duplicado=${descartados.duplicado}, pvpSuperior=${descartados.pvpSuperior})`);
  }
  return productos;
}

async function detectarFiltroFacturada(p) {
  const r = await p.request().query(
    `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Venta'`
  );
  const cols = new Map(r.recordset.map(c => [String(c.COLUMN_NAME), String(c.DATA_TYPE)]));
  const candidatos = ['Facturada', 'Facturado', 'EstadoFact', 'EstadoFactura', 'Estado'];
  for (const c of candidatos) {
    if (cols.has(c)) {
      const tipo = cols.get(c).toLowerCase();
      if (/char|text/.test(tipo)) {
        const sample = await p.request().query(`
          SELECT TOP 1 LTRIM(RTRIM(${c})) AS v
          FROM Venta WHERE ${c} IS NOT NULL AND LTRIM(RTRIM(${c})) <> ''
          GROUP BY LTRIM(RTRIM(${c})) ORDER BY COUNT(*) DESC
        `).catch(() => ({ recordset: [] }));
        const valor = sample.recordset[0]?.v;
        if (valor) {
          const valEsc = String(valor).replace(/'/g, "''");
          log.info(`Facturada: col="${c}" valor="${valor}"`);
          return { col: c, filtro: `LTRIM(RTRIM(v.${c})) = '${valEsc}'` };
        }
        return { col: c, filtro: '1 = 1' };
      } else {
        return { col: c, filtro: `v.${c} = 1` };
      }
    }
  }
  log.warn('⚠ AVISO: no se detectó columna Facturada en tabla Venta — se sincronizarán TODAS las ventas (incluidos borradores/anulados). Revisa la configuración de Farmatic.');
  return { col: null, filtro: '1 = 1' };
}

async function fetchVentasMensuales(anio) {
  const p   = await getPool();
  const fac = await detectarFiltroFacturada(p);
  if (!fac.col) log.warn('No se detectó columna Facturada; se leen todas las ventas');

  const excl      = excludedVendors();
  const exclClause = excl.length ? `AND v.XVend_IdVendedor NOT IN (${excl.join(',')})` : '';

  const result = await p.request()
    .input('anio', sql.Int, anio)
    .query(`
      SELECT
        LTRIM(RTRIM(lv.Codigo))  AS codigo_nacional,
        v.Ejercicio              AS anio,
        v.Mes                    AS mes,
        v.XVend_IdVendedor       AS vendedor_id,
        SUM(lv.Cantidad)         AS unidades,
        SUM(lv.ImporteNeto)      AS importe_neto
      FROM LineaVenta lv
      INNER JOIN Venta v ON lv.IdVenta = v.IdVenta
      WHERE v.Ejercicio = @anio
        AND ${fac.filtro}
        AND lv.Cantidad > 0
        AND lv.Codigo IS NOT NULL AND lv.Codigo != ''
        ${exclClause}
      GROUP BY LTRIM(RTRIM(lv.Codigo)), v.Ejercicio, v.Mes, v.XVend_IdVendedor
    `).catch(err => { log.warn('fetchVentasMensuales falló:', err.message); return { recordset: [] }; });

  const anioActual = new Date().getFullYear();
  return result.recordset.map(r => ({
    codigo_nacional: String(r.codigo_nacional).trim(),
    anio:            Number(r.anio),
    mes:             Number(r.mes),
    vendedor_id:     Number(r.vendedor_id) || null,
    unidades:        Math.round(Number(r.unidades) || 0),
    importe_neto:    +(Number(r.importe_neto) || 0).toFixed(2),
  })).filter(v =>
    v.unidades > 0 && v.importe_neto >= 0 &&
    v.mes >= 1 && v.mes <= 12 &&
    v.anio >= 2000 && v.anio <= anioActual + 1 &&
    /^\d{5,}$/.test(v.codigo_nacional)
  );
}

async function fetchVentasAnuales(anio) {
  const p   = await getPool();
  const fac = await detectarFiltroFacturada(p);

  const result = await p.request()
    .input('anio', sql.Int, anio)
    .query(`
      SELECT
        LTRIM(RTRIM(lv.Codigo)) AS codigo_nacional,
        v.Ejercicio             AS anio,
        SUM(lv.Cantidad)        AS unidades,
        SUM(lv.ImporteNeto)     AS importe_neto
      FROM LineaVenta lv
      INNER JOIN Venta v ON lv.IdVenta = v.IdVenta
      WHERE v.Ejercicio = @anio AND ${fac.filtro}
        AND lv.Cantidad > 0 AND lv.Codigo IS NOT NULL
      GROUP BY LTRIM(RTRIM(lv.Codigo)), v.Ejercicio
    `).catch(err => { log.warn('fetchVentasAnuales falló:', err.message); return { recordset: [] }; });

  const anioActual = new Date().getFullYear();
  return result.recordset.map(r => ({
    codigo_nacional: String(r.codigo_nacional).trim(),
    anio:            Number(r.anio),
    unidades:        Math.round(Number(r.unidades) || 0),
    importe_neto:    +(Number(r.importe_neto) || 0).toFixed(2),
  })).filter(v =>
    v.unidades > 0 && v.importe_neto >= 0 &&
    v.anio >= 2000 && v.anio <= anioActual + 1 &&
    /^\d{5,}$/.test(v.codigo_nacional)
  );
}

async function fetchRecepcionesRecientes(mesesAtras = 12) {
  const p = await getPool();

  const tablas = await p.request().query(`SELECT name FROM sys.tables WHERE name IN ('Recep', 'LineaRecep')`);
  const existe = new Set(tablas.recordset.map(r => r.name));
  if (!existe.has('Recep') || !existe.has('LineaRecep')) {
    log.warn('Tablas Recep/LineaRecep no encontradas.');
    return [];
  }

  const colsR = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'LineaRecep'`
  );
  const colsLR = new Set(colsR.recordset.map(c => String(c.COLUMN_NAME)));
  const pick = (...cs) => cs.find(c => colsLR.has(c)) || null;

  const colCodigo   = pick('Codigo', 'IdArticu');
  const colCantidad = pick('Cantidad');
  const colPrecio   = pick('PrecioNeto', 'Precio', 'PrecioUnit', 'PrecioCompra', 'Importe');
  const colBonif    = pick('Bonificacion', 'Dto', 'Descuento', 'PctBonif');

  if (!colCodigo || !colCantidad || !colPrecio) {
    log.warn('LineaRecep sin columnas clave');
    return [];
  }

  const colsR2 = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Recep'`
  );
  const colsRec  = new Set(colsR2.recordset.map(c => String(c.COLUMN_NAME)));
  const colFecha = ['FechaAlbaran', 'Fecha', 'FechaRecep'].find(c => colsRec.has(c));
  if (!colFecha) { log.warn('Recep sin columna de fecha.'); return []; }

  const selBonif  = colBonif ? `lr.${colBonif} AS bonificacion,` : `NULL AS bonificacion,`;
  const fechaLim  = new Date();
  fechaLim.setMonth(fechaLim.getMonth() - mesesAtras);
  const fechaISO  = fechaLim.toISOString().slice(0, 10);

  const result = await p.request()
    .input('fecha', sql.Date, fechaISO)
    .query(`
      SELECT
        LTRIM(RTRIM(lr.${colCodigo})) AS codigo_nacional,
        r.${colFecha}                 AS fecha,
        lr.${colCantidad}             AS cantidad,
        lr.${colPrecio}               AS precio_neto,
        ${selBonif}
        r.IdRecep                     AS id_recep
      FROM LineaRecep lr
      INNER JOIN Recep r ON lr.IdRecep = r.IdRecep
      WHERE r.${colFecha} >= @fecha
        AND lr.${colCantidad} > 0
        AND lr.${colCodigo} IS NOT NULL
    `).catch(err => { log.warn('fetchRecepciones falló:', err.message); return { recordset: [] }; });

  const porCN = new Map();
  for (const r of result.recordset) {
    const cn = String(r.codigo_nacional).trim();
    if (!cn || !/^\d{5,}$/.test(cn)) continue;
    const fecha  = new Date(r.fecha);
    if (isNaN(fecha.getTime())) continue;
    const precio = Number(r.precio_neto);
    if (isNaN(precio) || precio <= 0) continue;
    let bonif = r.bonificacion != null ? Number(r.bonificacion) : null;
    if (bonif != null && (isNaN(bonif) || bonif < 0 || bonif > 100)) bonif = null;
    const actual = porCN.get(cn);
    if (!actual || fecha > actual.fecha) {
      porCN.set(cn, { codigo_nacional: cn, fecha, precio_neto: +precio.toFixed(4), bonificacion: bonif });
    }
  }

  return Array.from(porCN.values()).map(r => ({
    codigo_nacional:        r.codigo_nacional,
    fecha_ultima_recepcion: r.fecha.toISOString().slice(0, 10),
    precio_compra_real:     r.precio_neto,
    bonificacion:           r.bonificacion,
  }));
}

async function verificarTablas() {
  const p   = await getPool();
  const cdb = CONSEJO_DB();
  const tablasFarmatic = ['Articu', 'GeneArti', 'LineaVenta', 'Venta'];
  const tablasConsejo  = ['BP_CONJARTI', 'BP_CONJUNTOS'];
  const rFarmatic = await p.request().query(
    `SELECT name FROM sys.tables WHERE name IN (${tablasFarmatic.map(t => `'${t}'`).join(',')})`
  );
  const rConsejo = await p.request().query(
    `SELECT name FROM ${cdb}.sys.tables WHERE name IN (${tablasConsejo.map(t => `'${t}'`).join(',')})`
  ).catch(() => ({ recordset: [] }));
  const fnd = rFarmatic.recordset.map(r => r.name);
  const fnc = rConsejo.recordset.map(r => r.name);
  return {
    farmatic: { ok: tablasFarmatic.every(t => fnd.includes(t)), encontradas: fnd, faltan: tablasFarmatic.filter(t => !fnd.includes(t)) },
    consejo:  { ok: tablasConsejo.every(t => fnc.includes(t)),  encontradas: fnc, faltan: tablasConsejo.filter(t => !fnc.includes(t)) },
  };
}

async function fetch4DBDescuentos() {
  const p = await getPool();
  const tablas = await p.request().query(
    `SELECT name FROM sys.tables WHERE name IN ('_4DB_CAT_CatalogoArt', '_4DB_CAT_Models')`
  );
  const existe = new Set(tablas.recordset.map(r => r.name));
  if (!existe.has('_4DB_CAT_CatalogoArt') || !existe.has('_4DB_CAT_Models')) {
    log.warn('Tablas 4DB no encontradas.');
    return [];
  }
  const catR = await p.request().query(`SELECT MAX(catalogo) AS cat FROM _4DB_CAT_CatalogoArt`);
  const catalogo = catR.recordset[0]?.cat;
  if (!catalogo) { log.warn('Catálogo 4DB vacío.'); return []; }
  log.info(`4DB: catálogo ${catalogo}`);

  const result = await p.request()
    .input('catalogo', sql.Int, catalogo)
    .query(`
      SELECT
        LTRIM(RTRIM(CAST(cat.codigoNacional AS VARCHAR))) AS cn,
        cat.pvl,
        COALESCE(best.discount, 0) AS dto_pct,
        best.nombre                AS modelo
      FROM _4DB_CAT_CatalogoArt cat
      LEFT JOIN (
        SELECT codigonacional, MAX(discount) AS discount, MAX(nombre) AS nombre
        FROM _4DB_CAT_Models
        WHERE catalogo = @catalogo
          AND nombre IN ('COFARES DIRECTO', 'NEXO', 'PROMOCIONES')
        GROUP BY codigonacional
      ) best ON best.codigonacional = cat.codigoNacional
      WHERE cat.catalogo = @catalogo AND cat.iva = 'S'
    `);

  return result.recordset.map(r => ({
    codigo_nacional: String(r.cn).trim(),
    pvl_4db:         r.pvl != null ? +Number(r.pvl).toFixed(4) : null,
    dto_pct:         (() => {
      const v = r.dto_pct != null ? +Number(r.dto_pct) : 0;
      if (v <= 0) return 0;
      // 4DB can store as % (5) or decimal (0.05) — normalize to decimal
      return v > 1 ? +(v / 100).toFixed(4) : +v.toFixed(4);
    })(),
    modelo:          r.modelo || null,
    es_generico:     r.modelo != null,
  })).filter(r => /^\d{5,}$/.test(r.codigo_nacional));
}

// Lista IDs: configuradas por el wizard (paso Listas). Sin configurar → null (leer/escribir desactivado).
// LIST_CONSOLIDADO es opcional (no todas las instalaciones de Farmatic distinguen esta
// categoría en una lista propia — caso real: farmacia jose sí la tiene) — si falta, las
// otras 6 categorías siguen funcionando igual; solo CONSOLIDADO no se lee/escribe.
function getListaCategoria() {
  const keys = ['LIST_INCENTIVADOS_STAR','LIST_INCENTIVADOS','LIST_MAX_ROT_A','LIST_MAX_ROT_B','LIST_RESTO','LIST_PARADOS'];
  if (keys.some(k => !process.env[k])) return null;
  const map = {
    [parseInt(process.env.LIST_INCENTIVADOS_STAR)]: 'INCENTIVADOS_STAR',
    [parseInt(process.env.LIST_INCENTIVADOS)]:       'INCENTIVADOS',
    [parseInt(process.env.LIST_MAX_ROT_A)]:          'MAX_ROTACION_A',
    [parseInt(process.env.LIST_MAX_ROT_B)]:          'MAX_ROTACION_B',
    [parseInt(process.env.LIST_RESTO)]:              'RESTO',
    [parseInt(process.env.LIST_PARADOS)]:            'PARADOS',
  };
  if (process.env.LIST_CONSOLIDADO) map[parseInt(process.env.LIST_CONSOLIDADO)] = 'CONSOLIDADO';
  return map;
}

async function fetchFavoritosListas() {
  const lcat = getListaCategoria();
  if (!lcat) { log.info('fetchFavoritosListas omitido: wizard Listas no configurado'); return []; }
  const p    = await getPool();
  const ids  = Object.keys(lcat).join(',');

  const result = await p.request().query(`
    SELECT
      i.XItem_IdLista  AS lista,
      i.XItem_IdArticu AS cn,
      g.IdGrupoGen     AS ch
    FROM ItemListaArticu i
    INNER JOIN GeneArti g
      ON CAST(g.IdArticu AS VARCHAR) = CAST(i.XItem_IdArticu AS VARCHAR)
    WHERE i.XItem_IdLista IN (${ids})
      AND g.IdGrupoGen IS NOT NULL
      AND g.IdGrupoGen > 0
  `);

  // Priority order: lower list ID = higher priority (can override higher IDs)
  const PRIORIDAD = Object.keys(lcat).map(Number).sort((a, b) => a - b);
  const porGH = new Map();
  for (const prioridad of PRIORIDAD) {
    for (const row of result.recordset) {
      if (Number(row.lista) !== prioridad) continue;
      if (!porGH.has(row.ch)) {
        porGH.set(row.ch, { cn: row.cn, categoria: lcat[prioridad] });
      }
    }
  }

  const favoritos = [...porGH.entries()].map(([ch, { cn, categoria }]) => ({ ch, cn, categoria }));
  log.info(`fetchFavoritosListas: ${favoritos.length} GHs con favorito`);
  return favoritos;
}

async function fetchFavoritosActuales() {
  const lcat = getListaCategoria();
  if (!lcat) return new Map();
  const p   = await getPool();
  const ids  = Object.keys(lcat).join(',');
  try {
    const result = await p.request().query(`
      SELECT i.XItem_IdLista AS lista, i.XItem_IdArticu AS cn, g.IdGrupoGen AS ch
      FROM ItemListaArticu i
      INNER JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(i.XItem_IdArticu AS VARCHAR)
      WHERE i.XItem_IdLista IN (${ids}) AND g.IdGrupoGen IS NOT NULL AND g.IdGrupoGen > 0
    `);
    const PRIORIDAD = Object.keys(lcat).map(Number).sort((a, b) => a - b);
    const porGH     = new Map();
    for (const prioridad of PRIORIDAD) {
      for (const row of result.recordset) {
        if (Number(row.lista) !== prioridad) continue;
        if (!porGH.has(row.ch)) porGH.set(row.ch, row.cn);
      }
    }
    return porGH;
  } catch (e) {
    log.warn('fetchFavoritosActuales falló:', e.message);
    return new Map();
  }
}

async function fetchTicketMedio(anio) {
  const p         = await getPool();
  const excl      = excludedVendors();
  const exclClause = excl.length ? `AND v.XVend_IdVendedor NOT IN (${excl.join(',')})` : '';
  const result = await p.request().input('anio', anio).query(`
    SELECT
      v.XVend_IdVendedor                             AS vendedor_id,
      MONTH(v.FechaHora)                             AS mes,
      YEAR(v.FechaHora)                              AS anio,
      COUNT(DISTINCT v.IdVenta)                      AS n_tickets,
      SUM(lv.PVP * lv.Cantidad) / COUNT(DISTINCT v.IdVenta) AS ticket_medio,
      SUM(lv.PVP * lv.Cantidad)                      AS importe_total,
      COUNT(lv.IdNLinea)                             AS n_operaciones
    FROM LineaVenta lv
    INNER JOIN Venta v ON v.IdVenta = lv.IdVenta
    WHERE v.TipoVenta = 'C'
      AND YEAR(v.FechaHora) = @anio
      ${exclClause}
    GROUP BY v.XVend_IdVendedor, MONTH(v.FechaHora), YEAR(v.FechaHora)
  `).catch(err => { log.warn('fetchTicketMedio falló:', err.message); return { recordset: [] }; });

  return result.recordset.map(r => ({
    vendedor_id:   Number(r.vendedor_id),
    mes:           Number(r.mes),
    anio:          Number(r.anio),
    n_tickets:     Number(r.n_tickets) || 0,
    ticket_medio:  +(Number(r.ticket_medio) || 0).toFixed(4),
    importe_total: +(Number(r.importe_total) || 0).toFixed(2),
    n_operaciones: Number(r.n_operaciones) || 0,
  }));
}

// Obtiene todos los vendedores activos de Farmatic (sin filtro de IDs)
async function fetchVendedoresFarmatic() {
  const p = await getPool();
  // La columna de baja de Vendedor no es uniforme entre instalaciones de Farmatic
  // (algunas no la tienen en absoluto) — se detecta antes de usarla, igual que ya
  // se hace con Articu en fetchProductos().
  const colsR = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Vendedor'`
  ).catch(() => ({ recordset: [] }));
  const colsVendedor = new Set(colsR.recordset.map(r => String(r.COLUMN_NAME)));
  const colBaja = ['Baja', 'BajaVend', 'FechaBaja'].find(c => colsVendedor.has(c)) || null;
  const whereBaja = colBaja
    ? (colBaja === 'FechaBaja' ? `${colBaja} IS NULL AND ` : `(${colBaja} IS NULL OR ${colBaja} = 0) AND `)
    : '';

  const result = await p.request().query(`
    SELECT IdVendedor AS id, LTRIM(RTRIM(Nombre)) AS nombre
    FROM Vendedor
    WHERE ${whereBaja}IdVendedor != 99
    ORDER BY IdVendedor
  `).catch(err => { log.warn('fetchVendedoresFarmatic falló:', err.message); return { recordset: [] }; });
  return result.recordset;
}

function getCategoriaLista() {
  const keys = ['LIST_INCENTIVADOS_STAR','LIST_INCENTIVADOS','LIST_MAX_ROT_A','LIST_MAX_ROT_B','LIST_RESTO','LIST_PARADOS'];
  if (keys.some(k => !process.env[k])) return null;
  const map = {
    'INCENTIVADOS_STAR': parseInt(process.env.LIST_INCENTIVADOS_STAR),
    'INCENTIVADOS':      parseInt(process.env.LIST_INCENTIVADOS),
    'MAX_ROTACION_A':    parseInt(process.env.LIST_MAX_ROT_A),
    'MAX_ROTACION_B':    parseInt(process.env.LIST_MAX_ROT_B),
    'RESTO':             parseInt(process.env.LIST_RESTO),
    'PARADOS':           parseInt(process.env.LIST_PARADOS),
  };
  if (process.env.LIST_CONSOLIDADO) map['CONSOLIDADO'] = parseInt(process.env.LIST_CONSOLIDADO);
  return map;
}

const CATEGORIA_ENV = {
  INCENTIVADOS_STAR: 'LIST_INCENTIVADOS_STAR',
  INCENTIVADOS:       'LIST_INCENTIVADOS',
  MAX_ROTACION_A:     'LIST_MAX_ROT_A',
  MAX_ROTACION_B:     'LIST_MAX_ROT_B',
  RESTO:              'LIST_RESTO',
  PARADOS:            'LIST_PARADOS',
  CONSOLIDADO:        'LIST_CONSOLIDADO',
};

// Crea en Farmatic (ListaArticu/ItemListaArticu) las listas de categoría que falten y
// siembra un favorito inicial por grupo homogéneo = el CN con más unidades vendidas en
// los últimos 12 meses. SOLO se debe llamar cuando ya se ha confirmado (fetchListasWizard
// vacío) que esta instalación no tiene ninguna lista real — si tuviera alguna sin mapear
// no se toca nada, eso requiere revisión manual, no autocreación. Nunca pisa una categoría
// que ya tenga env var configurada. Cualquier duda sobre el esquema real (tabla, columna
// de nombre, autonumérico) aborta sin escribir nada — mejor no crear nada que crear algo
// mal en una base de datos de producción real.
async function crearListasCategoriaYFavoritosIniciales(categoriasActuales) {
  const p = await getPool();

  const tblR = await p.request().query(`SELECT name FROM sys.tables WHERE name = 'ListaArticu'`)
    .catch(() => ({ recordset: [] }));
  if (!tblR.recordset.length) {
    log.warn('Auto-creación de listas omitida: no existe la tabla ListaArticu');
    return null;
  }
  const colsR = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ListaArticu'`
  ).catch(() => ({ recordset: [] }));
  const cols = new Set(colsR.recordset.map(r => String(r.COLUMN_NAME)));
  const colNombre = cols.has('Nombre') ? 'Nombre' : cols.has('Descripcion') ? 'Descripcion' : null;
  if (!colNombre) {
    log.warn('Auto-creación de listas omitida: ListaArticu no tiene columna Nombre/Descripcion reconocible');
    return null;
  }
  const identityR = await p.request().query(
    `SELECT COLUMNPROPERTY(OBJECT_ID('ListaArticu'), 'IdLista', 'IsIdentity') AS es_identity`
  ).catch(() => ({ recordset: [] }));
  if (identityR.recordset[0]?.es_identity !== 1) {
    log.warn('Auto-creación de listas omitida: ListaArticu.IdLista no es autonumérico, no se puede generar un id seguro');
    return null;
  }

  const faltantes = Object.keys(CATEGORIA_ENV).filter(cat => !process.env[CATEGORIA_ENV[cat]]);
  if (!faltantes.length) return null;

  const creadas = [];
  for (const categoria of faltantes) {
    try {
      const r = await p.request()
        .input('nombre', sql.VarChar, `NextFarma - ${categoria}`)
        .query(`INSERT INTO ListaArticu (${colNombre}) OUTPUT INSERTED.IdLista AS id VALUES (@nombre)`);
      const nuevoId = r.recordset[0]?.id;
      if (nuevoId) {
        creadas.push({ categoria, lista_id: nuevoId });
        process.env[CATEGORIA_ENV[categoria]] = String(nuevoId);
      }
    } catch (err) {
      log.warn(`No se pudo crear la lista de ${categoria}:`, err.message);
    }
  }
  if (!creadas.length) return null;

  const fac = await detectarFiltroFacturada(p);
  const excl = excludedVendors();
  const exclClause = excl.length ? `AND v.XVend_IdVendedor NOT IN (${excl.join(',')})` : '';
  const hoy = new Date();
  const cutoff = (hoy.getFullYear() - 1) * 100 + (hoy.getMonth() + 1); // últimos ~12 meses

  const topR = await p.request().query(`
    SELECT ch, cn FROM (
      SELECT g.IdGrupoGen AS ch, lv.Codigo AS cn, SUM(lv.Cantidad) AS uds,
        ROW_NUMBER() OVER (PARTITION BY g.IdGrupoGen ORDER BY SUM(lv.Cantidad) DESC) AS rn
      FROM LineaVenta lv
      INNER JOIN Venta v ON v.IdVenta = lv.IdVenta
      INNER JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(lv.Codigo AS VARCHAR)
      WHERE (v.Ejercicio * 100 + v.Mes) >= ${cutoff}
        AND ${fac.filtro} ${exclClause}
        AND lv.Cantidad > 0
        AND g.IdGrupoGen IS NOT NULL AND g.IdGrupoGen > 0
      GROUP BY g.IdGrupoGen, lv.Codigo
    ) t
    WHERE rn = 1
  `).catch(err => { log.warn('Top CN por grupo (auto-creación) falló:', err.message); return { recordset: [] }; });

  const topPorCh          = new Map(topR.recordset.map(r => [Number(r.ch), Number(r.cn)]));
  const categoriaPorCh    = new Map((categoriasActuales || []).map(r => [Number(r.ch), r.categoria]));
  const listaIdPorCategoria = new Map(creadas.map(c => [c.categoria, c.lista_id]));

  let favoritosCreados = 0;
  for (const [ch, cn] of topPorCh) {
    const listaId = listaIdPorCategoria.get(categoriaPorCh.get(ch));
    if (!listaId) continue;
    try {
      await p.request()
        .input('lista', sql.Int, listaId)
        .input('cn',    sql.Int, cn)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn)
          INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu) VALUES (@lista, @cn)
        `);
      favoritosCreados++;
    } catch (err) {
      log.warn(`No se pudo sembrar favorito inicial de CH ${ch}:`, err.message);
    }
  }

  log.info(`✓ Listas de categoría creadas en Farmatic: ${creadas.length}, favoritos iniciales: ${favoritosCreados}`);
  return { creadas, favoritos_creados: favoritosCreados };
}

async function procesarCambiosPendientes(cambios) {
  if (!cambios || cambios.length === 0) return { procesados: 0, errores: 0, ids_procesados: [] };
  const listas = getCategoriaLista();
  if (!listas) {
    log.warn('procesarCambiosPendientes omitido: completa el wizard (paso Listas) para activar escritura en Farmatic');
    return { procesados: 0, errores: 0, ids_procesados: [] };
  }
  const p = await getPool();
  let procesados = 0, errores = 0;
  const ids_procesados = [];

  for (const cambio of cambios) {
    try {
      const { ch, favorito_cn_nuevo, favorito_cn_anterior, categoria_nueva } = cambio;

      if (favorito_cn_nuevo && categoria_nueva) {
        const listaDestino = listas[categoria_nueva];
        if (!listaDestino) {
          log.warn('Categoria desconocida: ' + categoria_nueva);
          errores++;
          continue;
        }

        const listaIds = Object.values(listas).join(',');

        if (favorito_cn_anterior) {
          await p.request()
            .input('cn', sql.Int, favorito_cn_anterior)
            .query(`
              DELETE FROM ItemListaArticu
              WHERE XItem_IdArticu = @cn
                AND XItem_IdLista IN (${listaIds})
            `);
        }

        await p.request()
          .input('lista', sql.Int, listaDestino)
          .input('cn',    sql.Int, favorito_cn_nuevo)
          .query(`
            IF NOT EXISTS (
              SELECT 1 FROM ItemListaArticu
              WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn
            )
            INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu)
            VALUES (@lista, @cn)
          `);

        log.info(`Cambio procesado: CH ${ch} CN ${favorito_cn_nuevo} lista ${listaDestino} (${categoria_nueva})`);
      }

      procesados++;
      ids_procesados.push(cambio.id);
    } catch (err) {
      log.error('Error procesando cambio CH ' + cambio.ch + ':', err.message);
      errores++;
    }
  }

  return { procesados, errores, ids_procesados };
}

// Lista Negra: pipeline independiente de getCategoriaLista()/procesarCambiosPendientes.
// Usa su propio env var (LIST_NEGRA) y, si no está configurado, simplemente omite
// el procesado sin afectar al resto del sync (favoritos/categorías siguen su curso
// aunque la instalación no haya pasado por el 7º paso del wizard).
async function procesarListaNegraPendiente(cambios) {
  if (!cambios || cambios.length === 0) return { procesados: 0, errores: 0, ids_procesados: [] };
  const listaNegraId = parseInt(process.env.LIST_NEGRA, 10);
  if (!listaNegraId) {
    log.warn('Lista Negra omitida: configura la lista en el Asistente (paso Listas) para activar la escritura en Farmatic');
    return { procesados: 0, errores: 0, ids_procesados: [] };
  }
  const p = await getPool();
  let procesados = 0, errores = 0;
  const ids_procesados = [];

  for (const cambio of cambios) {
    try {
      const { cn, lista_negra } = cambio;
      if (lista_negra) {
        await p.request()
          .input('lista', sql.Int, listaNegraId)
          .input('cn',    sql.Int, cn)
          .query(`
            IF NOT EXISTS (
              SELECT 1 FROM ItemListaArticu
              WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn
            )
            INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu)
            VALUES (@lista, @cn)
          `);
        log.info(`Lista Negra: CN ${cn} añadido`);
      } else {
        await p.request()
          .input('lista', sql.Int, listaNegraId)
          .input('cn',    sql.Int, cn)
          .query(`DELETE FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn`);
        log.info(`Lista Negra: CN ${cn} retirado`);
      }
      procesados++;
      ids_procesados.push(cambio.id);
    } catch (err) {
      log.error('Error procesando lista negra CN ' + cambio.cn + ':', err.message);
      errores++;
    }
  }

  return { procesados, errores, ids_procesados };
}

// ── Métodos del asistente de configuración ────────────────────────────────
// Devuelve todos los vendedores de Farmatic (sin filtros) para que el usuario
// identifique cuáles excluir del análisis
async function fetchVendedoresWizard() {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT IdVendedor AS id, LTRIM(RTRIM(Nombre)) AS nombre
    FROM Vendedor
    ORDER BY IdVendedor
  `).catch(() => ({ recordset: [] }));
  return r.recordset;
}

// Devuelve los laboratorios distintos con cantidad de CNs vendidos (para mapear SC)
async function fetchLabsWizard() {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT
      LTRIM(RTRIM(a.Laboratorio)) AS codigo,
      COUNT(DISTINCT a.IdArticu)  AS n_cns
    FROM Articu a
    WHERE a.Baja = 0
      AND a.Laboratorio IS NOT NULL
      AND LTRIM(RTRIM(a.Laboratorio)) <> ''
    GROUP BY LTRIM(RTRIM(a.Laboratorio))
    ORDER BY n_cns DESC
  `).catch(() => ({ recordset: [] }));
  return r.recordset.map(r => ({ codigo: r.codigo, n_cns: Number(r.n_cns) }));
}

// Devuelve todas las listas de artículos de Farmatic con nombre y cantidad de ítems
async function fetchListasWizard() {
  const p = await getPool();
  // El nombre de la cabecera de lista varía por instalación: unas Farmatic la llaman
  // "Nombre", otras "Descripcion" (caso real: farmacia jose). Se detecta la columna real
  // en vez de asumir un nombre fijo — mismo patrón que Vendedor.Baja/Cliente.Telefono2.
  const tbl = await p.request().query(
    `SELECT name FROM sys.tables WHERE name IN ('ListaArticu', 'Lista', 'Listas')`
  ).catch(() => ({ recordset: [] }));
  const tablaNombres = tbl.recordset[0]?.name;

  if (tablaNombres) {
    const colsR = await p.request().query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tablaNombres}'`
    ).catch(() => ({ recordset: [] }));
    const cols = new Set(colsR.recordset.map(r => r.COLUMN_NAME));
    const colNombre = cols.has('Nombre') ? 'Nombre' : cols.has('Descripcion') ? 'Descripcion' : null;

    if (colNombre) {
      const r = await p.request().query(`
        SELECT
          l.IdLista  AS id,
          LTRIM(RTRIM(l.${colNombre})) AS nombre,
          COUNT(i.XItem_IdArticu) AS n_items
        FROM ${tablaNombres} l
        LEFT JOIN ItemListaArticu i ON i.XItem_IdLista = l.IdLista
        GROUP BY l.IdLista, l.${colNombre}
        HAVING COUNT(i.XItem_IdArticu) > 0
        ORDER BY l.IdLista
      `).catch(() => ({ recordset: [] }));
      if (r.recordset.length) return r.recordset.map(r => ({ id: r.id, nombre: r.nombre || `Lista ${r.id}`, n_items: Number(r.n_items) }));
    }
  }

  // Fallback: inferir IDs y conteos directamente desde ItemListaArticu
  const r2 = await p.request().query(`
    SELECT XItem_IdLista AS id, COUNT(*) AS n_items
    FROM ItemListaArticu
    GROUP BY XItem_IdLista
    ORDER BY XItem_IdLista
  `).catch(() => ({ recordset: [] }));
  return r2.recordset.map(r => ({ id: Number(r.id), nombre: `Lista ${r.id}`, n_items: Number(r.n_items) }));
}

// Queries diagnóstico predefinidas (solo lectura). Clave → { sql | () => sql, desc, fallback? }
const DIAGNOSTIC_QUERIES = {
  vendedores: {
    sql: `SELECT IdVendedor AS id, LTRIM(RTRIM(Nombre)) AS nombre FROM Vendedor ORDER BY IdVendedor`,
    desc: 'Lista completa de vendedores en Farmatic',
  },
  laboratorios: {
    sql: `
      SELECT
        LTRIM(RTRIM(p.IdProveedor)) AS codigo,
        LTRIM(RTRIM(p.Nombre))      AS nombre,
        COUNT(a.IdArticu)           AS n_articulos
      FROM Proveedor p
      LEFT JOIN Articu a
        ON LTRIM(RTRIM(a.Laboratorio)) = LTRIM(RTRIM(p.IdProveedor)) AND a.Baja = 0
      GROUP BY p.IdProveedor, p.Nombre
      HAVING COUNT(a.IdArticu) > 0
      ORDER BY n_articulos DESC`,
    desc: 'Proveedores/laboratorios con artículos activos',
  },
  listas: {
    sql: `
      SELECT
        l.IdLista                   AS id,
        LTRIM(RTRIM(l.Nombre))      AS nombre,
        COUNT(i.XItem_IdArticu)     AS n_items
      FROM ListaArticu l
      LEFT JOIN ItemListaArticu i ON i.XItem_IdLista = l.IdLista
      GROUP BY l.IdLista, l.Nombre
      ORDER BY l.IdLista`,
    desc: 'Listas de artículos con nombre y número de ítems',
    fallback: `
      SELECT XItem_IdLista AS id, COUNT(*) AS n_items
      FROM ItemListaArticu
      GROUP BY XItem_IdLista
      ORDER BY XItem_IdLista`,
  },
  rgpd_opciones: {
    sql: `SELECT OpcRGPD AS opcion, COUNT(*) AS n_clientes FROM ClienteRGPD GROUP BY OpcRGPD ORDER BY n_clientes DESC`,
    desc: 'Códigos RGPD presentes y número de clientes por código',
  },
  grupos_homogeneos: {
    // sql como función para insertar el nombre de BD Consejo en tiempo de ejecución
    sql: () => `
      SELECT TOP 10
        bpj.CODCONJUNTO                    AS ch,
        LTRIM(RTRIM(bpj.NOMBRE))           AS nombre,
        COUNT(bpc.CODIGO)                  AS n_cns
      FROM ${CONSEJO_DB()}.dbo.BP_CONJUNTOS bpj
      LEFT JOIN ${CONSEJO_DB()}.dbo.BP_CONJARTI bpc
        ON bpc.CODConjunto = bpj.CODCONJUNTO AND bpc.CODCCAA = 0
      WHERE bpj.CODCCAA = 0
      GROUP BY bpj.CODCONJUNTO, bpj.NOMBRE
      ORDER BY n_cns DESC`,
    desc: 'Grupos homogéneos en la base de datos del Consejo General',
  },
  ventas_recientes: {
    sql: `
      SELECT TOP 10
        v.XVend_IdVendedor            AS vendedor_id,
        LTRIM(RTRIM(ve.Nombre))       AS vendedor,
        COUNT(DISTINCT v.IdVenta)     AS n_tickets,
        SUM(lv.Cantidad)              AS n_unidades
      FROM Venta v
      JOIN LineaVenta lv ON lv.IdVenta = v.IdVenta
      LEFT JOIN Vendedor ve ON ve.IdVendedor = v.XVend_IdVendedor
      WHERE v.FechaHora >= DATEADD(day, -30, GETDATE())
      GROUP BY v.XVend_IdVendedor, ve.Nombre
      ORDER BY n_tickets DESC`,
    desc: 'Ventas de los últimos 30 días por vendedor',
  },
  encargos_activos: {
    sql: `
      SELECT TOP 20
        e.IdEncargo                             AS id,
        LTRIM(RTRIM(e.Codigo))                  AS cn,
        LEFT(LTRIM(RTRIM(
          COALESCE((SELECT TOP 1 LTRIM(RTRIM(a.Descripcion))
                    FROM Articu a WHERE a.IdArticu = e.Codigo), e.Codigo)
        )), 40)                                 AS descripcion,
        e.Cantidad                              AS uds,
        CONVERT(varchar, e.FechaRecepcion, 103) AS fecha
      FROM Encargo e
      WHERE e.Cantidad > 0
      ORDER BY e.FechaRecepcion DESC`,
    desc: 'Encargos activos pendientes de recogida',
  },
  recepciones_recientes: {
    sql: `
      SELECT TOP 10
        r.IdRecep                              AS id,
        CONVERT(varchar, r.FechaRecep, 103)    AS fecha,
        LTRIM(RTRIM(COALESCE(p.Nombre, r.XProv_IdProveedor))) AS proveedor,
        COUNT(lr.Codigo)                       AS n_lineas,
        SUM(lr.Cantidad)                       AS n_uds
      FROM Recep r
      LEFT JOIN Proveedor p ON p.IdProveedor = r.XProv_IdProveedor
      JOIN LineaRecep lr ON lr.XRecep_IdRecep = r.IdRecep
      WHERE r.FechaRecep >= DATEADD(day, -90, GETDATE())
      GROUP BY r.IdRecep, r.FechaRecep, p.Nombre, r.XProv_IdProveedor
      ORDER BY r.FechaRecep DESC`,
    desc: 'Últimas recepciones de los 90 días anteriores',
    fallback: `
      SELECT TOP 10
        IdRecep AS id,
        CONVERT(varchar, FechaRecep, 103) AS fecha
      FROM Recep
      ORDER BY FechaRecep DESC`,
  },
};

async function runDiagnostic(key) {
  const q = DIAGNOSTIC_QUERIES[key];
  if (!q) throw new Error(`Diagnóstico desconocido: ${key}`);
  const p = await getPool();
  // sql puede ser string estático o función que devuelve string (para queries con vars de entorno)
  const sql = typeof q.sql === 'function' ? q.sql() : q.sql;
  try {
    const r = await p.request().query(sql);
    return { ok: true, rows: r.recordset, desc: q.desc };
  } catch (e) {
    if (q.fallback) {
      const r2 = await p.request().query(q.fallback).catch(() => ({ recordset: [] }));
      return { ok: true, rows: r2.recordset, desc: q.desc + ' (modo simplificado)' };
    }
    throw e;
  }
}

async function fetchRGPDCount(opcion) {
  const p = await getPool();
  const r = await p.request().query(
    `SELECT COUNT(*) AS n FROM ClienteRGPD WHERE OpcRGPD = ${parseInt(opcion, 10)}`
  );
  return Number(r.recordset[0]?.n ?? 0);
}

// Distribución de códigos OpcRGPD (solo código + nº de clientes, sin id/nombre/teléfono)
// para poder detectar en remoto si el código configurado en el asistente no coincide con
// ningún código real de esta instalación de Farmatic — sin depender de un clic manual local.
async function fetchRGPDDistribucion() {
  try {
    const p = await getPool();
    const r = await p.request().query(
      `SELECT OpcRGPD AS opcion, COUNT(*) AS n FROM ClienteRGPD GROUP BY OpcRGPD ORDER BY n DESC`
    );
    return r.recordset.map(row => ({ opcion: row.opcion, n: Number(row.n) }));
  } catch (e) {
    return null;
  }
}

module.exports = {
  getPool,
  closePool,
  fetchProductos,
  fetchVentasAnuales,
  fetchVentasMensuales,
  fetchRecepcionesRecientes,
  fetchFavoritosListas,
  fetchFavoritosActuales,
  fetchTicketMedio,
  fetchVendedoresFarmatic,
  verificarTablas,
  fetch4DBDescuentos,
  procesarCambiosPendientes,
  procesarListaNegraPendiente,
  getCategoriaLista,
  crearListasCategoriaYFavoritosIniciales,
  discoverSchema,
  discoverDataQuality,
  resetSchemaCache,
  fetchVendedoresWizard,
  fetchLabsWizard,
  fetchListasWizard,
  fetchRGPDCount,
  fetchRGPDDistribucion,
  runDiagnostic,
  IVA_MEDICAMENTOS,
  RE,
  PVL_FACTOR,
  UMBRAL_SC,
  SC_CINFA_NORMON,
  SC_KERN_TEVA,
};
