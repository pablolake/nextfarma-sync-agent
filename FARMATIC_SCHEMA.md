# Tablas y variables de Farmatic — NextFarma Sync Agent

Referencia completa de qué tablas lee/escribe el agente en la base de datos de Farmatic (SQL Server) y qué variables de entorno controlan su comportamiento.

---

## Tablas de Farmatic (SQL Server)

### `Articu` — Catálogo de artículos
Tabla principal de productos. Se lee en cada sync completo.

| Columna leída | Uso |
|---------------|-----|
| `IdArticu` | Identificador interno (se castea a código nacional) |
| `Descripcion` | Nombre del artículo |
| `Laboratorio` | Código del proveedor/laboratorio (formato `E0111`) |
| `PVP` | Precio de venta al público |
| `PUC` | Precio unitario de coste |
| `IVA` | Tipo de IVA (`S` = medicamento 4%) |
| `Baja` | 0 = activo, 1 = dado de baja |
| `Receta` | Indica si requiere receta |
| `EFG` | 1 = equivalente farmacéutico genérico |
| `EFP` | 1 = especialidad farmacéutica publicitaria |
| `ExcluidoSS` | Excluido de la Seguridad Social |

---

### `GeneArti` — Grupos homogéneos (relación artículo ↔ grupo)
Relaciona cada CN con su grupo homogéneo del Consejo General.

| Columna leída | Uso |
|---------------|-----|
| `IdArticu` | Código del artículo (se cruza con `Articu.IdArticu`) |
| `IdGrupoGen` | ID del grupo homogéneo (`ch` en NextFarma) |

---

### `BP_CONJARTI` — Artículos por conjunto homogéneo (BD del Consejo)
Tabla en la base de datos del Consejo General (`DB_CONSEJO`, por defecto `Consejo`).

| Columna leída | Uso |
|---------------|-----|
| `CODIGO` | Código nacional del artículo |
| `CODConjunto` | ID del grupo homogéneo |
| `CODCCAA` | Código de CCAA — se filtra `= 0` (catálogo nacional) |

---

### `BP_CONJUNTOS` — Catálogo de conjuntos homogéneos (BD del Consejo)
Cabecera de los grupos homogéneos del Consejo.

| Columna leída | Uso |
|---------------|-----|
| `CODCONJUNTO` | ID del grupo |
| `NOMBRE` | Nombre del grupo homogéneo |
| `PVPMENOR` | PVP menor del grupo (referencia de precio) |
| `TIPO` | Tipo de conjunto |
| `CODCCAA` | Filtrado `= 0` (catálogo nacional) |

---

### `Venta` — Cabecera de tickets de venta
Se lee para análisis de ventas mensuales y seguimiento de crónicos.

| Columna leída | Uso |
|---------------|-----|
| `IdVenta` | Identificador del ticket |
| `FechaHora` | Fecha y hora de la venta |
| `XVend_IdVendedor` | ID del vendedor (se excluyen los de `EXCLUDED_VENDORS`) |
| `XClie_IdCliente` | ID del cliente (para crónicos) |
| `TipoVenta` | `'C'` = venta a cliente (se filtran otros tipos) |
| `Facturada` | Columna opcional — si existe, filtra ventas facturadas. Se auto-detecta. |

---

### `LineaVenta` — Líneas de ticket de venta
Detalle de cada artículo vendido dentro de un ticket.

| Columna leída | Uso |
|---------------|-----|
| `XVenta_IdVenta` | FK → `Venta.IdVenta` |
| `Codigo` | Código nacional del artículo vendido |
| `Cantidad` | Unidades vendidas |
| `PVP` | Precio de la línea |
| `Importe` | Importe total de la línea |

---

### `Recep` — Cabecera de recepciones (pedidos recibidos)
Se lee para análisis de márgenes reales y descuentos de compra.

| Columna leída | Uso |
|---------------|-----|
| `IdRecep` | Identificador de la recepción |
| `FechaRecep` | Fecha de recepción |
| `XProv_IdProveedor` | ID del proveedor |

> La columna exacta de fecha se auto-detecta (`FechaRecep`, `Fecha`, `FechaHora`).

---

