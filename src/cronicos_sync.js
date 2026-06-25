/**
 * cronicos_sync.js — Sync de crónicos desde Farmatic a SQLite local
 * RGPD: datos personales solo en SQLite local, nunca a Railway
 */

const Database = require('better-sqlite3');
const path     = require('path');

function getDbPath() {
  if (process.env.USERDATA_PATH) return path.join(process.env.USERDATA_PATH, 'cronicos.db');
  return path.join(__dirname, 'cronicos.db');
}

async function syncCronicos(farmaticPool, apiClient, log) {
  const db = new Database(getDbPath());

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cronicos (
        id_farmatic INTEGER PRIMARY KEY,
        nombre TEXT, apellido1 TEXT, apellido2 TEXT,
        telefono TEXT, tel_representante TEXT, rep_legal TEXT,
        ss TEXT, consentimiento INTEGER DEFAULT 0, activo INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS cronicos_medicacion (
        id_farmatic INTEGER,
        cn TEXT,
        descripcion TEXT,
        fecha_ultima_compra TEXT,
        fecha_estimada_salida TEXT,
        aviso_enviado INTEGER DEFAULT 0,
        fecha_aviso TEXT,
        vendedor_aviso INTEGER,
        PRIMARY KEY (id_farmatic, cn)
      );
      CREATE TABLE IF NOT EXISTS cronicos_ausencia (
        id_farmatic INTEGER PRIMARY KEY,
        ultima_visita TEXT,
        dias_ausencia INTEGER,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS cronicos_actividad (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_farmatic INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        vendedor_id INTEGER NOT NULL,
        fecha TEXT NOT NULL DEFAULT (datetime('now')),
        canal TEXT DEFAULT 'whatsapp',
        resultado TEXT,
        notas TEXT
      );
      CREATE TABLE IF NOT EXISTS todos_clientes (
        id_farmatic INTEGER PRIMARY KEY,
        ultima_visita TEXT,
        dias_ausencia INTEGER,
        total_tickets INTEGER DEFAULT 0,
        importe_total REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    log.info('Sincronizando todos los clientes de Farmatic...');
    const todosClientes = await farmaticPool.request().query(`
      SELECT
        v.XClie_IdCliente AS id_farmatic,
        MAX(v.FechaHora)  AS ultima_visita,
        DATEDIFF(day, MAX(v.FechaHora), GETDATE()) AS dias_ausencia,
        COUNT(DISTINCT v.IdVenta) AS total_tickets,
        SUM(v.TotalVenta)         AS importe_total
      FROM Venta v
      WHERE v.TipoVenta = 'C'
        AND v.XClie_IdCliente > 0
        AND v.FechaHora >= DATEADD(year, -2, GETDATE())
      GROUP BY v.XClie_IdCliente
      ORDER BY MAX(v.FechaHora) DESC
    `).catch(err => { log.warn('todos_clientes query error:', err.message); return { recordset: [] }; });

    if (todosClientes.recordset.length > 0) {
      const upsert  = db.prepare(`
        INSERT OR REPLACE INTO todos_clientes
          (id_farmatic, ultima_visita, dias_ausencia, total_tickets, importe_total)
        VALUES (?, ?, ?, ?, ?)
      `);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const fecha = r.ultima_visita instanceof Date
            ? r.ultima_visita.toISOString().slice(0, 10)
            : String(r.ultima_visita || '').slice(0, 10);
          upsert.run(r.id_farmatic, fecha, r.dias_ausencia || 0, r.total_tickets || 0, r.importe_total || 0);
        }
      });
      tx(todosClientes.recordset);
      log.info(`✓ Clientes: ${todosClientes.recordset.length} sincronizados`);
    }

    const cronicos = db.prepare('SELECT id_farmatic FROM cronicos WHERE consentimiento=1 AND activo=1').all();
    if (!cronicos.length) {
      log.info('Sin crónicos con consentimiento registrados');
      return;
    }

    const ids   = cronicos.map(c => c.id_farmatic);
    const BATCH = 500;
    let allMed  = [];

    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH).map(Number).filter(n => !isNaN(n));
      if (!batch.length) continue;
      const result = await farmaticPool.request().query(`
        SELECT
          v.XClie_IdCliente AS id_farmatic,
          lv.Codigo         AS cn,
          a.Descripcion     AS descripcion,
          MAX(v.FechaHora)  AS fecha_ultima_compra
        FROM LineaVenta lv
        INNER JOIN Venta v ON v.IdVenta = lv.IdVenta
        LEFT JOIN Articu a ON a.IdArticu = lv.Codigo
        WHERE v.TipoVenta = 'C'
          AND v.XClie_IdCliente IN (${batch.join(',')})
          AND v.FechaHora >= DATEADD(day, -90, GETDATE())
          AND a.Receta = 1
        GROUP BY v.XClie_IdCliente, lv.Codigo, a.Descripcion
      `).catch(err => { log.warn('medicacion query error:', err.message); return { recordset: [] }; });
      allMed = allMed.concat(result.recordset);
    }

    if (allMed.length > 0) {
      const upsertMed = db.prepare(`
        INSERT OR REPLACE INTO cronicos_medicacion
          (id_farmatic, cn, descripcion, fecha_ultima_compra, fecha_estimada_salida, aviso_enviado)
        VALUES (?, ?, ?, ?, date(?, '+28 days'),
          COALESCE((SELECT CASE WHEN fecha_ultima_compra < ? THEN aviso_enviado ELSE 0 END
                    FROM cronicos_medicacion WHERE id_farmatic=? AND cn=?), 0))
      `);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const f = r.fecha_ultima_compra instanceof Date
            ? r.fecha_ultima_compra.toISOString().slice(0, 10)
            : String(r.fecha_ultima_compra).slice(0, 10);
          upsertMed.run(r.id_farmatic, r.cn, r.descripcion, f, f, f, r.id_farmatic, r.cn);
        }
      });
      tx(allMed);
      log.info(`✓ Medicación: ${allMed.length} registros sincronizados`);
    }

    let allAus = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH).map(Number).filter(n => !isNaN(n));
      if (!batch.length) continue;
      const result = await farmaticPool.request().query(`
        SELECT
          v.XClie_IdCliente AS id_farmatic,
          MAX(v.FechaHora)  AS ultima_visita,
          DATEDIFF(day, MAX(v.FechaHora), GETDATE()) AS dias_ausencia
        FROM Venta v
        WHERE v.XClie_IdCliente IN (${batch.join(',')})
          AND v.TipoVenta = 'C'
        GROUP BY v.XClie_IdCliente
        HAVING DATEDIFF(day, MAX(v.FechaHora), GETDATE()) > 35
      `).catch(() => ({ recordset: [] }));
      allAus = allAus.concat(result.recordset);
    }

    if (allAus.length > 0) {
      const upsertAus = db.prepare(`
        INSERT OR REPLACE INTO cronicos_ausencia (id_farmatic, ultima_visita, dias_ausencia)
        VALUES (?, ?, ?)
      `);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const f = r.ultima_visita instanceof Date
            ? r.ultima_visita.toISOString().slice(0, 10)
            : String(r.ultima_visita).slice(0, 10);
          upsertAus.run(r.id_farmatic, f, r.dias_ausencia);
        }
      });
      tx(allAus);
      log.info(`✓ Ausencias: ${allAus.length} crónicos sin venir más de 35 días`);
    }

    const pendientes = db.prepare(`
      SELECT COUNT(DISTINCT m.id_farmatic) as n
      FROM cronicos_medicacion m
      JOIN cronicos c ON c.id_farmatic = m.id_farmatic
      WHERE c.consentimiento=1 AND m.aviso_enviado=0
        AND julianday(m.fecha_estimada_salida) - julianday('now') <= 7
        AND julianday(m.fecha_estimada_salida) - julianday('now') >= -3
    `).get();

    const urgentes = db.prepare(`
      SELECT COUNT(DISTINCT m.id_farmatic) as n
      FROM cronicos_medicacion m
      JOIN cronicos c ON c.id_farmatic = m.id_farmatic
      WHERE c.consentimiento=1 AND m.aviso_enviado=0
        AND julianday(m.fecha_estimada_salida) - julianday('now') <= 2
        AND julianday(m.fecha_estimada_salida) - julianday('now') >= -3
    `).get();

    await apiClient.request('/api/sync/cronicos-meta', {
      method: 'POST',
      body: {
        total_cronicos:  ids.length,
        pendientes_aviso: pendientes?.n || 0,
        urgentes:         urgentes?.n || 0,
        esta_semana:      pendientes?.n || 0,
        updated_at:       new Date().toISOString(),
      }
    }).catch(err => log.warn('cronicos-meta sync error:', err.message));

    log.info(`✓ Crónicos sync completado — ${pendientes?.n || 0} pendientes de aviso`);

  } finally {
    db.close();
  }
}

module.exports = { syncCronicos };
