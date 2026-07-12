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
      // Sin efecto si el servidor resuelve a una única IP (el caso normal) — pero si es un
      // Listener de Always On Availability Groups con varias IP registradas (una por subred),
      // hace que el driver las pruebe todas en paralelo en vez de en secuencia. Recomendado
      // por Microsoft para cualquier conexión contra un Listener de AG, siempre seguro de activar.
      multiSubnetFailover: true,
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

// ── Diagnóstico de errores de conexión ──────────────────────────────────────
// El mensaje crudo del driver `mssql` (p.ej. "Login failed for user 'sa'.") no le dice a
// un titular sin conocimientos de SQL qué hacer ni a soporte qué mirar primero por
// teléfono. Traduce los códigos/números más frecuentes vistos en soporte a una causa
// probable + pasos concretos; si el error no coincide con ninguno, no se inventa nada —
// se deja que se muestre el mensaje crudo tal cual.
function diagnosticarErrorConexion(err) {
  const codigo = err?.code;
  const sqlNum = err?.originalError?.info?.number;

  if (sqlNum === 19456) {
    return {
      mensaje: 'El servidor SQL Server usa Always On Availability Groups y ninguna de las IP configuradas en el Listener corresponde a la subred desde la que te conectas — la conexión se acepta un instante y se corta enseguida.',
      sugerencias: [
        'Ya se ha activado MultiSubnetFailover en la conexión (versión 1.0.36+), que ayuda cuando el Listener SÍ tiene una IP válida en tu subred pero el driver probaba las IP en orden equivocado — si el error persiste, es que ninguna IP del Listener está en tu subred.',
        'Esto requiere una acción del administrador de red/clúster del cliente, no de NextFarma: en el Administrador de Clústeres de Conmutación por Error → Roles → recurso de Nombre de Red del Listener → Propiedades → añadir una IP estática libre dentro del mismo rango que este PC.',
        'Alternativa más simple si no necesitan failover automático: apuntar el campo "Servidor" directamente al nombre de un nodo concreto del clúster en vez de al nombre del Listener.',
      ],
    };
  }
  if (codigo === 'ELOGIN' || sqlNum === 18456 || sqlNum === 18452) {
    return {
      mensaje: 'Usuario o contraseña de SQL Server incorrectos (o ese login no tiene acceso).',
      sugerencias: [
        'Revisa que usuario y contraseña sean exactamente los que usa Farmatic (mayúsculas/minúsculas incluidas).',
        "Comprueba si el login está deshabilitado: en SSMS con Windows Authentication ejecuta " +
          "SELECT name, is_disabled FROM sys.server_principals WHERE type IN ('S','U').",
        'Si SQL Server solo permite Windows Authentication (modo no mixto), cualquier usuario SQL (incluido sa) fallará siempre — hay que activar "SQL Server and Windows Authentication mode" en las propiedades del servidor y reiniciar el servicio SQL Server.',
      ],
    };
  }
  if (sqlNum === 4060 || sqlNum === 4064) {
    return {
      mensaje: 'El usuario se autenticó bien, pero no tiene acceso a esa base de datos (o el nombre está mal escrito).',
      sugerencias: ['Revisa el campo "Base de datos Farmatic" — el nombre debe coincidir exactamente con el de SQL Server.'],
    };
  }
  if (codigo === 'ETIMEOUT' || codigo === 'ESOCKET') {
    return {
      mensaje: 'No se pudo alcanzar el servidor SQL Server (tiempo agotado o conexión rechazada).',
      sugerencias: [
        'Revisa que servidor/instancia/puerto sean correctos y que el servicio SQL Server esté arrancado.',
        'Comprueba el firewall del servidor — el puerto de SQL Server (1433 por defecto, o UDP 1434 de SQL Browser si usas instancia con nombre) debe estar abierto para conexiones entrantes.',
      ],
    };
  }
  if (codigo === 'EINSTLOOKUP') {
    return {
      mensaje: 'No se pudo resolver el nombre de instancia de SQL Server (SQL Browser no responde).',
      sugerencias: ['Comprueba que el servicio "SQL Server Browser" esté arrancado en el servidor, o indica el puerto TCP fijo en vez de depender del nombre de instancia.'],
    };
  }
  if (codigo === 'ENOTFOUND') {
    return { mensaje: 'No se encuentra el servidor — revisa que el nombre/IP esté bien escrito.', sugerencias: [] };
  }
  return null;
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

    // Barrido COMPLETO (todas las tablas reales, no solo las esperadas) — para que el
    // panel admin pueda ofrecer un selector de "tabla.columna" real de esta instalación
    // concreta al fijar un atributo a mano, en vez de que alguien tenga que adivinar y
    // escribir el nombre a ciegas. Sin datos, solo metadata (nombre/tipo de columna).
    let tablasCompleto = {};
    try {
      const todasR = await p.request().query(`SELECT name FROM sys.tables`);
      const nombresTodas = todasR.recordset.map(r => r.name);
      if (nombresTodas.length) {
        const colsTodasR = await p.request().query(`
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME IN (${nombresTodas.map(t => `'${t}'`).join(',')})
        `);
        for (const t of nombresTodas) tablasCompleto[t] = []
        for (const row of colsTodasR.recordset) tablasCompleto[row.TABLE_NAME].push({ nombre: row.COLUMN_NAME, tipo: row.DATA_TYPE })
      }
    } catch (err) {
      log.warn('Barrido completo de tablas falló:', err.message);
    }

    schemaCache = { tablas, tablas_esperadas_faltantes: faltantes, tablas_completo: tablasCompleto };
    if (faltantes.length > 0) {
      log.warn(`Esquema Farmatic: no se encontraron estas tablas esperadas: ${faltantes.join(', ')}`);
    }
  } catch (err) {
    log.warn('discoverSchema falló:', err.message);
    schemaCache = { tablas: {}, tablas_esperadas_faltantes: TABLAS_ESPERADAS, tablas_completo: {}, error: err.message };
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

  // 4DB (Cofares Conecta 4D): hoy fetch4DBDescuentos() solo lee MAX(catalogo) — el más
  // reciente. Si Farmatic conserva más de un catálogo histórico en esta instalación,
  // se podría reconstruir el histórico real de precio/dto de meses pasados en vez de
  // partir de cero en cns_precio_historico (backend). Esto es solo diagnóstico — no
  // cambia qué catálogo usa el sync para escribir precios.
  try {
    const tabla4db = await p.request().query(`SELECT name FROM sys.tables WHERE name = '_4DB_CAT_CatalogoArt'`);
    if (tabla4db.recordset.length) {
      const cats = await p.request().query(
        `SELECT catalogo, COUNT(*) AS n FROM _4DB_CAT_CatalogoArt GROUP BY catalogo ORDER BY catalogo DESC`
      );
      calidad.__catalogos_4db = cats.recordset.map(r => ({ catalogo: r.catalogo, filas: r.n }));
    }
  } catch (err) {
    log.warn('Diagnóstico catálogos 4DB falló:', err.message);
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

  // PVL NO se lee de ninguna columna de Farmatic — se probó (resolverAtributoColumna con
  // candidatos Pvl/PVL/PVLIVA/...) y fue justo lo que corrompió el margen de farmacia
  // jose: la IA (con una descripción entonces ambigua) resolvió "pvl" como la columna
  // Pvp, dejando pvl=pvp en el 85% de su catálogo. La fórmula PVP × PVL_FACTOR (0.6406)
  // ya está verificada contra el catálogo real de 4DB (diferencia <0.01€ en el 99% de
  // los casos, ver doc "6.1 Cálculo PVL y MU") — no es un fallback de emergencia, es EL
  // cálculo. 4DB (más abajo, cuando cubre ese CN) sigue pisando esto con su propio
  // pvl_4db, que es siempre más preciso que cualquier columna que pudiéramos adivinar.
  const colPuc = await resolverAtributoColumna({
    entidad: 'ARTICU', atributo: 'puc', candidatos: ['Puc', 'PUC', 'PrecioCompra', 'PrecioUltimaCompra'],
    columnasReales: colsArticu, descripcion: 'Columna de la tabla Articu con el precio de última compra a la farmacia (PUC/coste de compra).',
  });
  const colPmc = await resolverAtributoColumna({
    entidad: 'ARTICU', atributo: 'pmc', candidatos: ['Pmc', 'PMC', 'PrecioMedioCompra'],
    columnasReales: colsArticu, descripcion: 'Columna de la tabla Articu con el precio medio de compra (PMC).',
  });
  const colIva = await resolverAtributoColumna({
    entidad: 'ARTICU', atributo: 'iva', candidatos: ['IVA', 'Iva', 'TipoIva', 'TipoIVA', 'XGrup_IdGrupoIva'],
    columnasReales: colsArticu, descripcion: 'Columna de la tabla Articu con el tipo/grupo de IVA del artículo.',
  });
  const selPuc  = colPuc ? `a.${colPuc} AS puc,` : `NULL AS puc,`;
  const selPmc  = colPmc ? `a.${colPmc} AS pmc,` : `NULL AS pmc,`;
  const selIva  = colIva ? `CAST(a.${colIva} AS VARCHAR(16)) AS iva,` : `NULL AS iva,`;

  log.info(`Columnas Articu: pvl=PVP×${PVL_FACTOR} (calculado) puc=${colPuc||'—'} iva=${colIva||'—'}`);

  const cdb = CONSEJO_DB();
  const result = await p.request().query(`
    SELECT
      LTRIM(RTRIM(a.IdArticu))          AS cn,
      LTRIM(RTRIM(a.Descripcion))       AS nombre,
      LTRIM(RTRIM(a.Laboratorio))       AS laboratorio,
      a.Pvp                             AS pvp,
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

    // PVL siempre calculado (ver comentario junto a fetchProductos más arriba) — 4DB lo
    // pisa más abajo en sync.js (prod.pvl = d.pvl_4db || prod.pvl) cuando tiene el dato
    // real para ese CN, que es más preciso que esta fórmula.
    let pvl = pvp != null ? +(pvp * PVL_FACTOR).toFixed(4) : null;
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
  // Qué COLUMNA usar pasa por el resolvedor persistente (heurística → IA → panel de
  // admin); qué SIGNIFICA su valor (booleano vs. código de texto a muestrear) sigue
  // siendo lógica local, ya que depende de datos reales de esta sync, no de un nombre.
  const c = await resolverAtributoColumna({
    entidad: 'VENTA', atributo: 'facturada_columna',
    candidatos: ['Facturada', 'Facturado', 'EstadoFact', 'EstadoFactura', 'Estado'],
    columnasReales: new Set(cols.keys()),
    descripcion: 'Columna de la tabla Venta que marca si una venta está facturada/confirmada, no un borrador o venta anulada. Puede ser un booleano (0/1) o un código de texto.',
  });
  if (c) {
    const tipo = (cols.get(c) || '').toLowerCase();
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
  log.warn('⚠ AVISO: no se detectó columna Facturada en tabla Venta — se sincronizarán TODAS las ventas (incluidos borradores/anulados). Revisa la configuración de Farmatic.');
  return { col: null, filtro: '1 = 1' };
}

// Últimos `n` meses (incluido el actual) como pares {ejercicio, mes} — p.ej. n=2 en marzo de
// 2026 devuelve [{2026,3},{2026,2}], y en enero de 2026 devuelve [{2026,1},{2025,12}] (cruza
// de año correctamente). Usado por fetchVentasMensuales() cuando farmatic_ventas_solo_reciente
// está activado, para no releer los 2 años completos en cada sync.
function ventanaMesesRecientes(n) {
  const out = [];
  const hoy = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    out.push({ ejercicio: d.getFullYear(), mes: d.getMonth() + 1 });
  }
  return out;
}

async function fetchVentasMensuales(anio, opts = {}) {
  const p   = await getPool();
  const fac = await detectarFiltroFacturada(p);
  if (!fac.col) log.warn('No se detectó columna Facturada; se leen todas las ventas');

  const excl      = excludedVendors();
  const exclClause = excl.length ? `AND v.XVend_IdVendedor NOT IN (${excl.join(',')})` : '';

  // mesesRecientes: subconjunto de ventanaMesesRecientes() que cae en `anio` — si se pasa un
  // array vacío, ese año no aporta nada a la ventana y no hace falta ni consultar Farmatic.
  const { mesesRecientes } = opts;
  if (mesesRecientes && !mesesRecientes.length) return [];
  const filtroMeses = mesesRecientes?.length
    ? `AND v.Mes IN (${mesesRecientes.map(m => m.mes).join(',')})`
    : '';

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
        ${filtroMeses}
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

  const colCodigo = await resolverAtributoColumna({
    entidad: 'LINEA_RECEP', atributo: 'codigo', candidatos: ['Codigo', 'IdArticu'],
    columnasReales: colsLR, descripcion: 'Columna de LineaRecep con el código nacional o identificador del artículo recibido en cada línea de recepción/albarán.',
  });
  const colCantidad = await resolverAtributoColumna({
    entidad: 'LINEA_RECEP', atributo: 'cantidad', candidatos: ['Cantidad'],
    columnasReales: colsLR, descripcion: 'Columna de LineaRecep con la cantidad de unidades recibidas en cada línea.',
  });
  const colPrecio = await resolverAtributoColumna({
    entidad: 'LINEA_RECEP', atributo: 'precio', candidatos: ['PrecioNeto', 'Precio', 'PrecioUnit', 'PrecioCompra', 'Importe'],
    columnasReales: colsLR, descripcion: 'Columna de LineaRecep con el precio neto de compra de cada línea de recepción.',
  });
  const colBonif = await resolverAtributoColumna({
    entidad: 'LINEA_RECEP', atributo: 'bonificacion', candidatos: ['Bonificacion', 'Dto', 'Descuento', 'PctBonif'],
    columnasReales: colsLR, descripcion: 'Columna de LineaRecep con el porcentaje de bonificación/descuento del proveedor en la recepción, si existe.',
  });

  if (!colCodigo || !colCantidad || !colPrecio) {
    log.warn('LineaRecep sin columnas clave');
    return [];
  }

  const colsR2 = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Recep'`
  );
  const colsRec  = new Set(colsR2.recordset.map(c => String(c.COLUMN_NAME)));
  const colFecha = await resolverAtributoColumna({
    entidad: 'RECEP', atributo: 'fecha', candidatos: ['FechaAlbaran', 'Fecha', 'FechaRecep'],
    columnasReales: colsRec, descripcion: 'Columna de Recep con la fecha del albarán/recepción de mercancía.',
  });
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

// Nombres de lista conocidos por categoría — caso real: farmacia jose ya tenía sus listas
// llamadas literalmente "INCENTIVADOS", "INCENTIVADOS ESTRELLA", "MAX ROTACION A/B",
// "RESTO" y "PARADOS", así que se detectan solas sin tocar el asistente. Si otra
// instalación usa nombres distintos, ningún patrón encuentra nada — no rompe nada, solo
// significa que hay que rellenar el asistente a mano como hasta ahora. Exactos (con ^…$)
// donde hay riesgo de falso positivo por substring (p.ej. "INCENTIVADOS" no debe
// confundirse con "INCENTIVADOS ESTRELLA", ni "RESTO" con "RESTO DESCUENTO").
const PATRONES_NOMBRE_LISTA = [
  ['LIST_INCENTIVADOS_STAR', [/^estrella$/i, /^star$/i]],
  ['LIST_INCENTIVADOS',      [/^incentivados?$/i]],
  ['LIST_MAX_ROT_A',         [/rotaci[oó]n\s*a\b/i]],
  ['LIST_MAX_ROT_B',         [/rotaci[oó]n\s*b\b/i]],
  ['LIST_RESTO',             [/^resto$/i]],
  ['LIST_PARADOS',           [/^parados?$/i]],
  ['LIST_CONSOLIDADO',       [/^consolidados?$/i]],
];

// Detecta por nombre qué lista de Farmatic corresponde a cada categoría, para no depender
// de que alguien rellene el asistente a mano cuando la farmacia ya usa nombres
// reconocibles. Nunca pisa una env var que ya esté puesta (manual o de una detección
// anterior) — solo rellena huecos. `listas` es la salida de fetchListasWizard()
// (id/nombre/n_items), la misma que ya se manda en el diagnóstico de cada sync.
function detectarListasPorNombre(listas) {
  const detectado = {};
  for (const [envKey, patrones] of PATRONES_NOMBRE_LISTA) {
    const encontrada = (listas || []).find(l => {
      const nombre = String(l.nombre || '').trim();
      return patrones.some(p => p.test(nombre));
    });
    if (encontrada) detectado[envKey] = encontrada.id;
  }
  return detectado;
}

// ── Mapeo de esquema Farmatic persistente (columnas/tablas) ─────────────────────────
// Antes, cada función que necesitaba adivinar el nombre real de una columna (Cliente,
// Venta, ListaArticu...) tenía su propia lista de candidatos hardcodeada y, si ninguno
// coincidía, se resignaba en silencio — el único que se enteraba era yo, revisando logs
// a mano en una farmacia concreta (caso real: jose con PER_NOMBRE/FIS_NOMBRE). Esto
// generaliza esa resolución con memoria persistente en el backend (farmatic_field_map):
// una vez resuelto un atributo para un tenant, no se vuelve a interpretar — se relee de
// aquí en cada sync. Solo se re-evalúa si el valor guardado deja de existir en las
// columnas reales de esta sync (p.ej. tras una actualización de Farmatic).
let mapeoEsquemaActual = {};
function setMapeoEsquema(mapeo) {
  mapeoEsquemaActual = mapeo || {};
}

// Resuelve un atributo "de fontanería" (columna o tabla real) para `entidad.atributo`:
// 1) valor ya persistido y que sigue existiendo entre las opciones reales de esta sync
//    → se usa tal cual, sin más. Si dejó de existir (p.ej. Farmatic renombró la tabla de
//    un año a otro, caso "Venta" → "Ventas2026"), NO se confía a ciegas — se re-resuelve.
// 2) si no, heurística de candidatos conocidos (gratis, determinista) → si acierta, se
//    persiste en segundo plano (no bloquea el sync) y se devuelve.
// 3) si la heurística no encuentra nada, se pregunta a la IA (candidatos = TODAS las
//    opciones reales) — si responde con confianza alta, el backend la aplica y persiste
//    sola (marcada como pendiente de validar en el panel de admin); si no, la marca como
//    error visible ahí, y aquí se devuelve null, igual que el "omitir" de antes.
async function resolverAtributo({ entidad, atributo, candidatos, opciones, descripcion }) {
  const disponibles = opciones instanceof Set ? opciones : new Set(opciones || []);
  if (!disponibles.size) return null;

  const guardado = mapeoEsquemaActual?.[entidad]?.[atributo];
  if (guardado && disponibles.has(guardado)) return guardado;

  const encontrado = (candidatos || []).find(c => disponibles.has(c));
  if (encontrado) {
    require('./api-client').reportarMapeoResuelto(entidad, atributo, encontrado, 'alta').catch(() => {});
    return encontrado;
  }

  try {
    const r = await require('./api-client').resolverConIA(entidad, atributo, descripcion, [...disponibles].map(nombre => ({ nombre })));
    return (r && r.aplicar) ? r.valor_resuelto : null;
  } catch {
    return null;
  }
}

// Alias semánticos — misma lógica y mismo almacén (farmatic_field_map), solo cambia qué
// se está resolviendo: el nombre real de una COLUMNA dentro de una tabla ya conocida, o
// el nombre real de la propia TABLA (para cuando Farmatic renombra tablas enteras).
function resolverAtributoColumna({ entidad, atributo, candidatos, columnasReales, descripcion }) {
  return resolverAtributo({ entidad, atributo, candidatos, opciones: columnasReales, descripcion });
}
function resolverAtributoTabla({ entidad, atributo, candidatos, tablasReales, descripcion }) {
  return resolverAtributo({ entidad, atributo, candidatos, opciones: tablasReales, descripcion });
}

// Las 7 categorías y su env var — cada una es independiente. Antes exigíamos las 6
// principales completas o no se leía/escribía nada; eso hacía que, si una farmacia real
// no distinguía o no mapeaba bien una sola categoría (nombres de lista distintos a los
// esperados, categoría que no usan...), se perdiera TODO. Ahora cada categoría que tenga
// su env var puesta se lee/escribe; las que falten simplemente no aportan nada para esa
// categoría concreta — se sigue trayendo lo que sí hay y se afina el mapeo más adelante.
const CATEGORIA_ENV = {
  INCENTIVADOS_STAR: 'LIST_INCENTIVADOS_STAR',
  INCENTIVADOS:       'LIST_INCENTIVADOS',
  MAX_ROTACION_A:     'LIST_MAX_ROT_A',
  MAX_ROTACION_B:     'LIST_MAX_ROT_B',
  RESTO:              'LIST_RESTO',
  PARADOS:            'LIST_PARADOS',
  CONSOLIDADO:        'LIST_CONSOLIDADO',
};

// Mismo patrón que CATEGORIA_ENV pero para el color de margen del favorito (verde/amarillo/
// gris, ver asignarColoresPorMU en nextfarma-api) — clasificación independiente de la
// categoría de rotación: un mismo CN favorito puede estar a la vez en su lista de categoría
// (p.ej. MAX_ROTACION_A) y en su lista de color (p.ej. VERDE).
const COLOR_ENV = {
  verde:    'LIST_COLOR_VERDE',
  amarillo: 'LIST_COLOR_AMARILLO',
  gris:     'LIST_COLOR_GRIS',
  negro:    'LIST_COLOR_NEGRO',
};

// Categorías que ni la config guardada ni la detección por nombre han resuelto todavía
// (sin env var puesta). Se usa para avisar al titular en el SaaS de que puede terminar
// de configurar el wizard — nunca para escribir ni para bloquear el sync.
function categoriasSinResolver() {
  return Object.entries(CATEGORIA_ENV)
    .filter(([, envKey]) => !process.env[envKey])
    .map(([categoria]) => categoria);
}

// Lista IDs → categoría (para leer favoritos de Farmatic). Sin ninguna configurada → null
// (leer desactivado del todo). Con al menos una configurada, se usa esa parcialmente.
function getListaCategoria() {
  const map = {};
  for (const [categoria, envKey] of Object.entries(CATEGORIA_ENV)) {
    if (process.env[envKey]) map[parseInt(process.env[envKey])] = categoria;
  }
  return Object.keys(map).length ? map : null;
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

// Contexto de dominio compartido por TODOS los diagnósticos de "búsqueda amplia" de
// favoritos — no un texto genérico de una sola vez. Cuantos más casos reales vayamos
// viendo, más se enriquece (el titular pidió explícitamente ir mejorando el prompt con el
// tiempo en vez de dejarlo abstracto). Los ejemplos concretos (jose, jose-2) ayudan a la IA
// a reconocer variantes que una descripción puramente abstracta no sugiere.
const CONTEXTO_FAVORITOS_IA =
  'Contexto de instalaciones reales ya vistas: la farmacia "jose" tiene 7 listas separadas ' +
  'por categoría dentro de ListaArticu/ItemListaArticu (una por STAR/INCENTIVADOS/ROTACION_A/B/' +
  'RESTO/PARADOS/CONSOLIDADO) — el mecanismo estándar de Farmatic. Otro caso real ("jose-2") no ' +
  'tenía esas 7 categorías, sino UNA sola lista genérica dentro de ListaArticu, con un nombre que ' +
  'ni siquiera mencionaba "favorito" (se llamaba "SELECCION PROPIA") — la IA acertó igualmente ' +
  'razonando que era una selección manual sin categoría específica, no por coincidencia de texto. ' +
  'Puede haber un TERCER patrón: una tabla completamente propia/personalizada de la farmacia, fuera ' +
  'del mecanismo de listas de Farmatic, con nombres variados (FAVORIT_FARMACIA, SELECCION, ' +
  'PREFERENTES, etc. — el nombre puede no contener literalmente la palabra "favorito"). ' +
  'Señal de calidad importante en cualquiera de los tres casos: un favorito real es COMO MUCHO 1 por ' +
  'grupo homogéneo (CH) — si una tabla o lista tiene VARIOS códigos para el mismo grupo, es motivo ' +
  'fuerte para sospechar que NO es una lista de favoritos (podría ser stock, promociones, pedidos, u ' +
  'otra cosa), y debe bajar la confianza de esa candidata aunque el nombre suene prometedor. AVISO de ' +
  'un falso positivo real ya visto: la tabla "Encargo" (pedidos/encargos de clientes) puede tener por ' +
  'pura coincidencia códigos válidos con como mucho 1 por grupo (cada encargo es de un producto suelto) ' +
  'y aun así NO tiene nada que ver con favoritos — es una tabla operativa de pedidos, no de preferencias ' +
  'del titular. Lo mismo aplica a cualquier tabla de recepciones (Recep/LineaRecep), facturas o ventas: ' +
  'que los códigos sean válidos y sin duplicados por grupo es NECESARIO pero no SUFICIENTE — hace falta ' +
  'además que el NOMBRE o el CONTEXTO de la tabla sugiera selección/preferencia manual del titular, no ' +
  'una operación transaccional normal (pedir, recibir, vender). Ante la duda entre una tabla claramente ' +
  'operativa (Encargo, Recep, Venta, Factura...) y otra sin ese significado operativo evidente, prefiere ' +
  'siempre la segunda aunque tenga menos filas.'

// Cuenta, para una lista de ItemListaArticu concreta, cuántos grupos homogéneos tienen más
// de 1 CN — señal de alarma compartida por resolverListaFavoritosUnica y
// resolverTablaFavoritosGenerica (ver CONTEXTO_FAVORITOS_IA).
async function gruposConMasDeUnCn(p, idLista) {
  const r = await p.request().query(`
    SELECT COUNT(*) AS n FROM (
      SELECT g.IdGrupoGen FROM ItemListaArticu i
      JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(i.XItem_IdArticu AS VARCHAR)
      WHERE i.XItem_IdLista = ${idLista}
      GROUP BY g.IdGrupoGen HAVING COUNT(*) > 1
    ) x
  `).catch(() => ({ recordset: [{ n: 0 }] }));
  return Number(r.recordset[0]?.n || 0);
}

// Farmacias sin las 7 listas de categoría configuradas (getListaCategoria() → null) pueden
// tener en su lugar UNA sola lista genérica de favoritos, mezclando todas las categorías —
// la IA ayuda a localizarla entre las listas reales de la instalación, mismo patrón que
// resolverAtributoColumna/Tabla para columnas y tablas de Farmatic (candidatos_ia,
// aceptar/rechazar desde el panel admin). Solo aporta IDENTIDAD de favorito — nunca
// categoría: esos GH quedan para que el propio SaaS sugiera categoría con su lógica de
// rotación/ventas (categoria_sugerida), igual que cualquier GH sin categoría manual.
async function resolverListaFavoritosUnica() {
  const p = await getPool();
  const listas = await fetchListasWizard();
  const mapeadas = new Set(Object.keys(getListaCategoria() || {}).map(Number));
  const candidatas = listas.filter(l => !mapeadas.has(l.id) && l.n_items > 0);
  if (!candidatas.length) return null;

  // Atajo determinista: una lista literalmente llamada "Favoritos" (o muy parecido) con
  // contenido es, casi con toda seguridad, la que buscamos — se usa directamente, sin
  // gastar una llamada a la IA (ni las tandas de abajo) para algo tan obvio.
  const exacta = candidatas.find(l => /^favoritos?$/i.test(String(l.nombre || '').trim()));
  if (exacta) {
    // Se persiste igual que un acierto por heurística (aunque no se haya llamado a la
    // IA) — si no, este atajo es invisible en el panel admin, indistinguible de "no
    // detectado todavía".
    require('./api-client').reportarMapeoResuelto(
      'LISTA_ARTICU', 'lista_favoritos_unica', `${exacta.id} - ${exacta.nombre}`, 'alta'
    ).catch(() => {});
    return exacta.id;
  }

  // Si ya se resolvió en un sync anterior y esa lista sigue existiendo, se usa tal cual sin
  // llamar a la IA — el caché normal de resolverAtributo es por tanda (ver bucle de abajo),
  // no global, así que sin este atajo cada sync repetiría toda la búsqueda por tandas aunque
  // ya se supiera la respuesta.
  const todasOpciones = new Set(candidatas.map(l => `${l.id} - ${l.nombre}`));
  const guardado = mapeoEsquemaActual?.LISTA_ARTICU?.lista_favoritos_unica;
  if (guardado && todasOpciones.has(guardado)) {
    const idGuardado = parseInt(guardado.split(' - ')[0], 10);
    if (Number.isFinite(idGuardado)) return idGuardado;
  }

  const conAlarma = await Promise.all(
    candidatas.map(async l => ({ ...l, grupos_con_mas_de_1_cn: await gruposConMasDeUnCn(p, l.id) }))
  );

  // Farmacias con muchas listas (cientos, algunas con miles de artículos — caso real: 333
  // listas en una farmacia) mandaban TODAS como candidatas a la IA en un único prompt enorme
  // — lento y con más probabilidad de fallar. Una lista real de favoritos tiene, por
  // construcción, un favorito por grupo homogéneo — pocos o ningún grupo con más de un CN
  // dentro, a diferencia de catálogos/almacenes/listas de proveedor que mezclan muchos CN
  // por grupo. Se ordena por esa proporción y se manda a la IA en tandas pequeñas,
  // probando primero las más plausibles y parando en cuanto una tanda resuelve — así no
  // hace falta acertar el recorte a la primera, solo tener buen orden de búsqueda. Tope de
  // tandas para acotar el coste en el caso extremo de cientos de listas igual de "limpias".
  const TAM_TANDA = 20;
  const MAX_TANDAS = 10;
  const ranking = [...conAlarma].sort((a, b) =>
    (a.grupos_con_mas_de_1_cn / a.n_items) - (b.grupos_con_mas_de_1_cn / b.n_items) ||
    a.grupos_con_mas_de_1_cn - b.grupos_con_mas_de_1_cn
  );
  for (let i = 0; i < ranking.length && i / TAM_TANDA < MAX_TANDAS; i += TAM_TANDA) {
    const tanda = ranking.slice(i, i + TAM_TANDA);
    const heuristicos = tanda
      .filter(l => /favorit|preferen|recomend/i.test(l.nombre) && l.grupos_con_mas_de_1_cn === 0)
      .map(l => `${l.id} - ${l.nombre}`);
    const opciones = new Set(tanda.map(l => `${l.id} - ${l.nombre}`));
    const numTanda = Math.floor(i / TAM_TANDA) + 1;
    const elegido = await resolverAtributoTabla({
      entidad: 'LISTA_ARTICU', atributo: 'lista_favoritos_unica',
      candidatos: heuristicos, tablasReales: opciones,
      descripcion: `${CONTEXTO_FAVORITOS_IA} Esta farmacia no tiene configuradas las 7 listas de ` +
        'categoría de favoritos. De estas listas reales de Farmatic sin mapear a ninguna categoría ' +
        `(tanda ${numTanda}, ${tanda.length} de ${ranking.length} candidatas totales, ordenadas de más ` +
        'a menos plausible), ¿cuál es la más probable candidata a ser "la lista de favoritos" de la ' +
        'farmacia? Si ninguna de esta tanda encaja razonablemente, devuelve un array vacío — se seguirá ' +
        'buscando en el resto. Formato "id - nombre — nº de artículos, grupos con >1 CN [alarma]": ' +
        tanda.map(l => `${l.id} - ${l.nombre} — ${l.n_items} artículos, ${l.grupos_con_mas_de_1_cn} grupos con >1 CN`).join('; '),
    });
    if (elegido) {
      const id = parseInt(elegido.split(' - ')[0], 10);
      if (Number.isFinite(id)) return id;
    }
  }
  return null;
}

// Último recurso cuando ni las 7 categorías ni una lista dentro de ListaArticu resuelven el
// favorito: escanea TODAS las tablas reales de la instalación (no solo ListaArticu) buscando
// alguna que pueda representar "favoritos" fuera del mecanismo estándar de listas de Farmatic
// — caso real: una tabla propia/custom que la farmacia nunca gestionó como lista de Farmatic.
// Mucho más caro que los dos casos anteriores (por eso es el ÚLTIMO fallback, no el primero),
// pero necesario para no fallar nunca ante una instalación inesperada.
async function resolverTablaFavoritosGenerica() {
  const p = await getPool();

  // 1) Todas las tablas reales con nº de filas aproximado (metadata de SQL Server, barato —
  // nada de COUNT(*) por tabla). Se descartan vacías o enormes: una lista de favoritos real
  // es pequeña (decenas a pocos miles), nunca el catálogo entero.
  const tablasR = await p.request().query(`
    SELECT t.name AS tabla, SUM(p.rows) AS n_filas
    FROM sys.tables t
    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
    GROUP BY t.name
    HAVING SUM(p.rows) BETWEEN 1 AND 200000
  `).catch(() => ({ recordset: [] }));
  if (!tablasR.recordset.length) return null;

  // 2) Columnas de esas tablas cuyo NOMBRE sugiere que podrían contener un código nacional
  // (heurística barata; el filtrado real y caro es el paso 3, contra datos de verdad).
  const nombresTablas = tablasR.recordset.map(r => r.tabla);
  const colsR = await p.request().query(`
    SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${nombresTablas.map(t => `'${t}'`).join(',')})
      AND (COLUMN_NAME LIKE '%CN%' OR COLUMN_NAME LIKE '%ARTIC%' OR COLUMN_NAME LIKE '%CODIGO%'
           OR COLUMN_NAME LIKE '%COD_NAC%' OR COLUMN_NAME LIKE '%NACIONAL%')
  `).catch(() => ({ recordset: [] }));
  if (!colsR.recordset.length) return null;

  // 3) Para cada (tabla, columna) candidata: cuántos valores casan de verdad con un CN real
  // del catálogo (GeneArti) — descarta columnas que por nombre parecían prometedoras pero en
  // la práctica no contienen CN reales — y cuántos grupos homogéneos tienen MÁS DE 1 CN en
  // esa tabla (señal de alarma, ver CONTEXTO_FAVORITOS_IA).
  const candidatas = [];
  for (const { tabla, columna } of colsR.recordset) {
    const check = await p.request().query(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT g.IdGrupoGen) AS grupos_distintos,
        SUM(CASE WHEN g.IdGrupoGen IS NOT NULL THEN 1 ELSE 0 END) AS coinciden_cn
      FROM ${tabla} t
      LEFT JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(t.${columna} AS VARCHAR)
    `).catch(() => ({ recordset: [] }));
    const row = check.recordset[0];
    if (!row || !row.total || !row.coinciden_cn) continue;
    if (row.coinciden_cn / row.total < 0.5) continue; // la mayoría ni siquiera son CN reales

    const dupR = await p.request().query(`
      SELECT COUNT(*) AS n
      FROM (
        SELECT g.IdGrupoGen FROM ${tabla} t
        JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(t.${columna} AS VARCHAR)
        GROUP BY g.IdGrupoGen HAVING COUNT(*) > 1
      ) x
    `).catch(() => ({ recordset: [{ n: 0 }] }));

    candidatas.push({
      tabla, columna, n_items: Number(row.total), n_cn_validos: Number(row.coinciden_cn),
      grupos_distintos: Number(row.grupos_distintos),
      grupos_con_mas_de_1_cn: Number(dupR.recordset[0]?.n || 0),
    });
  }
  if (!candidatas.length) return null;

  const opciones = new Set(candidatas.map(c => `${c.tabla}.${c.columna}`));
  const elegido = await resolverAtributoTabla({
    entidad: 'TABLA_GENERICA', atributo: 'favoritos_fuera_de_listaarticu',
    candidatos: [], tablasReales: opciones,
    descripcion: `${CONTEXTO_FAVORITOS_IA} No se encontraron favoritos ni en las 7 listas de ` +
      'categoría ni en ninguna lista de ListaArticu — puede que esta farmacia use una tabla ' +
      'propia/personalizada. De las tablas reales de esta instalación con una columna que contiene ' +
      'códigos nacionales (CN) válidos, ¿cuál es la más probable candidata a representar "los ' +
      'favoritos"? Formato "tabla.columna — filas, CN válidos, grupos distintos, grupos con >1 CN ' +
      '[alarma]": ' +
      candidatas.map(c =>
        `${c.tabla}.${c.columna} — ${c.n_items} filas, ${c.n_cn_validos} CN válidos, ` +
        `${c.grupos_distintos} grupos distintos, ${c.grupos_con_mas_de_1_cn} grupos con >1 CN`
      ).join('; '),
  })
  if (!elegido) return null
  const [tabla, columna] = elegido.split('.')
  return { tabla, columna }
}

async function fetchFavoritosActuales() {
  const lcat = getListaCategoria();
  let idUnica = null
  let tablaGenerica = null
  if (!lcat) {
    idUnica = await resolverListaFavoritosUnica()
    if (idUnica == null) {
      tablaGenerica = await resolverTablaFavoritosGenerica()
      if (tablaGenerica == null) return new Map();
    }
  }
  const p   = await getPool();
  const cdb = CONSEJO_DB();
  // ch = grupo homogéneo OFICIAL (CODConjunto del Consejo General, el mismo que usa todo
  // el resto del SaaS vía cns.ch/grupos_homogeneos.ch — ver fetchProductos()) — NUNCA
  // GeneArti.IdGrupoGen, que es una agrupación interna y propietaria de Farmatic con su
  // propia numeración, completamente distinta e incompatible con la del Consejo (bug real
  // encontrado en jose-2: favoritos guardados con IdGrupoGen no encajaban con ningún grupo
  // real, y en 2 casos coincidían por pura casualidad numérica con OTRO grupo distinto).
  // Si el CN no tiene CODConjunto (no todo producto pertenece a un grupo homogéneo oficial
  // — típico en jose/jose-2, con ~70-90% del catálogo sin CODConjunto), se sintetiza un
  // "ch" negativo único a partir del propio CN — nunca colisiona con un ch real (siempre
  // positivo) y permite que sembrarFavoritosReales() lo detecte como "sin categoría
  // calculable" y lo meta en RESTO en vez de perder el favorito real del titular.
  if (tablaGenerica) {
    try {
      const r = await p.request().query(`
        SELECT t.${tablaGenerica.columna} AS cn,
               COALESCE(bpc.CODConjunto, -CAST(t.${tablaGenerica.columna} AS INT)) AS ch
        FROM ${tablaGenerica.tabla} t
        LEFT JOIN ${cdb}.dbo.BP_CONJARTI bpc
          ON LTRIM(RTRIM(bpc.CODIGO)) = LTRIM(RTRIM(CAST(t.${tablaGenerica.columna} AS VARCHAR)))
          AND bpc.CODCCAA = 0
      `);
      const porGH = new Map();
      for (const row of r.recordset) {
        if (!porGH.has(row.ch)) porGH.set(row.ch, row.cn);
      }
      return porGH;
    } catch (e) {
      log.warn('fetchFavoritosActuales (tabla genérica) falló:', e.message);
      return new Map();
    }
  }
  const ids  = lcat ? Object.keys(lcat).join(',') : String(idUnica);
  try {
    const result = await p.request().query(`
      SELECT i.XItem_IdLista AS lista, i.XItem_IdArticu AS cn,
             COALESCE(bpc.CODConjunto, -CAST(i.XItem_IdArticu AS INT)) AS ch
      FROM ItemListaArticu i
      LEFT JOIN ${cdb}.dbo.BP_CONJARTI bpc
        ON LTRIM(RTRIM(bpc.CODIGO)) = LTRIM(RTRIM(CAST(i.XItem_IdArticu AS VARCHAR)))
        AND bpc.CODCCAA = 0
      WHERE i.XItem_IdLista IN (${ids})
    `);
    const PRIORIDAD = lcat ? Object.keys(lcat).map(Number).sort((a, b) => a - b) : [idUnica];
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
  const colBaja = await resolverAtributoColumna({
    entidad: 'VENDEDOR', atributo: 'baja_columna', candidatos: ['Baja', 'BajaVend', 'FechaBaja'],
    columnasReales: colsVendedor, descripcion: 'Columna de la tabla Vendedor que marca si un vendedor/empleado está de baja (inactivo). Puede ser un booleano o una fecha de baja.',
  });
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

// Da de alta en Farmatic (tabla Vendedor) a un empleado creado desde NextFarma que
// todavía no existía allí. Mismo criterio defensivo que
// asegurarListasCategoria(): si IdVendedor no es autonumérico, no se
// adivina un id a mano — se aborta ese alta concreta y se reporta como error (queda
// visible para el titular, no se pierde en silencio). El nombre de columna se resuelve
// con el mismo mapeo persistente que el resto del esquema; los apellidos por separado
// solo se usan si esa instalación los tiene — si no, se concatenan en el único campo de
// nombre disponible (caso real: farmacia jose solo tiene NOMBRE, sin Apellido1/2).
async function procesarVendedoresPendientes(pendientes) {
  const p = await getPool();
  const resultados = [];
  if (!pendientes || !pendientes.length) return resultados;

  const identityR = await p.request().query(
    `SELECT COLUMNPROPERTY(OBJECT_ID('Vendedor'), 'IdVendedor', 'IsIdentity') AS es_identity`
  ).catch(() => ({ recordset: [] }));
  const esIdentity = identityR.recordset[0]?.es_identity === 1;

  const colsR = await p.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Vendedor'`
  ).catch(() => ({ recordset: [] }));
  const colsVendedor = new Set(colsR.recordset.map(r => String(r.COLUMN_NAME)));

  const colNombre = await resolverAtributoColumna({
    entidad: 'VENDEDOR', atributo: 'nombre', candidatos: ['Nombre', 'NOMBRE'],
    columnasReales: colsVendedor, descripcion: 'Columna de la tabla Vendedor con el nombre completo del empleado.',
  });
  const colApellido1 = await resolverAtributoColumna({
    entidad: 'VENDEDOR', atributo: 'apellido1', candidatos: ['Apellido1', 'APELLIDO1'],
    columnasReales: colsVendedor, descripcion: 'Columna de la tabla Vendedor con el primer apellido, si existe por separado del nombre.',
  });
  const colApellido2 = await resolverAtributoColumna({
    entidad: 'VENDEDOR', atributo: 'apellido2', candidatos: ['Apellido2', 'APELLIDO2'],
    columnasReales: colsVendedor, descripcion: 'Columna de la tabla Vendedor con el segundo apellido, si existe por separado del nombre.',
  });

  if (!esIdentity || !colNombre) {
    const motivo = !esIdentity
      ? 'Vendedor.IdVendedor no es autonumérico — no se puede generar un id seguro'
      : 'No se encontró ninguna columna de nombre reconocible en Vendedor';
    log.warn('Alta de vendedores omitida: ' + motivo);
    return pendientes.map(v => ({ id: v.id, ok: false, error: motivo }));
  }

  for (const v of pendientes) {
    try {
      const nombreCompleto = [v.nombre, v.apellido1, v.apellido2].filter(Boolean).join(' ');
      const req = p.request();
      const cols = [colNombre], placeholders = ['@nombre'];
      req.input('nombre', sql.VarChar, (colApellido1 || colApellido2) ? v.nombre : nombreCompleto);
      if (colApellido1) { cols.push(colApellido1); placeholders.push('@apellido1'); req.input('apellido1', sql.VarChar, v.apellido1 || ''); }
      if (colApellido2) { cols.push(colApellido2); placeholders.push('@apellido2'); req.input('apellido2', sql.VarChar, v.apellido2 || ''); }
      const r = await req.query(
        `INSERT INTO Vendedor (${cols.join(', ')}) OUTPUT INSERTED.IdVendedor AS id VALUES (${placeholders.join(', ')})`
      );
      const nuevoId = r.recordset[0]?.id;
      log.info(`✓ Vendedor creado en Farmatic: ${nombreCompleto} (id ${nuevoId})`);
      resultados.push({ id: v.id, ok: true, vendedor_id_asignado: nuevoId });
    } catch (e) {
      log.warn(`Alta de vendedor "${v.nombre}" falló:`, e.message);
      resultados.push({ id: v.id, ok: false, error: e.message });
    }
  }
  return resultados;
}

// Categoría → lista ID (para escribir favoritos en Farmatic). Mismo criterio permisivo
// que getListaCategoria(): cada categoría configurada se escribe, las que falten se
// omiten individualmente (procesarCambiosPendientes ya loguea "categoría desconocida"
// por cada cambio que caiga en una categoría sin lista, sin tocar las demás).
function getCategoriaLista() {
  const map = {};
  for (const [categoria, envKey] of Object.entries(CATEGORIA_ENV)) {
    if (process.env[envKey]) map[categoria] = parseInt(process.env[envKey]);
  }
  return Object.keys(map).length ? map : null;
}

// Asegura que las 7 listas de categoría existan en Farmatic (ListaArticu), creando las
// que falten — idempotente, no vuelve a crear si ya existen (mira el env var antes).
// Cualquier duda sobre el esquema real (tabla, columna de nombre, autonumérico) aborta
// sin escribir nada — mejor no crear nada que crear algo mal en una BBDD de producción
// real. Devuelve el id de lista de CADA categoría (recién creada o ya existente antes),
// para que tanto la siembra de favoritos reales (fase A) como la de "más vendido" (fase
// B, al final del sync) puedan usarlas sin tener que volver a crear nada.
// Los "return null" de aquí antes eran invisibles fuera de esta función — solo un
// log.warn LOCAL del agente, nunca reportado al backend, así que un fallo aquí (tabla
// inexistente, columna no reconocida, IdLista sin autonumérico) no dejaba ningún rastro
// consultable desde el panel de admin (caso real: no se pudo confirmar si Jose-2 había
// creado sus listas o no sin pedirle capturas de pantalla al cliente). Ahora se devuelve
// el motivo explícito para que sembrarFavoritosReales() lo propague y sync.js lo reporte
// con warn() — mismo mecanismo que ya usan los avisos de ventas (last_sync_warnings_detalle).
// Valor SQL seguro para rellenar una columna NOT NULL sin default, según su tipo — evita
// tener que adivinar de antemano el nombre de cada columna "rara" que pueda tener una
// instalación real de Farmatic (ver columnasObligatorias más abajo). Devuelve null para
// tipos que no sabemos rellenar razonablemente (binary, xml, tipos definidos por el usuario…)
// — en ese caso se deja que el INSERT falle y se reporte, mejor que adivinar mal.
function valorSeguroPorTipo(tipoSql) {
  const t = String(tipoSql || '').toLowerCase();
  if (['int', 'smallint', 'tinyint', 'bigint', 'bit', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(t)) return '0';
  if (['datetime', 'datetime2', 'date', 'smalldatetime', 'datetimeoffset'].includes(t)) return 'GETDATE()';
  if (['uniqueidentifier'].includes(t)) return 'NEWID()';
  if (['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext'].includes(t)) return "''";
  return null;
}

// Tipo mssql para ligar como parámetro un valor ya existente (copiado de una fila de
// referencia o de una tabla referenciada por FK) — a diferencia de valorSeguroPorTipo (que
// genera un literal SQL de emergencia), aquí el valor es un dato real que hay que mandar tal
// cual, con el tipo correcto para que SQL Server no lo rechace por conversión.
function sqlTipoBind(tipoSql) {
  const t = String(tipoSql || '').toLowerCase();
  if (['int', 'smallint', 'tinyint', 'bigint'].includes(t)) return sql.Int;
  if (t === 'bit') return sql.Bit;
  if (['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(t)) return sql.Decimal;
  if (['datetime', 'datetime2', 'date', 'smalldatetime', 'datetimeoffset'].includes(t)) return sql.DateTime;
  if (t === 'uniqueidentifier') return sql.UniqueIdentifier;
  return sql.VarChar;
}

// A partir de INFORMATION_SCHEMA.COLUMNS (con IS_NULLABLE/COLUMN_DEFAULT), qué columnas hay
// que rellenar sí o sí en un INSERT — NOT NULL, sin default, y no ya cubiertas a mano
// (identity, la columna de nombre, o las que ya se van a insertar explícitamente). Sustituye
// a la lista fija de nombres "conocidos" (Fecha/NumElem/Tipo/EnviarGrupo) que antes había que
// ampliar a mano — y con ella, sacar una nueva versión — cada vez que una farmacia real tenía
// una columna NOT NULL distinta.
function columnasObligatorias(colsInfo, yaCubiertas) {
  return colsInfo
    .filter(c => c.IS_NULLABLE === 'NO' && !c.COLUMN_DEFAULT && !yaCubiertas.has(c.COLUMN_NAME))
    .map(c => ({ nombre: c.COLUMN_NAME, valor: valorSeguroPorTipo(c.DATA_TYPE) }))
    .filter(c => c.valor != null);
}

// Intenta el INSERT y, si SQL Server lo rechaza por una columna NOT NULL que
// columnasObligatorias no había detectado (metadata desactualizada, columna añadida después
// del barrido de esquema…), parsea el nombre de esa columna del propio mensaje de error de
// SQL Server ("Cannot insert the value NULL into column 'X'…") y reintenta añadiéndola — red
// de seguridad además del chequeo proactivo, no en vez de él. Hasta 5 columnas nuevas
// descubiertas así en una misma llamada (instalaciones reales pueden tener varias columnas
// NOT NULL que la metadata no reflejaba bien) — para la MISMA columna solo se prueba una vez;
// si vuelve a fallar (p.ej. un CHECK o FOREIGN KEY que un valor genérico no puede satisfacer),
// se rinde y devuelve el error de SQL Server tal cual para que quede reportado.
async function insertarConReintentoPorColumna(p, tabla, colsInfo, columnasBase, valoresBase, params, opts = {}) {
  const { outputCol, guardSql } = opts;
  let columnas = [...columnasBase];
  let valores  = [...valoresBase];
  const yaProbadas = new Set(columnas);
  for (let intento = 0; intento < 6; intento++) {
    const req = p.request();
    for (const prm of params) req.input(prm.nombre, prm.tipo, prm.valor);
    try {
      const r = await req.query(
        `${guardSql || ''}INSERT INTO ${tabla} (${columnas.join(', ')})${outputCol ? ` OUTPUT INSERTED.${outputCol} AS id` : ''} VALUES (${valores.join(', ')})`
      );
      return { ok: true, id: r.recordset?.[0]?.id };
    } catch (err) {
      const colFaltante = /column '([^']+)'/i.exec(err.message)?.[1];
      const info = colFaltante && colsInfo.find(c => c.COLUMN_NAME === colFaltante);
      const valorExtra = info && valorSeguroPorTipo(info.DATA_TYPE);
      if (colFaltante && !yaProbadas.has(colFaltante) && valorExtra != null) {
        columnas.push(colFaltante);
        valores.push(valorExtra);
        yaProbadas.add(colFaltante);
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: `Se agotaron los reintentos de columnas para ${tabla}` };
}

// Si una columna obligatoria es además clave foránea, un valor genérico (0, NEWID()…) casi
// siempre viola la FK — en vez de adivinar, se busca un valor real ya existente en la tabla
// referenciada. `topValoresFk` cachea por (tabla,columna) dentro de un mismo sync para no
// repetir la consulta en cada lista creada.
const cacheValoresFk = new Map();
async function valorFkExistente(p, tablaRef, columnaRef) {
  const clave = `${tablaRef}.${columnaRef}`;
  if (cacheValoresFk.has(clave)) return cacheValoresFk.get(clave);
  const r = await p.request().query(`SELECT TOP 1 ${columnaRef} AS v FROM ${tablaRef}`).catch(() => ({ recordset: [] }));
  const v = r.recordset[0]?.v ?? null;
  cacheValoresFk.set(clave, v);
  return v;
}

async function obtenerForeignKeys(p, tabla) {
  const r = await p.request().query(`
    SELECT c.name AS columna, rt.name AS tabla_ref, rc.name AS columna_ref
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns c  ON c.object_id  = fkc.parent_object_id     AND c.column_id  = fkc.parent_column_id
    JOIN sys.tables  rt ON rt.object_id = fk.referenced_object_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE fk.parent_object_id = OBJECT_ID('${tabla}')
  `).catch(() => ({ recordset: [] }));
  return r.recordset;
}

// Genérico: crea (si faltan) las listas de un "esquema" bucket→env var — usado tanto para
// las 7 de categoría (CATEGORIA_ENV) como para las 3 de color de margen (COLOR_ENV). Mismo
// nombre "NextFarma - {BUCKET}" en ambos casos, así que reutilizar esto en vez de duplicar
// la función evita que un fix (p.ej. las columnas extra de ListaArticu) se aplique a una y
// se olvide en la otra.
async function asegurarListas(envMap) {
  const p = await getPool();

  const tblR = await p.request().query(`SELECT name FROM sys.tables WHERE name = 'ListaArticu'`)
    .catch(() => ({ recordset: [] }));
  if (!tblR.recordset.length) {
    const motivo = 'no existe la tabla ListaArticu';
    log.warn('Auto-creación de listas omitida: ' + motivo);
    return { omitida: true, motivo };
  }
  const colsR = await p.request().query(
    `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ListaArticu'`
  ).catch(() => ({ recordset: [] }));
  const colsInfo = colsR.recordset;
  const cols = new Set(colsInfo.map(r => String(r.COLUMN_NAME)));
  const colNombre = await resolverAtributoColumna({
    entidad: 'LISTA_ARTICU', atributo: 'nombre', candidatos: ['Nombre', 'Descripcion'],
    columnasReales: cols, descripcion: 'Columna de ListaArticu con el nombre/descripción visible de cada lista de artículos.',
  });
  if (!colNombre) {
    const motivo = 'ListaArticu no tiene columna Nombre/Descripcion reconocible';
    log.warn('Auto-creación de listas omitida: ' + motivo);
    return { omitida: true, motivo };
  }
  const identityR = await p.request().query(
    `SELECT COLUMNPROPERTY(OBJECT_ID('ListaArticu'), 'IdLista', 'IsIdentity') AS es_identity`
  ).catch(() => ({ recordset: [] }));
  // Caso real visto en Jose-2: IdLista es un INT PRIMARY KEY normal, NO autonumérico — antes
  // esto hacía renunciar a crear listas por completo. En vez de exigir identity, si no lo es
  // se calcula a mano el siguiente id libre (MAX(IdLista)+1) antes de cada INSERT — se
  // recalcula en cada vuelta del bucle, así que ve el id recién insertado de la lista
  // anterior dentro de este mismo ciclo (nunca colisiona consigo mismo).
  const esIdentity = identityR.recordset[0]?.es_identity === 1;

  // ListaArticu suele tener más columnas que Nombre/Descripcion (caso real visto en Jose-2:
  // Fecha, NumElem, Tipo, EnviarGrupo) — el barrido de esquema no captura si son NOT NULL sin
  // default, así que en vez de asumir que solo Nombre/Descripcion son obligatorias, se
  // detectan directamente por metadata (columnasObligatorias) y se rellenan con un valor
  // seguro según su tipo. El reintento por error (insertarConReintentoPorColumna) cubre
  // además cualquier NOT NULL que la metadata no reflejara.
  const obligatorias = columnasObligatorias(colsInfo, new Set(['IdLista', colNombre]));

  // Antes de adivinar por tipo, se mira si ya existe una lista real en Farmatic (una propia
  // de la farmacia, o una "NextFarma - X" creada en un ciclo anterior) y se copian sus
  // valores para las columnas obligatorias — un valor que YA está en una fila real es, por
  // definición, válido para cualquier CHECK/FOREIGN KEY que tenga la tabla, sin necesidad de
  // conocer esas restricciones de antemano. Si no hay ninguna fila (instalación sin listas
  // todavía), se cae a mirar si la columna es una FK con datos en la tabla referenciada, y
  // en último caso a un valor genérico por tipo (valorSeguroPorTipo).
  const referenciaR = await p.request().query(`SELECT TOP 1 * FROM ListaArticu`).catch(() => ({ recordset: [] }));
  const filaReferencia = referenciaR.recordset[0] || null;
  const fks = await obtenerForeignKeys(p, 'ListaArticu');
  const fkPorColumna = new Map(fks.map(f => [f.columna, f]));

  const obligatoriasResueltas = [];
  for (const c of obligatorias) {
    const info = colsInfo.find(ci => ci.COLUMN_NAME === c.nombre);
    if (filaReferencia && filaReferencia[c.nombre] != null) {
      obligatoriasResueltas.push({ ...c, valorReal: filaReferencia[c.nombre], tipoBind: sqlTipoBind(info?.DATA_TYPE) });
      continue;
    }
    const fk = fkPorColumna.get(c.nombre);
    if (fk) {
      const real = await valorFkExistente(p, fk.tabla_ref, fk.columna_ref);
      if (real != null) { obligatoriasResueltas.push({ ...c, valorReal: real, tipoBind: sqlTipoBind(info?.DATA_TYPE) }); continue; }
    }
    obligatoriasResueltas.push(c); // sin fila de referencia ni FK con datos — valor genérico por tipo
  }

  // La columna de nombre puede tener menos hueco del que ocupa "NextFarma - CATEGORIA" —
  // se recorta al límite real en vez de arriesgarse a un truncamiento que a veces ni siquiera
  // nombra la columna en el mensaje de error (no se podría reintentar sobre eso).
  const maxNombre = colsInfo.find(c => c.COLUMN_NAME === colNombre)?.CHARACTER_MAXIMUM_LENGTH;

  const columnasBase = [colNombre, ...obligatoriasResueltas.map(c => c.nombre)];

  const creadas = [];
  const fallos = [];
  const faltantes = Object.keys(envMap).filter(bucket => !process.env[envMap[bucket]]);
  for (const bucket of faltantes) {
    const nombreLista = `NextFarma - ${bucket}`;
    const nombreAjustado = (maxNombre > 0 && nombreLista.length > maxNombre)
      ? nombreLista.slice(0, maxNombre) : nombreLista;
    const columnas = [...columnasBase];
    const valores  = ['@nombre'];
    const params   = [{ nombre: 'nombre', tipo: sql.VarChar, valor: nombreAjustado }];
    obligatoriasResueltas.forEach((c, i) => {
      if (c.valorReal != null) {
        const pname = `real${i}`;
        valores.push(`@${pname}`);
        params.push({ nombre: pname, tipo: c.tipoBind, valor: c.valorReal });
      } else {
        valores.push(c.valor);
      }
    });
    if (!esIdentity) {
      const siguienteR = await p.request().query(`SELECT ISNULL(MAX(IdLista), 0) + 1 AS siguiente FROM ListaArticu`)
        .catch(() => ({ recordset: [{ siguiente: null }] }));
      const siguienteId = siguienteR.recordset[0]?.siguiente;
      if (!siguienteId) {
        log.warn(`No se pudo calcular el siguiente IdLista para ${bucket} (no autonumérico)`);
        fallos.push(`${bucket}: no se pudo calcular un IdLista libre`);
        continue;
      }
      columnas.push('IdLista');
      valores.push('@idlista');
      params.push({ nombre: 'idlista', tipo: sql.Int, valor: siguienteId });
    }
    const resultado = await insertarConReintentoPorColumna(
      p, 'ListaArticu', colsInfo, columnas, valores, params, { outputCol: 'IdLista' }
    );
    if (resultado.ok && resultado.id) {
      creadas.push({ categoria: bucket, lista_id: resultado.id });
      process.env[envMap[bucket]] = String(resultado.id);
    } else if (!resultado.ok) {
      log.warn(`No se pudo crear la lista de ${bucket}:`, resultado.error);
      fallos.push(`${bucket}: ${resultado.error}`);
    }
  }

  const listaIdPorBucket = new Map();
  for (const bucket of Object.keys(envMap)) {
    const id = process.env[envMap[bucket]];
    if (id) listaIdPorBucket.set(bucket, parseInt(id, 10));
  }
  return { creadas, fallos, listaIdPorBucket };
}
const asegurarListasCategoria = () => asegurarListas(CATEGORIA_ENV);
const asegurarListasColor     = () => asegurarListas(COLOR_ENV);

// Fase A — al PRINCIPIO del sync (antes de leer/subir ventas de este ciclo): asegura las
// listas y siembra cada una SOLO con el favorito REAL ya detectado (favoritosReales, de
// fetchFavoritosActuales) — es la elección de verdad del titular, nunca "más vendido"
// aquí. Los grupos sin favorito real se dejan para la fase B, al final del sync.
// Genérico: crea (si faltan) las listas de `asegurarFn` y siembra cada una SOLO con el
// favorito REAL ya detectado — nunca "más vendido" aquí (eso es fase B, y solo aplica a
// categoría, ver completarFavoritosConMasVendido). `bucketPorCh` es el bucket calculado por
// el SaaS para cada ch (categoría o color); `bucketFallback` es donde cae un favorito real
// cuyo ch no tiene bucket calculable (ver comentario de más abajo) — 'RESTO' para categoría,
// 'gris' para color.
async function sembrarFavoritosEnListas(asegurarFn, bucketPorChMap, favoritosReales, bucketFallback, etiqueta) {
  const aseguradas = await asegurarFn();
  if (aseguradas.omitida) return aseguradas;
  const { creadas, fallos, listaIdPorBucket } = aseguradas;
  const p = await getPool();

  const favoritosPorCh = favoritosReales instanceof Map ? favoritosReales : new Map();

  // Igual que en ListaArticu: se detectan por metadata las columnas de ItemListaArticu que
  // haya además de XItem_IdLista/XItem_IdArticu y sean NOT NULL sin default, en vez de asumir
  // que esas dos son las únicas en cualquier instalación real.
  const itemColsR = favoritosPorCh.size
    ? await p.request().query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ItemListaArticu'`
      ).catch(() => ({ recordset: [] }))
    : { recordset: [] };
  const itemColsInfo = itemColsR.recordset;
  const itemObligatorias = columnasObligatorias(itemColsInfo, new Set(['XItem_IdLista', 'XItem_IdArticu']));
  const itemColumnasBase = ['XItem_IdLista', 'XItem_IdArticu', ...itemObligatorias.map(c => c.nombre)];
  const itemValoresBase  = ['@lista', '@cn', ...itemObligatorias.map(c => c.valor)];

  let favoritosCreados = 0;
  let favoritosSinLista = 0;
  const fallosSiembra = [];
  for (const [ch, cn] of favoritosPorCh) {
    // Si el ch no tiene bucket calculado (grupo homogéneo oficial no reconocido por el SaaS,
    // o "ch" sintético de un favorito real sin CODConjunto — ver fetchFavoritosActuales) no
    // se descarta el favorito: Farmatic ya lo reconoce con su propia agrupación interna al
    // dispensar, así que cae al bucket por defecto en vez de perderse.
    const bucket = bucketPorChMap.get(ch) || bucketFallback;
    const listaId = listaIdPorBucket.get(bucket);
    if (!listaId) { favoritosSinLista++; continue; }
    const resultado = await insertarConReintentoPorColumna(
      p, 'ItemListaArticu', itemColsInfo, itemColumnasBase, itemValoresBase,
      [{ nombre: 'lista', tipo: sql.Int, valor: listaId }, { nombre: 'cn', tipo: sql.Int, valor: cn }],
      { guardSql: 'IF NOT EXISTS (SELECT 1 FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn) ' }
    );
    if (resultado.ok) {
      favoritosCreados++;
    } else {
      log.warn(`No se pudo sembrar favorito real de CH ${ch} (${etiqueta}):`, resultado.error);
      fallosSiembra.push(`CH ${ch}: ${resultado.error}`);
    }
  }
  if (creadas.length) log.info(`✓ Listas de ${etiqueta} creadas en Farmatic: ${creadas.length}`);
  if (favoritosCreados > 0) log.info(`✓ Favoritos reales sembrados (${etiqueta}): ${favoritosCreados}`);
  return {
    creadas, fallos_creacion: fallos, favoritos_creados: favoritosCreados,
    favoritos_totales: favoritosPorCh.size, favoritos_sin_lista: favoritosSinLista,
    fallos_siembra: fallosSiembra,
  };
}
function sembrarFavoritosReales(categoriasActuales, favoritosReales) {
  const categoriaPorCh = new Map((categoriasActuales || []).map(r => [Number(r.ch), r.categoria]));
  return sembrarFavoritosEnListas(asegurarListasCategoria, categoriaPorCh, favoritosReales, 'RESTO', 'categoría');
}

// A diferencia de la categoría (una elección congelada del titular, nunca se recalcula sola
// — ver sembrarFavoritosReales), el color es un dato derivado del descuento (dto) del
// favorito, que puede cambiar de un ciclo a otro sin que nadie elija nada. Aquí no basta con
// "insertar si falta": cada ciclo hay que
// comprobar si el CN ya está en OTRA lista de color (porque cambió desde el ciclo anterior)
// y, si es así, quitarlo de ahí antes de meterlo en la que le corresponde ahora — si no, un
// CN que pasa de verde a gris se quedaría "duplicado" en las dos listas para siempre.
async function reconciliarFavoritosColor(coloresActuales, favoritosReales) {
  const aseguradas = await asegurarListasColor();
  if (aseguradas.omitida) return aseguradas;
  const { creadas, fallos, listaIdPorBucket } = aseguradas;
  const p = await getPool();

  const favoritosPorCh = favoritosReales instanceof Map ? favoritosReales : new Map();
  const colorPorCh = new Map((coloresActuales || []).map(r => [Number(r.ch), r.color]));
  const todasLasListasColor = [...listaIdPorBucket.values()];

  const itemColsR = favoritosPorCh.size
    ? await p.request().query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ItemListaArticu'`
      ).catch(() => ({ recordset: [] }))
    : { recordset: [] };
  const itemColsInfo = itemColsR.recordset;
  const itemObligatorias = columnasObligatorias(itemColsInfo, new Set(['XItem_IdLista', 'XItem_IdArticu']));
  const itemColumnasBase = ['XItem_IdLista', 'XItem_IdArticu', ...itemObligatorias.map(c => c.nombre)];
  const itemValoresBase  = ['@lista', '@cn', ...itemObligatorias.map(c => c.valor)];

  let favoritosCreados = 0;
  let favoritosMovidos = 0;
  let favoritosSinLista = 0;
  const fallosSiembra = [];
  for (const [ch, cn] of favoritosPorCh) {
    const bucket  = colorPorCh.get(ch) || 'gris';
    const listaId = listaIdPorBucket.get(bucket);
    if (!listaId) { favoritosSinLista++; continue; }

    const otras = todasLasListasColor.filter(id => id !== listaId);
    if (otras.length) {
      try {
        const actualR = await p.request()
          .input('cn', sql.Int, cn)
          .query(`SELECT XItem_IdLista FROM ItemListaArticu WHERE XItem_IdArticu = @cn AND XItem_IdLista IN (${otras.join(',')})`);
        for (const row of actualR.recordset) {
          await p.request()
            .input('lista', sql.Int, row.XItem_IdLista)
            .input('cn',    sql.Int, cn)
            .query(`DELETE FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn`);
          favoritosMovidos++;
        }
      } catch (err) {
        log.warn(`No se pudo comprobar/mover CH ${ch} entre listas de color:`, err.message);
      }
    }

    const resultado = await insertarConReintentoPorColumna(
      p, 'ItemListaArticu', itemColsInfo, itemColumnasBase, itemValoresBase,
      [{ nombre: 'lista', tipo: sql.Int, valor: listaId }, { nombre: 'cn', tipo: sql.Int, valor: cn }],
      { guardSql: 'IF NOT EXISTS (SELECT 1 FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn) ' }
    );
    if (resultado.ok) {
      favoritosCreados++;
    } else {
      log.warn(`No se pudo sembrar favorito real de CH ${ch} (color):`, resultado.error);
      fallosSiembra.push(`CH ${ch}: ${resultado.error}`);
    }
  }
  if (creadas.length) log.info(`✓ Listas de color creadas en Farmatic: ${creadas.length}`);
  if (favoritosCreados > 0) log.info(`✓ Favoritos reales sembrados (color): ${favoritosCreados}`);
  if (favoritosMovidos > 0) log.info(`✓ Favoritos movidos de lista de color: ${favoritosMovidos}`);
  return {
    creadas, fallos_creacion: fallos, favoritos_creados: favoritosCreados,
    favoritos_totales: favoritosPorCh.size, favoritos_sin_lista: favoritosSinLista,
    favoritos_movidos: favoritosMovidos, fallos_siembra: fallosSiembra,
  };
}

// Fase B — al FINAL del sync (con las ventas de este ciclo ya subidas): para los grupos
// que sigan sin ningún favorito en su lista de categoría (ni real de fase A, ni puesto a
// mano antes), se rellena con el más vendido — calculado en vivo contra el propio
// Farmatic (no depende de que nuestra copia sincronizada esté al día), con el mismo
// filtro anti-ético de siempre. Nunca pisa un favorito ya existente en la lista.
async function completarFavoritosConMasVendido(categoriasActuales) {
  const lcat = getListaCategoria();
  if (!lcat) return null;
  const p = await getPool();
  const listaIds = Object.keys(lcat).map(Number).filter(Number.isFinite);
  if (!listaIds.length) return null;

  const cdb = CONSEJO_DB();
  // ch = CODConjunto oficial del Consejo (igual que en fetchFavoritosActuales), no
  // GeneArti.IdGrupoGen — aquí SIN COALESCE/sintético: esta fase solo tiene sentido dentro
  // de un grupo homogéneo oficial real (no hay "más vendido del grupo" si no hay grupo).
  const yaCubiertosR = await p.request().query(`
    SELECT DISTINCT bpc.CODConjunto AS ch
    FROM ItemListaArticu i
    JOIN ${cdb}.dbo.BP_CONJARTI bpc
      ON LTRIM(RTRIM(bpc.CODIGO)) = LTRIM(RTRIM(CAST(i.XItem_IdArticu AS VARCHAR)))
      AND bpc.CODCCAA = 0
    WHERE i.XItem_IdLista IN (${listaIds.join(',')})
  `).catch(() => ({ recordset: [] }));
  const yaCubiertos = new Set(yaCubiertosR.recordset.map(r => Number(r.ch)));

  const fac = await detectarFiltroFacturada(p);
  const excl = excludedVendors();
  const exclClause = excl.length ? `AND v.XVend_IdVendedor NOT IN (${excl.join(',')})` : '';
  const hoy = new Date();
  const cutoff = (hoy.getFullYear() - 1) * 100 + (hoy.getMonth() + 1); // últimos ~12 meses

  // Un ético nunca puede quedar de favorito (misma regla que en el SaaS) — GeneArti.EFG es
  // la señal ya usada en todo el sistema para distinguir genérico/ético (EFG=1 → GENÉRICO,
  // EFG=0/NULL → ÉTICO, ver fetchProductos()). Sin este filtro, el producto de marca
  // original del grupo homogéneo (que suele tener más ventas históricas que sus genéricos)
  // podía quedar sembrado como favorito inicial de una farmacia nueva.
  const topR = await p.request().query(`
    SELECT ch, cn FROM (
      SELECT bpc.CODConjunto AS ch, lv.Codigo AS cn, SUM(lv.Cantidad) AS uds,
        ROW_NUMBER() OVER (PARTITION BY bpc.CODConjunto ORDER BY SUM(lv.Cantidad) DESC) AS rn
      FROM LineaVenta lv
      INNER JOIN Venta v ON v.IdVenta = lv.IdVenta
      INNER JOIN GeneArti g ON CAST(g.IdArticu AS VARCHAR) = CAST(lv.Codigo AS VARCHAR)
      INNER JOIN ${cdb}.dbo.BP_CONJARTI bpc
        ON LTRIM(RTRIM(bpc.CODIGO)) = LTRIM(RTRIM(CAST(lv.Codigo AS VARCHAR)))
        AND bpc.CODCCAA = 0
      WHERE (v.Ejercicio * 100 + v.Mes) >= ${cutoff}
        AND ${fac.filtro} ${exclClause}
        AND lv.Cantidad > 0
        AND g.EFG = 1
      GROUP BY bpc.CODConjunto, lv.Codigo
    ) t
    WHERE rn = 1
  `).catch(err => { log.warn('Top CN por grupo (completar favoritos) falló:', err.message); return { recordset: [] }; });

  const categoriaPorCh = new Map((categoriasActuales || []).map(r => [Number(r.ch), r.categoria]));
  const listaIdPorCategoria = new Map(Object.entries(lcat).map(([id, categoria]) => [categoria, parseInt(id, 10)]));

  let completados = 0;
  for (const row of topR.recordset) {
    const ch = Number(row.ch);
    if (yaCubiertos.has(ch)) continue;
    const listaId = listaIdPorCategoria.get(categoriaPorCh.get(ch));
    if (!listaId) continue;
    try {
      await p.request()
        .input('lista', sql.Int, listaId)
        .input('cn',    sql.Int, Number(row.cn))
        .query(`
          IF NOT EXISTS (SELECT 1 FROM ItemListaArticu WHERE XItem_IdLista = @lista AND XItem_IdArticu = @cn)
          INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu) VALUES (@lista, @cn)
        `);
      completados++;
    } catch (err) {
      log.warn(`No se pudo completar favorito de CH ${ch}:`, err.message);
    }
  }
  if (completados > 0) log.info(`✓ Favoritos completados con más vendido: ${completados}`);
  return { favoritos_completados: completados };
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

      // El backend ya rellena categoria_nueva con la categoría actual del GH aunque solo
      // cambie el favorito (no la categoría) — si aun así llega sin ella (agente viejo
      // hablando con backend nuevo, o dato incompleto), no hay lista de destino segura:
      // se marca como error explícito en vez de darlo por bueno sin escribir nada, que
      // es justo el bug que hizo que un cambio de favorito real se reportara "OK" sin
      // tocar Farmatic.
      if (!favorito_cn_nuevo) {
        procesados++;
        ids_procesados.push(cambio.id);
        continue;
      }
      if (!categoria_nueva) {
        log.warn(`Cambio CH ${ch} sin categoría de destino — no se puede escribir en Farmatic con seguridad`);
        errores++;
        continue;
      }

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

// Consulta estrecha primero (nombres esperados — "caso jose"/estándar, rápida y gratis);
// si no encuentra NADA, cae a listar TODAS las tablas reales de la instalación, para que
// resolverAtributoTabla pueda ofrecerle a la IA el universo completo en vez de quedarse
// sin candidatos por culpa de un nombre de tabla inesperado. El caso habitual resuelve en
// el primer intento sin necesidad de la consulta amplia.
async function tablasCandidatas(p, nombresEsperados) {
  const estrecha = await p.request().query(
    `SELECT name FROM sys.tables WHERE name IN (${nombresEsperados.map(t => `'${t}'`).join(',')})`
  ).catch(() => ({ recordset: [] }));
  if (estrecha.recordset.length) return estrecha.recordset;
  const amplia = await p.request().query(`SELECT name FROM sys.tables`).catch(() => ({ recordset: [] }));
  return amplia.recordset;
}

// Devuelve todas las listas de artículos de Farmatic con nombre y cantidad de ítems
async function fetchListasWizard() {
  const p = await getPool();
  // El nombre de la cabecera de lista varía por instalación: unas Farmatic la llaman
  // "Nombre", otras "Descripcion" (caso real: farmacia jose). Se detecta la columna real
  // en vez de asumir un nombre fijo — mismo patrón que Vendedor.Baja/Cliente.Telefono2.
  const tbl = { recordset: await tablasCandidatas(p, ['ListaArticu', 'Lista', 'Listas']) };
  const tablaNombres = await resolverAtributoTabla({
    entidad: 'TABLA', atributo: 'lista_articulos', candidatos: ['ListaArticu', 'Lista', 'Listas'],
    tablasReales: new Set(tbl.recordset.map(r => r.name)),
    descripcion: 'Tabla que almacena las listas de artículos de Farmatic (cabeceras de lista, cada una con un id y un nombre).',
  });

  if (tablaNombres) {
    const colsR = await p.request().query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tablaNombres}'`
    ).catch(() => ({ recordset: [] }));
    const cols = new Set(colsR.recordset.map(r => r.COLUMN_NAME));
    const colNombre = await resolverAtributoColumna({
      entidad: 'LISTA_ARTICU', atributo: 'nombre', candidatos: ['Nombre', 'Descripcion'],
      columnasReales: cols, descripcion: 'Columna de la tabla de listas de artículos con el nombre/descripción visible de cada lista.',
    });

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
  diagnosticarErrorConexion,
  fetchProductos,
  fetchVentasAnuales,
  fetchVentasMensuales,
  ventanaMesesRecientes,
  fetchRecepcionesRecientes,
  fetchFavoritosListas,
  fetchFavoritosActuales,
  fetchTicketMedio,
  fetchVendedoresFarmatic,
  procesarVendedoresPendientes,
  verificarTablas,
  fetch4DBDescuentos,
  procesarCambiosPendientes,
  procesarListaNegraPendiente,
  getCategoriaLista,
  detectarListasPorNombre,
  categoriasSinResolver,
  setMapeoEsquema,
  resolverAtributoColumna,
  resolverAtributoTabla,
  sembrarFavoritosReales,
  reconciliarFavoritosColor,
  completarFavoritosConMasVendido,
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