### `LineaRecep` — Líneas de recepción
Detalle de artículos recibidos.

| Columna leída | Uso |
|---------------|-----|
| `XRecep_IdRecep` | FK → `Recep.IdRecep` |
| `Codigo` | Código nacional del artículo |
| `Cantidad` | Unidades recibidas |
| `PrecioUnitario` / `Precio` | Precio de coste unitario (se auto-detecta el nombre) |
| `Dto` / `Descuento` | Descuento aplicado (se auto-detecta) |
| `Importe` | Importe total de la línea |

---

### `Vendedor` — Vendedores
Se lee solo en el wizard para poblar el paso 1.

| Columna leída | Uso |
|---------------|-----|
| `IdVendedor` | ID del vendedor |
| `Nombre` | Nombre del vendedor |

---

### `Proveedor` — Proveedores / Laboratorios
Se lee en el wizard paso 2 y en los diagnósticos para identificar códigos de laboratorio.

| Columna leída | Uso |
|---------------|-----|
| `IdProveedor` | Código del proveedor (formato `E0111`) |
| `Nombre` | Nombre del proveedor |

---

### `ListaArticu` — Cabecera de listas de artículos
Se lee en el wizard para mostrar las listas disponibles. **Puede no existir** en versiones antiguas de Farmatic — el agente tiene fallback a `ItemListaArticu`.

| Columna leída | Uso |
|---------------|-----|
| `IdLista` | ID de la lista |
| `Nombre` | Nombre de la lista |

---

### `ItemListaArticu` — Artículos en listas
Tabla de relación artículo ↔ lista. Se **lee y escribe** si el wizard paso 3 está configurado.

| Columna leída/escrita | Uso |
|-----------------------|-----|
| `XItem_IdLista` | ID de la lista |
| `XItem_IdArticu` | Código nacional del artículo |

> **ESCRITURA**: `procesarCambiosPendientes` hace `DELETE` + `INSERT` en esta tabla cuando el titular cambia un favorito en la app. Solo actúa sobre los IDs de lista configurados en el wizard — nunca toca otras listas.

---

### `Encargo` — Encargos pendientes
Se leen los últimos 50 encargos activos en cada sync.

| Columna leída | Uso |
|---------------|-----|
| `IdEncargo` | Identificador |
| `Codigo` | CN del artículo encargado |
| `Cantidad` | Unidades |
| `FechaRecepcion` | Fecha de entrada del encargo |
| `XClie_IdCliente` | Cliente asociado (si lo hay) |

---

### `ClienteRGPD` — Consentimiento RGPD de clientes
Se lee para identificar pacientes con consentimiento activo (módulo crónicos).

| Columna leída | Uso |
|---------------|-----|
| `XClie_IdCliente` | ID del cliente en Farmatic |
| `OpcRGPD` | Código de tipo de consentimiento. **Configurable en wizard paso 4** (por defecto `31`) |

---

### `Cliente` — Datos personales de clientes
Se lee **solo localmente** para el módulo de crónicos. Los datos nunca salen del PC de la farmacia.

| Columna leída | Uso |
|---------------|-----|
| `IdCliente` | ID del cliente |
| `Nombre` | Nombre |
| `Apellido1`, `Apellido2` | Apellidos |
| `Telefono`, `Telefono2` | Teléfonos de contacto |

---

### `INFORMATION_SCHEMA.COLUMNS` y `sys.tables`
Se consultan para auto-detectar columnas opcionales que varían según la versión de Farmatic:
- Existencia de columna `Facturada` en `Venta`
- Existencia de tabla `ListaArticu`

---

## Variables de entorno

Todas las variables se configuran desde la app (wizard o pestaña Configuración) y se persisten en `electron-store`. Ninguna requiere edición manual de ficheros.

### Conexión a Farmatic

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `DB_SERVER` | IP o nombre del servidor SQL Server | `localhost` |
| `DB_NAME` | Nombre de la base de datos de Farmatic | `Farmatic` |
| `DB_USER` | Usuario SQL Server | — |
| `DB_PASSWORD` | Contraseña SQL Server | — |
| `DB_PORT` | Puerto TCP | `1433` |
| `DB_INSTANCE` | Nombre de instancia SQL Server (si aplica) | — |
| `DB_ENCRYPT` | Forzar cifrado TLS | `false` |
| `DB_TRUST_CERT` | Confiar en certificado autofirmado | `true` |
| `DB_CONSEJO` | Nombre de la BD del Consejo General | `Consejo` |

