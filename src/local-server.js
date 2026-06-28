/**
 * local-server.js — Servidor Express local para datos de crónicos (RGPD).
 * Los datos personales nunca salen de este servidor.
 * Puerto por defecto: 3001 (configurable via LOCAL_PORT)
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

function getDbPath() {
  if (process.env.USERDATA_PATH) return path.join(process.env.USERDATA_PATH, 'cronicos.db');
  return path.join(__dirname, 'cronicos.db');
}

function startLocalServer(log) {
  const PORT = parseInt(process.env.LOCAL_PORT, 10) || 3001;
  const app  = express();
  app.use(express.json());

  // Orígenes permitidos: localhost + URL del túnel Cloudflare (configurable via TUNNEL_ORIGIN)
  const allowedOrigins = new Set([
    'http://localhost',
    'http://127.0.0.1',
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    ...(process.env.TUNNEL_ORIGIN ? [process.env.TUNNEL_ORIGIN] : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const allowed = !origin || allowedOrigins.has(origin) ||
      origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    res.header('Access-Control-Allow-Origin', allowed ? origin : 'null');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 200 : 403);
    next();
  });

  function getDb() { return new Database(getDbPath()); }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, server: 'nextfarma-local', port: PORT });
  });

  app.get('/cronicos/medicacion', (_req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT
          c.id_farmatic,
          c.nombre,
          c.apellido1,
          c.apellido2,
          c.nombre || ' ' || COALESCE(c.apellido1,'') AS nombre_completo,
          COALESCE(NULLIF(c.tel_representante,''), c.telefono) AS telefono,
          c.rep_legal,
          MIN(m.fecha_estimada_salida) AS fecha_proxima_salida,
          CAST(MIN(julianday(m.fecha_estimada_salida)) - julianday('now') AS INTEGER) AS dias_restantes,
          COUNT(m.cn)       AS n_medicamentos,
          SUM(m.aviso_enviado) AS ya_avisados
        FROM cronicos c
        JOIN cronicos_medicacion m ON m.id_farmatic = c.id_farmatic
        WHERE c.consentimiento = 1 AND c.activo = 1
          AND m.aviso_enviado = 0
          AND julianday(m.fecha_estimada_salida) - julianday('now') <= 7
          AND julianday(m.fecha_estimada_salida) - julianday('now') >= -3
        GROUP BY c.id_farmatic
        ORDER BY fecha_proxima_salida ASC
      `).all();
      db.close();
      res.json({ ok: true, pacientes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/cronicos/ausencia', (_req, res) => {
    try {
      const db = getDb();
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT
            c.id_farmatic,
            c.nombre,
            c.apellido1,
            c.apellido2,
            COALESCE(NULLIF(c.tel_representante,''), c.telefono) AS telefono,
            c.rep_legal,
            a.ultima_visita,
            a.dias_ausencia,
            CASE
              WHEN a.dias_ausencia > 84 THEN 'rojo'
              WHEN a.dias_ausencia > 56 THEN 'naranja'
              ELSE 'amarillo'
            END AS grupo
          FROM cronicos_ausencia a
          JOIN cronicos c ON c.id_farmatic = a.id_farmatic
          WHERE c.consentimiento = 1 AND c.activo = 1
          ORDER BY a.dias_ausencia DESC
        `).all();
      } catch {}
      db.close();
      res.json({ ok: true, pacientes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/cronicos/todos', (_req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT
          t.id_farmatic,
          c.nombre,
          c.apellido1,
          c.apellido2,
          COALESCE(NULLIF(c.tel_representante,''), c.telefono) AS telefono,
          c.consentimiento,
          t.ultima_visita,
          t.dias_ausencia,
          t.total_tickets,
          t.importe_total,
          CASE
            WHEN t.dias_ausencia > 84 THEN 'rojo'
            WHEN t.dias_ausencia > 56 THEN 'naranja'
            WHEN t.dias_ausencia > 28 THEN 'amarillo'
            ELSE 'verde'
          END AS grupo_recencia
        FROM todos_clientes t
        LEFT JOIN cronicos c ON c.id_farmatic = t.id_farmatic
        ORDER BY t.dias_ausencia ASC
        LIMIT 2000
      `).all();
      db.close();
      res.json({ ok: true, clientes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/cronicos/marcar-avisado', (req, res) => {
    const { id_farmatic, vendedor_id, resultado, canal, notas } = req.body;
    try {
      const db = getDb();
      db.prepare(`
        UPDATE cronicos_medicacion
        SET aviso_enviado=1, fecha_aviso=datetime('now'), vendedor_aviso=?
        WHERE id_farmatic=?
      `).run(vendedor_id || 0, id_farmatic);
      db.prepare(`
        INSERT INTO cronicos_actividad (id_farmatic, tipo, vendedor_id, canal, resultado, notas)
        VALUES (?, 'aviso_medicacion', ?, ?, ?, ?)
      `).run(id_farmatic, vendedor_id || 0, canal || 'whatsapp', resultado || 'contactado', notas || null);
      db.close();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/cronicos/marcar-ausencia', (req, res) => {
    const { id_farmatic, vendedor_id, resultado, canal, notas } = req.body;
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO cronicos_actividad (id_farmatic, tipo, vendedor_id, canal, resultado, notas)
        VALUES (?, 'aviso_asistencia', ?, ?, ?, ?)
      `).run(id_farmatic, vendedor_id || 0, canal || 'whatsapp', resultado || 'contactado', notas || null);
      db.close();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/cronicos/actividad/:vendedor_id', (req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT tipo,
          COUNT(*) as total,
          SUM(CASE WHEN resultado='contactado' THEN 1 ELSE 0 END) as contactados,
          SUM(CASE WHEN resultado='no_contesta' THEN 1 ELSE 0 END) as no_contesta
        FROM cronicos_actividad
        WHERE vendedor_id = ?
          AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now')
        GROUP BY tipo
      `).all(req.params.vendedor_id);
      db.close();
      res.json({ ok: true, actividad: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Devuelve el id del vendedor, el frontend resuelve el nombre desde los vendedores sincronizados
  app.get('/cronicos/historial/:id_farmatic', (req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT *
        FROM cronicos_actividad
        WHERE id_farmatic = ?
        ORDER BY fecha DESC
        LIMIT 50
      `).all(req.params.id_farmatic);
      db.close();
      res.json({ ok: true, historial: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const server = app.listen(PORT, '127.0.0.1', () => {
    if (log) log.info(`✓ Servidor local crónicos en localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (log) log.warn(`Servidor local no pudo arrancar en puerto ${PORT}: ${err.message}`);
  });

  return app;
}

module.exports = { startLocalServer };
