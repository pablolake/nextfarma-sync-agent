# sync-agent (v4.0) — PLACEHOLDER + contrato

> ⚠️ **El código real de este agente NO está versionado todavía.** Vive solo en el PC
> de la farmacia: `C:\Users\Administrator\Desktop\sync-agent`. **Acción pendiente:**
> copiar aquí su contenido (sin `cronicos.db` ni `.env`) y commitearlo — es la pieza
> más crítica y hoy no tiene copia de seguridad.

## Qué hace
Agente Node.js en Windows que mantiene Farmatic (SQL Server local) y FARMAxIA (Railway)
en **espejo bidireccional**, y sirve los datos de pacientes (PII) por Cloudflare Tunnel.
Los datos personales (nombre, teléfono) **NUNCA** salen a Railway (RGPD): viven en
`src/cronicos.db` (SQLite local).

## Ciclo de sync (cada 15 min, modo CRON) — `src/sync.js`
1. Ventas mensuales (año actual + anterior) desde `Venta` + `LineaVenta`.
2. Catálogo de productos: `Articu` + BOT PLUS (`BP_CONJUNTOS`, `BP_CONJARTI`).
   2b. Descuentos 4DB (`_4DB_CAT_CatalogoArt`): PVL real, dto_pct, es_generico.
3. Selección de Genéricos: rappel por lab×mes.
4–6. POST catálogo / ventas / ventas anuales a Railway (lotes de 500).
7. Recepciones: precio real de albarán (`LINEARECEP`/`Recep`).
8. Favoritos Farmatic (listas 101-106) → `favorito_cn`; histórico; ticket medio; vendedores; encargos; crónicos; nuevos crónicos RGPD; encargos vencidos.
9. Cierre mensual: snapshot JSONB en `meses_cerrados`.
10. **Cambios pendientes (write-back) — ver contrato abajo.**

## Contrato con la API (cambios desde la reorganización)

### Autenticación
**Todas** las llamadas a `/api/sync/*` deben enviar el header de la API key del tenant:
```
X-API-Key: fxi_xxxxxxxx...
```
La API resuelve el tenant desde la clave. (Antes no se enviaba nada → ahora devuelve 401.)

### Cola anti-colisión (orden APLICAR-PRIMERO)
Para que la ingesta NO pise los cambios hechos por el usuario en la plataforma:

1. **Al inicio del ciclo**, antes de leer de Farmatic:
   - `GET /api/:tenantId/cambios-pendientes` → devuelve la cola abierta y la marca `aplicando`.
   - Escribir cada cambio en Farmatic (favorito → listas 101-106; categoría → su lista).
   - `POST /api/:tenantId/cambios-pendientes/procesar` con el resultado:
     ```json
     { "resultados": [ {"id": 12, "ok": true}, {"id": 13, "ok": false, "error": "...", "conflicto": true} ] }
     ```
     (o `{"ids":[...]}` si todos OK). Un `conflicto:true` genera una alerta para el admin.
2. **Después** leer favoritos/categorías de Farmatic y `POST /api/sync/favoritos`.
   La API **no sobrescribe `favorito_cn`** de un GH que tenga un cambio `pendiente`/`aplicando`
   (candado), y nunca toca `categoria` si `categoria_manual=TRUE`.

### Servidor local de crónicos (PII) — `src/local-server.js` (puerto 3001)
`GET /health`, `GET /cronicos/medicacion`, `GET /cronicos/ausencia`, `GET /cronicos/todos`,
`POST /cronicos/marcar-avisado`, `POST /cronicos/marcar-ausencia`,
`GET /cronicos/actividad/:vendedor_id`, `GET /cronicos/historial/:id_farmatic`.
Se expone al front por Cloudflare Tunnel (HTTPS); su URL va en `CRONICOS_TUNNEL_URL` de la API.

## Onboarding (futuro)
La configuración (API key + credenciales SQL) y el arranque como servicio se harán con
una **app de escritorio Electron** (Fase F, diferida) — sin scripts de consola.