### Conexión a NextFarma API

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `API_BASE_URL` | URL base de la API de Railway | — (obligatorio) |
| `API_KEY` | API Key de la farmacia | — (obligatorio) |
| `API_TIMEOUT_MS` | Timeout por petición HTTP (ms) | `30000` |
| `OVERRIDE_API_BASE` | Sobreescribir URL API (desarrollo) | — |

### Wizard paso 1 — Vendedores

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `EXCLUDED_VENDORS` | IDs de vendedores excluidos (coma-separados) | `99` |

### Wizard paso 2 — Laboratorios SC

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `LAB_CINFA` | Código Farmatic de CINFA | `E0111` |
| `LAB_NORMON` | Código Farmatic de NORMON | `E0426` |
| `LAB_KERN` | Código Farmatic de KERN | `E0863` |
| `LAB_TEVA` | Código Farmatic de TEVA | `E1079` |
| `LAB_SECUNDARIOS` | Códigos de labs secundarios (coma-separados) | — (vacío) |
| `SC_UMBRAL` | Compra mínima mensual para activar rappel SC (€) | `2500` |
| `SC_CINFA_NORMON` | % de rappel SC para CINFA y NORMON | `0.05` |
| `SC_KERN_TEVA` | % de rappel SC para KERN y TEVA | `0.10` |

### Wizard paso 3 — Listas de favoritos

Si alguna de estas variables no está configurada, `procesarCambiosPendientes` se desactiva completamente (ninguna escritura en Farmatic).

| Variable | Descripción |
|----------|-------------|
| `LIST_INCENTIVADOS_STAR` | ID de lista Farmatic para categoría INCENTIVADOS STAR |
| `LIST_INCENTIVADOS` | ID de lista para INCENTIVADOS |
| `LIST_MAX_ROT_A` | ID de lista para MÁX. ROTACIÓN A |
| `LIST_MAX_ROT_B` | ID de lista para MÁX. ROTACIÓN B |
| `LIST_RESTO` | ID de lista para RESTO |
| `LIST_PARADOS` | ID de lista para PARADOS |

### Wizard paso 4 — RGPD

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `RGPD_OPCION` | Valor de `OpcRGPD` que indica consentimiento activo | `31` |

### Otras opciones

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `BATCH_SIZE` | Tamaño de lote para envíos a la API | `500` |
| `SYNC_SOLO_VENDIDOS` | `true` = solo enviar productos con ventas | `false` |
| `DESCUENTOS_DIR` | Carpeta con ficheros Excel de descuentos 4DB | `./descuentos` |
| `LOG_LEVEL` | Nivel de log (`info`, `warn`, `error`) | `info` |
| `USERDATA_PATH` | Ruta alternativa para datos locales | — |
| `TENANT_ID` | ID del tenant (se resuelve desde la API Key) | — |

---

## Notas sobre compatibilidad

- **Columna `Facturada`**: opcional en `Venta`. Si existe, filtra ventas no facturadas. Se auto-detecta en cada sync; si no existe, se omite el filtro sin error.
- **Tabla `ListaArticu`**: opcional. Si no existe (versiones antiguas de Farmatic), el wizard usa `ItemListaArticu` directamente para inferir IDs y el nombre de lista aparece como `Lista <ID>`.
- **Columnas de `LineaRecep`**: el nombre exacto de las columnas de precio y descuento varía según la versión de Farmatic. El agente detecta automáticamente las columnas disponibles con una query a `INFORMATION_SCHEMA.COLUMNS` antes del primer sync.
- **BD del Consejo**: la base de datos `Consejo` (configurable con `DB_CONSEJO`) debe estar en el mismo servidor SQL Server que Farmatic. Si no existe o no es accesible, los grupos homogéneos no se resuelven y `es_generico` / `grupo_homogeneo` quedan vacíos.
