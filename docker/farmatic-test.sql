-- ============================================================
-- NextFarma Sync — Base de datos de prueba Farmatic
-- ============================================================

-- Crear bases de datos
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'Farmatic')
  CREATE DATABASE Farmatic;
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'Consejo')
  CREATE DATABASE Consejo;
GO

-- ============================================================
-- FARMATIC
-- ============================================================
USE Farmatic;
GO

CREATE TABLE Articu (
  IdArticu     VARCHAR(20)   NOT NULL PRIMARY KEY,
  Descripcion  VARCHAR(200),
  Laboratorio  VARCHAR(50),
  Pvp          DECIMAL(10,4),
  Pvl          DECIMAL(10,4),
  Puc          DECIMAL(10,4),
  IVA          VARCHAR(10),
  Efp          BIT           DEFAULT 0,
  Receta       BIT           DEFAULT 0,
  ExcluidoSS   BIT           DEFAULT 0,
  Baja         BIT           DEFAULT 0,
  -- Módulo Receta, Fase 4 — stock real de Farmatic (ver documento §5.1/5.2).
  StockActual  INT           DEFAULT 0,
  StockMinimo  INT           DEFAULT 0,
  StockMaximo  INT           DEFAULT 0
);
GO

CREATE TABLE GeneArti (
  IdArticu   VARCHAR(20),
  IdGrupoGen INT,
  EFG        BIT DEFAULT 0
);
GO

CREATE TABLE Venta (
  IdVenta          INT           IDENTITY(1,1) PRIMARY KEY,
  Ejercicio        SMALLINT,
  Mes              TINYINT,
  FechaHora        DATETIME,
  XVend_IdVendedor INT,
  XClie_IdCliente  INT           DEFAULT 0,
  TipoVenta        CHAR(1),
  TotalVenta       DECIMAL(10,2) DEFAULT 0,
  Facturada        BIT           DEFAULT 1
);
GO

CREATE TABLE LineaVenta (
  IdNLinea    INT           IDENTITY(1,1) PRIMARY KEY,
  IdVenta     INT,
  Codigo      VARCHAR(20),
  Cantidad    DECIMAL(10,3),
  ImporteNeto DECIMAL(10,4),
  PVP         DECIMAL(10,4)
);
GO

CREATE TABLE Recep (
  IdRecep           INT  IDENTITY(1,1) PRIMARY KEY,
  FechaRecep        DATE,
  XProv_IdProveedor VARCHAR(20)
);
GO

CREATE TABLE LineaRecep (
  -- Ambos nombres de columna presentes (distintas versiones de Farmatic usan uno u otro)
  IdRecep        INT,
  XRecep_IdRecep INT,
  Codigo         VARCHAR(20),
  Cantidad       DECIMAL(10,3),
  PrecioNeto     DECIMAL(10,4),
  Bonificacion   DECIMAL(5,2)
);
GO

CREATE TABLE Vendedor (
  IdVendedor INT PRIMARY KEY,
  Nombre     VARCHAR(100),
  Baja       BIT DEFAULT 0
);
GO

CREATE TABLE Proveedor (
  IdProveedor VARCHAR(20) PRIMARY KEY,
  Nombre      VARCHAR(100)
);
GO

-- TipoLista: tabla de referencia diminuta solo para forzar una FOREIGN KEY real en
-- ListaArticu.IdTipoLista — prueba que asegurarListas() busca un valor válido en la tabla
-- referenciada (o lo copia de una fila de referencia) en vez de adivinar un 0 que violaría
-- la FK.
CREATE TABLE TipoLista (
  Id     INT PRIMARY KEY,
  Nombre VARCHAR(30)
);
GO
INSERT INTO TipoLista (Id, Nombre) VALUES (1, N'Estandar');
GO

-- Columnas extra NOT NULL sin default (Fecha/NumElem/Tipo/EnviarGrupo) replican el esquema
-- real visto en Jose-2 — sirven para probar que asegurarListas() las detecta y rellena solas
-- (columnasObligatorias) en vez de asumir que Nombre es la única columna obligatoria.
-- IdLista NO autonumérico a propósito — así es como es realmente en Jose-2 (INT PRIMARY KEY
-- normal, gestionado por la propia app de Farmatic, no por identity de SQL Server). Prueba el
-- fallback de asegurarListas() (MAX(IdLista)+1) en vez del camino feliz de OUTPUT INSERTED.
-- Nombre acortado a propósito (22, no 100) — fuerza el truncamiento en varias categorías
-- largas ("NextFarma - INCENTIVADOS_STAR" no cabe entera).
CREATE TABLE ListaArticu (
  IdLista     INT PRIMARY KEY,
  Nombre      VARCHAR(22)  NOT NULL,
  Fecha       DATETIME     NOT NULL,
  NumElem     INT          NOT NULL,
  Tipo        BIT          NOT NULL,
  EnviarGrupo BIT          NOT NULL,
  IdTipoLista INT          NOT NULL REFERENCES TipoLista(Id)
);
GO

CREATE TABLE ItemListaArticu (
  XItem_IdLista  INT,
  XItem_IdArticu INT
);
GO

CREATE TABLE ClienteRGPD (
  IdCliente       INT IDENTITY(1,1) PRIMARY KEY,
  OpcRGPD         INT,
  XClie_IdCliente INT DEFAULT 0
);
GO

CREATE TABLE Cliente (
  IdCliente  INT           PRIMARY KEY,
  Nombre     VARCHAR(100),
  Apellido1  VARCHAR(100),
  Apellido2  VARCHAR(100),
  Telefono   VARCHAR(20),
  Telefono2  VARCHAR(20),
  TotalVenta DECIMAL(10,2) DEFAULT 0
);
GO

CREATE TABLE Encargo (
  IdEncargo      INT           IDENTITY(1,1) PRIMARY KEY,
  Codigo         VARCHAR(20),
  Cantidad       DECIMAL(10,3),
  FechaRecepcion DATE,
  NumTicket      INT           DEFAULT 0,
  Situacion      INT           DEFAULT 0,
  Estado         INT           DEFAULT 0,
  XArt_IdArticu  VARCHAR(20),
  XCli_IdCliente INT           DEFAULT 0,
  Vendedor       INT           DEFAULT 0,
  Unidades       DECIMAL(10,3) DEFAULT 0,
  IdContador     INT           DEFAULT 0
);
GO

-- ============================================================
-- DATOS DE PRUEBA — Farmatic
-- ============================================================

INSERT INTO Vendedor (IdVendedor, Nombre, Baja) VALUES
  (1,  N'Ana García',    0),
  (2,  N'Luis Martínez', 0),
  (3,  N'María López',   0),
  (99, N'AUTOCONSUMO',   0);
GO

INSERT INTO Proveedor (IdProveedor, Nombre) VALUES
  ('E0111', N'CINFA LABORATORIOS'),
  ('E0426', N'LABORATORIOS NORMON'),
  ('E0863', N'KERN PHARMA'),
  ('E1079', N'TEVA PHARMA'),
  ('NEUTRO', N'NEUTROGENA');
GO

-- Artículos con CNs de 7 dígitos (formato estándar español)
-- Stock (Módulo Receta, Fase 4) — dos patrones reales del documento de diseño: crónico de
-- alta rotación (stock holgado tipo 20/13/20) y puntual controlado (stock ajustado 14/1/1).
-- 1000003 (AMOXICILINA) se deja con StockActual < StockMinimo a propósito — prueba la señal
-- "stock bajo" (rojo) tanto en la tabla de CNs del GH como en GET /api/:tenantId/stock.
-- OJO: 1000001/1000002/1000004/1000008 tienen Pvp por encima de su PVPMENOR de BP_CONJUNTOS
-- (más de 1%) — fetchProductos() los descarta como "pvpSuperior" (dato inconsistente, ver
-- farmatic-client.js), así que NUNCA llegan a Railway. Preexistente a Receta, no se toca
-- aquí (afecta a datos de prueba de otras features) — por eso el caso de stock bajo se
-- monta sobre 1000003, que sí sobrevive ese filtro (Pvp = PVPMENOR exacto).
INSERT INTO Articu (IdArticu, Descripcion, Laboratorio, Pvp, Pvl, Puc, IVA, Efp, Receta, ExcluidoSS, Baja, StockActual, StockMinimo, StockMaximo) VALUES
  ('1000001', N'IBUPROFENO 600MG 40 COMP EFG',     'E0111',  5.58, 3.01, 2.87, '4', 0, 1, 0, 0, 20, 13, 20),
  ('1000002', N'PARACETAMOL 1G 10 COMP EFG',        'E0426',  2.82, 1.52, 1.45, '4', 0, 0, 0, 0, 19, 13, 20),
  ('1000003', N'AMOXICILINA 500MG 24 CAPS EFG',     'E0863',  3.49, 1.88, 1.78, '4', 0, 1, 0, 0,  8, 13, 20),
  ('1000004', N'OMEPRAZOL 20MG 28 CAPS EFG',        'E0111',  1.62, 0.87, 0.82, '4', 0, 1, 0, 0, 14, 13, 20),
  ('1000005', N'IBUPROFENO 400MG 40 COMP EFG',      'E1079',  4.70, 2.53, 2.40, '4', 0, 0, 0, 0, 14,  1,  1),
  ('1000006', N'LORAZEPAM 1MG 50 COMP',             'E0426',  2.28, 1.23, 1.15, '4', 0, 1, 0, 0, 17,  2,  2),
  ('1000007', N'METFORMINA 850MG 50 COMP EFG',      'E0863',  2.12, 1.14, 1.05, '4', 0, 1, 0, 0, 14,  2,  2),
  ('1000008', N'ATORVASTATINA 20MG 28 COMP EFG',    'E0111',  1.94, 1.04, 0.98, '4', 0, 1, 0, 0, 14,  2,  2),
  ('2000001', N'CREMA HIDRATANTE 200ML',             'NEUTRO', 8.95, NULL, NULL, '21',1, 0, 1, 0,  0,  0,  0),
  ('2000002', N'GEL ANTISÉPTICO 500ML',              'NEUTRO', 4.50, NULL, NULL, '21',1, 0, 1, 0,  0,  0,  0),
  -- ────────────────────────────────────────────────────────────────────────────────────
  -- AMPLIACIÓN 2026-08-01: rango de IDs 900/9000000+ elegido a propósito para no chocar
  -- con NADA que ya existiera en el tenant "PruebaDocker" de Railway — se descubrió que
  -- una siembra de datos anterior (ajena a esta sesión) ya usaba ch 107-116 / CN
  -- 1100001-1100020 con un bug de mapeo (nombre de GH y CN no coincidían entre sí). Ese
  -- dato viejo sigue en Railway (no hay endpoint para borrarlo desde aquí) pero al no
  -- reutilizar esos códigos, los GH nuevos de abajo ya no se mezclan con él.
  -- 10 GH nuevos, 2-3 laboratorios cada uno, distintas categorías terapéuticas y patrones
  -- de rotación/stock — para evaluar Receta con variedad real, no solo 1-2 casos sueltos.
  -- PVPMENOR de cada CODConjunto (ver BP_CONJUNTOS) = Pvp más alto del grupo, para no
  -- repetir el filtro "pvpSuperior" que ya descartó ítems del bloque original.
  ('9000001', N'SIMVASTATINA CINFA 20MG 28 COMP EFG',   'E0111', 3.20, 1.73, 1.64, '4', 0, 1, 0, 0, 24, 13, 20),
  ('9000002', N'SIMVASTATINA NORMON 20MG 28 COMP EFG',  'E0426', 3.15, 1.70, 1.62, '4', 0, 1, 0, 0, 18, 13, 20),
  ('9000003', N'SIMVASTATINA KERN 20MG 28 COMP EFG',    'E0863', 3.25, 1.76, 1.67, '4', 0, 1, 0, 0, 12, 13, 20),
  ('9000004', N'LOSARTAN CINFA 50MG 28 COMP EFG',       'E0111', 4.10, 2.21, 2.10, '4', 0, 1, 0, 0, 16, 13, 20),
  ('9000005', N'LOSARTAN TEVA 50MG 28 COMP EFG',        'E1079', 4.05, 2.19, 2.08, '4', 0, 1, 0, 0, 10, 13, 20),
  -- Enalapril NORMON: stock por debajo del mínimo a propósito (señal "stock bajo" nº2).
  ('9000006', N'ENALAPRIL NORMON 20MG 30 COMP EFG',     'E0426', 2.95, 1.59, 1.51, '4', 0, 1, 0, 0,  4, 15, 25),
  ('9000007', N'ENALAPRIL KERN 20MG 30 COMP EFG',       'E0863', 3.00, 1.62, 1.54, '4', 0, 1, 0, 0, 20, 15, 25),
  -- Amlodipino CINFA: sobrestock a propósito (señal ⚡ distinta de "stock bajo").
  ('9000008', N'AMLODIPINO CINFA 10MG 30 COMP EFG',     'E0111', 1.85, 1.00, 0.95, '4', 0, 1, 0, 0, 30, 15, 25),
  ('9000009', N'AMLODIPINO NORMON 10MG 30 COMP EFG',    'E0426', 1.80, 0.97, 0.92, '4', 0, 1, 0, 0, 22, 15, 25),
  ('9000010', N'AMLODIPINO TEVA 10MG 30 COMP EFG',      'E1079', 1.90, 1.03, 0.98, '4', 0, 1, 0, 0, 14, 15, 25),
  ('9000011', N'FUROSEMIDA CINFA 40MG 30 COMP EFG',     'E0111', 2.10, 1.13, 1.07, '4', 0, 1, 0, 0, 15, 10, 18),
  ('9000012', N'FUROSEMIDA NORMON 40MG 30 COMP EFG',    'E0426', 2.05, 1.11, 1.05, '4', 0, 1, 0, 0,  8, 10, 18),
  ('9000013', N'PANTOPRAZOL KERN 40MG 28 COMP EFG',     'E0863', 3.40, 1.84, 1.75, '4', 0, 1, 0, 0, 25, 15, 22),
  ('9000014', N'PANTOPRAZOL TEVA 40MG 28 COMP EFG',     'E1079', 3.35, 1.81, 1.72, '4', 0, 1, 0, 0, 12, 15, 22),
  -- Único laboratorio en su GH (caso real: sin competencia todavía, pero SÍ con ch oficial
  -- — distinto del huérfano sin ch de más abajo).
  ('9000015', N'TRAMADOL KERN 50MG 20 CAPS EFG',        'E0863', 2.60, 1.40, 1.33, '4', 0, 1, 0, 0, 10,  8, 15),
  ('9000016', N'DIAZEPAM CINFA 5MG 30 COMP EFG',        'E0111', 1.70, 0.92, 0.87, '4', 0, 1, 0, 0, 12,  6, 12),
  ('9000017', N'DIAZEPAM NORMON 5MG 30 COMP EFG',       'E0426', 1.65, 0.89, 0.85, '4', 0, 1, 0, 0,  5,  6, 12),
  ('9000018', N'CANDESARTAN KERN 16MG 28 COMP EFG',     'E0863', 3.80, 2.05, 1.95, '4', 0, 1, 0, 0, 18, 12, 20),
  ('9000019', N'CANDESARTAN TEVA 16MG 28 COMP EFG',     'E1079', 3.75, 2.03, 1.93, '4', 0, 1, 0, 0,  9, 12, 20),
  -- BISOPROLOL: sin ninguna venta reciente a propósito — caso PARADOS real (el set
  -- original no tenía ninguno; todo lo demás tiene venta en los últimos 3 meses).
  ('9000020', N'BISOPROLOL CINFA 5MG 30 COMP EFG',      'E0111', 1.55, 0.84, 0.80, '4', 0, 1, 0, 0,  6,  6, 10),
  ('9000021', N'BISOPROLOL NORMON 5MG 30 COMP EFG',     'E0426', 1.50, 0.81, 0.77, '4', 0, 1, 0, 0,  3,  6, 10),
  -- Módulo Receta, Fase 3 (4.3) — 3 hospitalarios GENUINAMENTE huérfanos: no aparecen en
  -- BP_CONJARTI/BP_CONJUNTOS ni en GeneArti. Con DISPENSACION='R' en ESPEPARA + venta real
  -- reciente, entran al universo de Receta como GH único (ch sintético negativo).
  -- 9500001: patrón "stock bajo". 9500002: patrón "sobrestock". 9500003: "stock correcto"
  -- — los 3 juntos cubren las 3 señales de único sin depender de un solo ejemplo.
  ('9500001', N'ADALIMUMAB 40MG JERINGA PRECARGADA 2 UDS',        'E0863', 285.40, 245.60, 233.30, '4', 0, 1, 0, 0,  3,  1,  2),
  ('9500002', N'RIVASTIGMINA 4,6MG/24H 30 PARCHES TRANSDERMICOS', 'E0863',  95.20,  82.10,  78.00, '4', 0, 1, 0, 0, 22,  6, 12),
  ('9500003', N'ETANERCEPT 50MG JERINGA PRECARGADA 4 UDS',        'E0426', 320.00, 275.60, 261.80, '4', 0, 1, 0, 0,  8,  5, 12),
  -- AMPLIACIÓN 2026-08-01 (2ª tanda) — 15 GH nuevos más (ch 911-925, CN 9100001+) + 4
  -- huérfanos hospitalarios más (CN 9600001+), para tener variedad terapéutica real
  -- (cardio/psiquiatría/antibióticos/endocrino) y patrones de rotación distintos: 'star'
  -- (alto volumen creciente), 'medio', 'parados' (0 ventas en la ventana — antibióticos de
  -- pauta corta, caso real) y 'consolidado' (un laboratorio con ~90%+ de sustitución
  -- sostenida). Generado con un script (ver conversación) para evitar errores aritméticos
  -- en PVL/PUC/PVPMENOR a mano — mismo rango seguro que la 1ª tanda (900/9000000+), aquí
  -- ch 911-925 / CN 9100001-9100032 y 9600001-9600004 para no chocar con nada anterior.
  ('9100001', N'CLOPIDOGREL CINFA 75MG EFG', 'E0111', 18.50, 9.9900, 9.2500, '4', 0, 1, 0, 0, 40, 20, 35),
  ('9100002', N'CLOPIDOGREL NORMON 75MG EFG', 'E0426', 18.20, 9.8280, 9.4640, '4', 0, 1, 0, 0, 30, 20, 35),
  ('9100003', N'CLOPIDOGREL KERN 75MG EFG', 'E0863', 18.80, 10.1520, 9.0240, '4', 0, 1, 0, 0, 25, 20, 35),
  ('9100004', N'LEVOTIROXINA CINFA 100MCG EFG', 'E0111', 3.10, 1.6740, 1.5500, '4', 0, 1, 0, 0, 60, 30, 50),
  ('9100005', N'LEVOTIROXINA TEVA 100MCG EFG', 'E1079', 3.05, 1.6470, 1.6165, '4', 0, 1, 0, 0, 45, 30, 50),
  ('9100006', N'SERTRALINA NORMON 50MG EFG', 'E0426', 6.40, 3.4560, 3.2640, '4', 0, 1, 0, 0, 20, 12, 20),
  ('9100007', N'SERTRALINA KERN 50MG EFG', 'E0863', 6.55, 3.5370, 3.1440, '4', 0, 1, 0, 0, 15, 12, 20),
  ('9100008', N'SERTRALINA TEVA 50MG EFG', 'E1079', 6.30, 3.4020, 3.3390, '4', 0, 1, 0, 0, 10, 12, 20),
  ('9100009', N'ALPRAZOLAM CINFA 0.5MG EFG', 'E0111', 2.20, 1.1880, 1.1000, '4', 0, 1, 0, 0, 18, 10, 18),
  ('9100010', N'ALPRAZOLAM NORMON 0.5MG EFG', 'E0426', 2.15, 1.1610, 1.1395, '4', 0, 1, 0, 0, 12, 10, 18),
  ('9100011', N'ACENOCUMAROL KERN 4MG EFG', 'E0863', 3.60, 1.9440, 1.8000, '4', 0, 1, 0, 0, 22, 15, 25),
  ('9100012', N'HIDROCLOROTIAZIDA CINFA 25MG EFG', 'E0111', 1.95, 1.0530, 0.9750, '4', 0, 1, 0, 0, 14, 10, 18),
  ('9100013', N'HIDROCLOROTIAZIDA NORMON 25MG EFG', 'E0426', 1.90, 1.0260, 1.0070, '4', 0, 1, 0, 0, 9, 10, 18),
  ('9100014', N'DOXAZOSINA TEVA 4MG EFG', 'E1079', 5.20, 2.8080, 2.6520, '4', 0, 1, 0, 0, 16, 10, 18),
  ('9100015', N'DOXAZOSINA KERN 4MG EFG', 'E0863', 5.35, 2.8890, 2.5680, '4', 0, 1, 0, 0, 11, 10, 18),
  ('9100016', N'ESCITALOPRAM CINFA 10MG EFG', 'E0111', 8.90, 4.8060, 4.4500, '4', 0, 1, 0, 0, 20, 12, 22),
  ('9100017', N'ESCITALOPRAM NORMON 10MG EFG', 'E0426', 8.70, 4.6980, 4.6110, '4', 0, 1, 0, 0, 14, 12, 22),
  ('9100018', N'ESCITALOPRAM TEVA 10MG EFG', 'E1079', 9.00, 4.8600, 4.3200, '4', 0, 1, 0, 0, 8, 12, 22),
  ('9100019', N'AZITROMICINA KERN 500MG EFG', 'E0863', 5.75, 3.1050, 2.8750, '4', 0, 1, 0, 0, 10, 8, 15),
  ('9100020', N'AZITROMICINA NORMON 500MG EFG', 'E0426', 5.60, 3.0240, 2.9680, '4', 0, 1, 0, 0, 6, 8, 15),
  ('9100021', N'CIPROFLOXACINO CINFA 500MG EFG', 'E0111', 4.30, 2.3220, 2.1500, '4', 0, 1, 0, 0, 12, 8, 15),
  ('9100022', N'CIPROFLOXACINO TEVA 500MG EFG', 'E1079', 4.45, 2.4030, 2.1360, '4', 0, 1, 0, 0, 7, 8, 15),
  ('9100023', N'LORATADINA NORMON 10MG EFG', 'E0426', 2.60, 1.4040, 1.3260, '4', 0, 1, 0, 0, 25, 15, 25),
  ('9100024', N'LORATADINA KERN 10MG EFG', 'E0863', 2.70, 1.4580, 1.2960, '4', 0, 1, 0, 0, 18, 15, 25),
  ('9100025', N'PREDNISONA CINFA 5MG EFG', 'E0111', 3.15, 1.7010, 1.5750, '4', 0, 1, 0, 0, 16, 10, 18),
  ('9100026', N'PREDNISONA TEVA 5MG EFG', 'E1079', 3.05, 1.6470, 1.6165, '4', 0, 1, 0, 0, 11, 10, 18),
  ('9100027', N'WARFARINA NORMON 5MG EFG', 'E0426', 2.90, 1.5660, 1.4500, '4', 0, 1, 0, 0, 14, 10, 18),
  ('9100028', N'GLICLAZIDA KERN 30MG EFG', 'E0863', 6.10, 3.2940, 3.0500, '4', 0, 1, 0, 0, 18, 12, 20),
  ('9100029', N'GLICLAZIDA CINFA 30MG EFG', 'E0111', 6.25, 3.3750, 3.0000, '4', 0, 1, 0, 0, 13, 12, 20),
  ('9100030', N'ROSUVASTATINA TEVA 20MG EFG', 'E1079', 9.80, 5.2920, 4.9980, '4', 0, 1, 0, 0, 30, 18, 30),
  ('9100031', N'ROSUVASTATINA NORMON 20MG EFG', 'E0426', 9.60, 5.1840, 5.7600, '4', 0, 1, 0, 0, 6, 18, 30),
  ('9100032', N'ROSUVASTATINA CINFA 20MG EFG', 'E0111', 9.95, 5.3730, 6.1690, '4', 0, 1, 0, 0, 4, 18, 30),
  ('9600001', N'INFLIXIMAB 100MG VIAL', 'E0863', 420.00, 226.8000, 336.0000, '4', 0, 1, 0, 0, 2, 2, 4),
  ('9600002', N'INSULINA GLARGINA 100U/ML 5 PLUMAS', 'E0426', 68.50, 36.9900, 54.8000, '4', 0, 1, 0, 0, 8, 5, 12),
  ('9600003', N'SOMATROPINA 12MG CARTUCHO', 'E0111', 195.30, 105.4620, 156.2400, '4', 0, 1, 0, 0, 20, 6, 12),
  ('9600004', N'INTERFERON BETA-1A 44MCG JERINGA', 'E1079', 610.00, 329.4000, 488.0000, '4', 0, 1, 0, 0, 6, 4, 8);
GO

INSERT INTO GeneArti (IdArticu, IdGrupoGen, EFG) VALUES
  ('1000001', 101, 1),
  ('1000002', 102, 1),
  ('1000003', 103, 1),
  ('1000004', 104, 1),
  ('1000005', 101, 1),
  ('1000007', 105, 1),
  ('1000008', 106, 1),
  ('9000001', 901, 1), ('9000002', 901, 1), ('9000003', 901, 1),
  ('9000004', 902, 1), ('9000005', 902, 1),
  ('9000006', 903, 1), ('9000007', 903, 1),
  ('9000008', 904, 1), ('9000009', 904, 1), ('9000010', 904, 1),
  ('9000011', 905, 1), ('9000012', 905, 1),
  ('9000013', 906, 1), ('9000014', 906, 1),
  ('9000015', 907, 1),
  ('9000016', 908, 1), ('9000017', 908, 1),
  ('9000018', 909, 1), ('9000019', 909, 1),
  ('9000020', 910, 1), ('9000021', 910, 1);
GO

INSERT INTO GeneArti (IdArticu, IdGrupoGen, EFG) VALUES
  ('9100001', 911, 1), ('9100002', 911, 1), ('9100003', 911, 1),
  ('9100004', 912, 1), ('9100005', 912, 1),
  ('9100006', 913, 1), ('9100007', 913, 1), ('9100008', 913, 1),
  ('9100009', 914, 1), ('9100010', 914, 1),
  ('9100011', 915, 1),
  ('9100012', 916, 1), ('9100013', 916, 1),
  ('9100014', 917, 1), ('9100015', 917, 1),
  ('9100016', 918, 1), ('9100017', 918, 1), ('9100018', 918, 1),
  ('9100019', 919, 1), ('9100020', 919, 1),
  ('9100021', 920, 1), ('9100022', 920, 1),
  ('9100023', 921, 1), ('9100024', 921, 1),
  ('9100025', 922, 1), ('9100026', 922, 1),
  ('9100027', 923, 1),
  ('9100028', 924, 1), ('9100029', 924, 1),
  ('9100030', 925, 1), ('9100031', 925, 1), ('9100032', 925, 1);
GO

-- Ventas 2024 (enero–diciembre)
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2024,  1, '2024-01-15 09:00', 1, 1001, 'C', 13.98, 1),
  (2024,  1, '2024-01-20 11:30', 2, 1002, 'C',  8.35, 1),
  (2024,  2, '2024-02-10 10:00', 1, 1001, 'C', 21.30, 1),
  (2024,  3, '2024-03-12 11:00', 2, 1003, 'C',  9.10, 1),
  (2024,  4, '2024-04-18 09:30', 3, 1002, 'C',  5.50, 1),
  (2024,  5, '2024-05-22 14:00', 1, 1001, 'C', 18.80, 1),
  (2024,  6, '2024-06-05 10:30', 2, 1004, 'C', 20.11, 1),
  (2024,  7, '2024-07-08 10:00', 3, 1001, 'C', 26.56, 1),
  (2024,  8, '2024-08-14 11:00', 1, 1003, 'C', 11.70, 1),
  (2024,  9, '2024-09-19 09:00', 2, 1002, 'C', 11.68, 1),
  (2024, 10, '2024-10-25 10:00', 1, 1004, 'C', 18.23, 1),
  (2024, 11, '2024-11-08 14:30', 3, 1001, 'C', 45.80, 1),
  (2024, 12, '2024-12-20 10:00', 2, 1003, 'C', 14.46, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  -- Ene
  (1,  '1000001', 2,  11.16,  5.58),
  (1,  '1000002', 1,   2.82,  2.82),
  (2,  '1000003', 1,   3.49,  3.49),
  (2,  '1000004', 3,   4.86,  1.62),
  -- Feb
  (3,  '1000001', 3,  16.74,  5.58),
  (3,  '1000006', 2,   4.56,  2.28),
  -- Mar
  (4,  '1000007', 1,   2.12,  2.12),
  (4,  '1000003', 2,   6.98,  3.49),
  -- Abr
  (5,  '1000008', 2,   3.88,  1.94),
  (5,  '1000004', 1,   1.62,  1.62),
  -- May
  (6,  '1000002', 5,  14.10,  2.82),
  (6,  '1000005', 1,   4.70,  4.70),
  -- Jun
  (7,  '1000001', 2,  11.16,  5.58),
  (7,  '2000001', 1,   8.95,  8.95),
  -- Jul
  (8,  '1000001', 4,  22.32,  5.58),
  (8,  '1000007', 2,   4.24,  2.12),
  -- Ago
  (9,  '1000002', 3,   8.46,  2.82),
  (9,  '1000004', 2,   3.24,  1.62),
  -- Sep
  (10, '1000005', 2,   9.40,  4.70),
  (10, '1000006', 1,   2.28,  2.28),
  -- Oct
  (11, '1000003', 3,  10.47,  3.49),
  (11, '1000008', 4,   7.76,  1.94),
  -- Nov
  (12, '1000001', 5,  27.90,  5.58),
  (12, '2000001', 2,  17.90,  8.95),
  -- Dic
  (13, '1000007', 3,   6.36,  2.12),
  (13, '1000004', 5,   8.10,  1.62);
GO

-- Ventas 2025 (enero–junio)
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2025, 1, '2025-01-10 09:00', 1, 1001, 'C', 23.72, 1),
  (2025, 2, '2025-02-14 10:00', 2, 1002, 'C', 20.68, 1),
  (2025, 3, '2025-03-20 11:00', 1, 1004, 'C',  6.98, 1),
  (2025, 4, '2025-04-15 09:30', 3, 1003, 'C', 33.72, 1),
  (2025, 5, '2025-05-22 14:00', 2, 1001, 'C',  8.05, 1),
  (2025, 6, '2025-06-10 10:30', 1, 1002, 'C', 15.66, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (14, '1000001', 3,  16.74,  5.58),
  (14, '1000003', 2,   6.98,  3.49),
  (15, '1000002', 4,  11.28,  2.82),
  (15, '1000005', 2,   9.40,  4.70),
  (16, '1000004', 3,   4.86,  1.62),
  (16, '1000007', 1,   2.12,  2.12),
  (17, '1000001', 5,  27.90,  5.58),
  (17, '1000008', 3,   5.82,  1.94),
  (18, '1000006', 2,   4.56,  2.28),
  (18, '1000003', 1,   3.49,  3.49),
  (19, '1000001', 2,  11.16,  5.58),
  (19, '2000002', 1,   4.50,  4.50);
GO

-- Recepciones (últimos 2 meses — fechas relativas a 2026)
INSERT INTO Recep (FechaRecep, XProv_IdProveedor) VALUES
  ('2026-05-10', 'E0111'),
  ('2026-05-20', 'E0426'),
  ('2026-06-01', 'E0863'),
  ('2026-06-15', 'E1079');
GO

INSERT INTO LineaRecep (IdRecep, XRecep_IdRecep, Codigo, Cantidad, PrecioNeto, Bonificacion) VALUES
  (1, 1, '1000001', 50, 2.85, 5.00),
  (1, 1, '1000004', 30, 0.82, 3.00),
  (1, 1, '1000008', 20, 0.98, 2.00),
  (2, 2, '1000002', 40, 1.45, 5.00),
  (2, 2, '1000006', 25, 1.15, 3.00),
  (3, 3, '1000003', 35, 1.78, 4.00),
  (3, 3, '1000007', 45, 1.05, 3.00),
  (4, 4, '1000005', 30, 2.40, 5.00);
GO

-- Caso Jose-2: SIN las 7 listas de categoría, solo una lista "FAVORITOS" con el favorito
-- real elegido por el titular para cada grupo homogéneo (uno por CODConjunto, ver
-- BP_CONJARTI/BP_CONJUNTOS más abajo) — asegurarListas()/sembrarFavoritosReales() deben
-- crear las 7 listas de categoría solas y sembrar cada favorito en la que corresponda.
-- 1000006 (LORAZEPAM) no tiene CODConjunto en BP_CONJARTI a propósito — prueba el fallback
-- a RESTO/gris para favoritos reales sin grupo homogéneo oficial.
INSERT INTO ListaArticu (IdLista, Nombre, Fecha, NumElem, Tipo, EnviarGrupo, IdTipoLista) VALUES
  (1, N'FAVORITOS', GETDATE(), 7, 0, 0, 1);
GO

INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu) VALUES
  (1, 1000001),
  (1, 1000002),
  (1, 1000003),
  (1, 1000004),
  (1, 1000006),
  (1, 1000007),
  (1, 1000008);
GO

-- Pacientes (IDs coinciden con XClie_IdCliente de Venta)
INSERT INTO Cliente (IdCliente, Nombre, Apellido1, Apellido2, Telefono) VALUES
  (1001, N'María',   N'García',   N'Martínez', '666111001'),
  (1002, N'José',    N'López',    N'Sánchez',  '666111002'),
  (1003, N'Carmen',  N'Martínez', N'López',    '666111003'),
  (1004, N'Antonio', N'Sánchez',  N'García',   '666111004');
GO

-- Clientes RGPD: OpcRGPD=31 → el sync los auto-registra en cronicos.db con consentimiento=1
INSERT INTO ClienteRGPD (OpcRGPD, XClie_IdCliente) VALUES
  (31, 1001),
  (31, 1002),
  (1,  1003),
  (1,  1004),
  (2,  NULL),
  (2,  NULL);
GO

-- Encargos recientes (últimos 7 días respecto a la fecha de init)
INSERT INTO Encargo (Codigo, Cantidad, FechaRecepcion, XArt_IdArticu, XCli_IdCliente, Vendedor, Unidades, IdContador, NumTicket, Situacion, Estado) VALUES
  ('1000001', 2, '2026-06-28', '1000001', 1001, 1, 2, 10001, 5001, 1, 1),
  ('1000003', 1, '2026-06-30', '1000003', 1002, 2, 1, 10002, 5002, 1, 1),
  ('1000007', 3, '2026-07-01', '1000007', 1003, 1, 3, 10003, 5003, 0, 1);
GO

-- Ventas 2026 recientes (para crónicos: dentro de los últimos 90 días)
-- IdVenta 20-24 (tras los 19 anteriores)
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2026, 5, '2026-05-10 09:30', 1, 1001, 'C', 16.48, 1),
  (2026, 5, '2026-05-18 11:00', 2, 1002, 'C',  7.73, 1),
  (2026, 6, '2026-06-05 10:00', 1, 1001, 'C', 11.40, 1),
  (2026, 6, '2026-06-20 09:00', 3, 1002, 'C',  6.98, 1),
  (2026, 7, '2026-07-01 10:00', 1, 1001, 'C',  7.62, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (20, '1000001', 2, 11.16, 5.58),
  (20, '1000004', 3,  4.86, 1.62),
  (21, '1000003', 1,  3.49, 3.49),
  (21, '1000007', 2,  4.24, 2.12),
  (22, '1000001', 1,  5.58, 5.58),
  (22, '1000008', 3,  5.82, 1.94),
  (23, '1000003', 2,  6.98, 3.49),
  (24, '1000007', 2,  4.24, 2.12),
  (24, '1000004', 2,  3.24, 1.62);
GO

-- Módulo Receta — ventas de los últimos 3 meses completos (mayo/junio/julio 2026) para
-- 1000006 (huérfano ya existente sin CODConjunto) y para los 21 CN nuevos + 3 huérfanos
-- hospitalarios de la ampliación 2026-08-01 — todo necesita venta RECIENTE de verdad para
-- pasar el filtro de relevancia de Fase 2 y tener una propuesta de stock (Fase 5) distinta
-- de "encargo puro" (vel_mes=0). BISOPROLOL (9000020/9000021) se deja FUERA a propósito —
-- es el caso PARADOS de este set. Una "cesta" por mes, IdVenta 25-27 (tras las 24 anteriores).
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2026, 5, '2026-05-12 10:00', 1, 1001, 'C', 875.63, 1),
  (2026, 6, '2026-06-14 11:00', 2, 1002, 'C', 875.63, 1),
  (2026, 7, '2026-07-10 09:30', 3, 1003, 'C', 875.63, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (25, '1000006',  1,   2.28,   2.28),
  (25, '9000001',  5,  16.00,   3.20), (25, '9000002', 2,  6.30, 3.15), (25, '9000003', 1,  3.25, 3.25),
  (25, '9000004',  4,  16.40,   4.10), (25, '9000005', 2,  8.10, 4.05),
  (25, '9000006',  2,   5.90,   2.95), (25, '9000007', 6, 18.00, 3.00),
  (25, '9000008',  7,  12.95,   1.85), (25, '9000009', 3,  5.40, 1.80), (25, '9000010', 1,  1.90, 1.90),
  (25, '9000011',  3,   6.30,   2.10), (25, '9000012', 1,  2.05, 2.05),
  (25, '9000013',  8,  27.20,   3.40), (25, '9000014', 3, 10.05, 3.35),
  (25, '9000015',  2,   5.20,   2.60),
  (25, '9000016',  2,   3.40,   1.70), (25, '9000017', 1,  1.65, 1.65),
  (25, '9000018',  4,  15.20,   3.80), (25, '9000019', 2,  7.50, 3.75),
  (25, '9500001',  1, 285.40, 285.40), (25, '9500002', 1, 95.20, 95.20), (25, '9500003', 1, 320.00, 320.00),
  (26, '1000006',  1,   2.28,   2.28),
  (26, '9000001',  5,  16.00,   3.20), (26, '9000002', 2,  6.30, 3.15), (26, '9000003', 1,  3.25, 3.25),
  (26, '9000004',  4,  16.40,   4.10), (26, '9000005', 2,  8.10, 4.05),
  (26, '9000006',  2,   5.90,   2.95), (26, '9000007', 6, 18.00, 3.00),
  (26, '9000008',  7,  12.95,   1.85), (26, '9000009', 3,  5.40, 1.80), (26, '9000010', 1,  1.90, 1.90),
  (26, '9000011',  3,   6.30,   2.10), (26, '9000012', 1,  2.05, 2.05),
  (26, '9000013',  8,  27.20,   3.40), (26, '9000014', 3, 10.05, 3.35),
  (26, '9000015',  2,   5.20,   2.60),
  (26, '9000016',  2,   3.40,   1.70), (26, '9000017', 1,  1.65, 1.65),
  (26, '9000018',  4,  15.20,   3.80), (26, '9000019', 2,  7.50, 3.75),
  (26, '9500001',  1, 285.40, 285.40), (26, '9500002', 1, 95.20, 95.20), (26, '9500003', 1, 320.00, 320.00),
  (27, '1000006',  1,   2.28,   2.28),
  (27, '9000001',  5,  16.00,   3.20), (27, '9000002', 2,  6.30, 3.15), (27, '9000003', 1,  3.25, 3.25),
  (27, '9000004',  4,  16.40,   4.10), (27, '9000005', 2,  8.10, 4.05),
  (27, '9000006',  2,   5.90,   2.95), (27, '9000007', 6, 18.00, 3.00),
  (27, '9000008',  7,  12.95,   1.85), (27, '9000009', 3,  5.40, 1.80), (27, '9000010', 1,  1.90, 1.90),
  (27, '9000011',  3,   6.30,   2.10), (27, '9000012', 1,  2.05, 2.05),
  (27, '9000013',  8,  27.20,   3.40), (27, '9000014', 3, 10.05, 3.35),
  (27, '9000015',  2,   5.20,   2.60),
  (27, '9000016',  2,   3.40,   1.70), (27, '9000017', 1,  1.65, 1.65),
  (27, '9000018',  4,  15.20,   3.80), (27, '9000019', 2,  7.50, 3.75),
  (27, '9500001',  1, 285.40, 285.40), (27, '9500002', 1, 95.20, 95.20), (27, '9500003', 1, 320.00, 320.00);
GO

-- 2ª tanda (2026-08-01) — 6 meses de venta (feb-jul 2026) para los 15 GH nuevos (ch 911-925)
-- y los 4 huérfanos nuevos, con volumen creciente en los 'star' (Clopidogrel/Levotiroxina),
-- cero venta en los 'parados' (Azitromicina/Ciprofloxacino — antibióticos de pauta corta,
-- caso realista de PARADOS) y un laboratorio claramente dominante en Rosuvastatina
-- ('consolidado' — el resto solo vende de forma esporádica, sustitución sostenida ~90%+).
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2026, 2, '2026-02-10 10:30', 1, 2001, 'C', 1999.30, 1),
  (2026, 3, '2026-03-12 10:30', 2, 2002, 'C', 2080.50, 1),
  (2026, 4, '2026-04-11 10:30', 3, 2003, 'C', 2122.60, 1),
  (2026, 5, '2026-05-13 10:30', 1, 2004, 'C', 2203.80, 1),
  (2026, 6, '2026-06-15 10:30', 2, 2005, 'C', 2245.90, 1),
  (2026, 7, '2026-07-11 10:30', 3, 2006, 'C', 2327.10, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (28, '9100001', 6, 94.35, 18.50), (28, '9100002', 7, 108.29, 18.20), (28, '9100003', 8, 127.84, 18.80),
  (28, '9100004', 6, 15.81, 3.10), (28, '9100005', 7, 18.15, 3.05),
  (28, '9100006', 2, 10.88, 6.40), (28, '9100007', 3, 16.70, 6.55), (28, '9100008', 4, 21.42, 6.30),
  (28, '9100009', 2, 3.74, 2.20), (28, '9100010', 3, 5.48, 2.15),
  (28, '9100011', 2, 6.12, 3.60),
  (28, '9100012', 2, 3.31, 1.95), (28, '9100013', 3, 4.84, 1.90),
  (28, '9100014', 2, 8.84, 5.20), (28, '9100015', 3, 13.64, 5.35),
  (28, '9100016', 2, 15.13, 8.90), (28, '9100017', 3, 22.18, 8.70), (28, '9100018', 4, 30.60, 9.00),
  (28, '9100023', 2, 4.42, 2.60), (28, '9100024', 3, 6.89, 2.70),
  (28, '9100025', 2, 5.35, 3.15), (28, '9100026', 3, 7.78, 3.05),
  (28, '9100027', 2, 4.93, 2.90),
  (28, '9100028', 2, 10.37, 6.10), (28, '9100029', 3, 15.94, 6.25),
  (28, '9100030', 2, 16.66, 9.80),
  (28, '9600001', 1, 357.00, 420.00), (28, '9600002', 1, 58.23, 68.50), (28, '9600003', 1, 166.00, 195.30), (28, '9600004', 1, 518.50, 610.00),
  (29, '9100001', 7, 110.08, 18.50), (29, '9100002', 8, 123.76, 18.20), (29, '9100003', 9, 143.82, 18.80),
  (29, '9100004', 7, 18.45, 3.10), (29, '9100005', 8, 20.74, 3.05),
  (29, '9100006', 2, 10.88, 6.40), (29, '9100007', 3, 16.70, 6.55), (29, '9100008', 4, 21.42, 6.30),
  (29, '9100009', 2, 3.74, 2.20), (29, '9100010', 3, 5.48, 2.15),
  (29, '9100011', 2, 6.12, 3.60),
  (29, '9100012', 2, 3.31, 1.95), (29, '9100013', 3, 4.84, 1.90),
  (29, '9100014', 2, 8.84, 5.20), (29, '9100015', 3, 13.64, 5.35),
  (29, '9100016', 2, 15.13, 8.90), (29, '9100017', 3, 22.18, 8.70), (29, '9100018', 4, 30.60, 9.00),
  (29, '9100023', 2, 4.42, 2.60), (29, '9100024', 3, 6.89, 2.70),
  (29, '9100025', 2, 5.35, 3.15), (29, '9100026', 3, 7.78, 3.05),
  (29, '9100027', 2, 4.93, 2.90),
  (29, '9100028', 2, 10.37, 6.10), (29, '9100029', 3, 15.94, 6.25),
  (29, '9100030', 2, 16.66, 9.80), (29, '9100031', 1, 8.16, 9.60), (29, '9100032', 1, 8.46, 9.95),
  (29, '9600001', 1, 357.00, 420.00), (29, '9600002', 1, 58.23, 68.50), (29, '9600003', 1, 166.00, 195.30), (29, '9600004', 1, 518.50, 610.00),
  (30, '9100001', 8, 125.80, 18.50), (30, '9100002', 9, 139.23, 18.20), (30, '9100003', 10, 159.80, 18.80),
  (30, '9100004', 8, 21.08, 3.10), (30, '9100005', 9, 23.33, 3.05),
  (30, '9100006', 2, 10.88, 6.40), (30, '9100007', 3, 16.70, 6.55), (30, '9100008', 4, 21.42, 6.30),
  (30, '9100009', 2, 3.74, 2.20), (30, '9100010', 3, 5.48, 2.15),
  (30, '9100011', 2, 6.12, 3.60),
  (30, '9100012', 2, 3.31, 1.95), (30, '9100013', 3, 4.84, 1.90),
  (30, '9100014', 2, 8.84, 5.20), (30, '9100015', 3, 13.64, 5.35),
  (30, '9100016', 2, 15.13, 8.90), (30, '9100017', 3, 22.18, 8.70), (30, '9100018', 4, 30.60, 9.00),
  (30, '9100023', 2, 4.42, 2.60), (30, '9100024', 3, 6.89, 2.70),
  (30, '9100025', 2, 5.35, 3.15), (30, '9100026', 3, 7.78, 3.05),
  (30, '9100027', 2, 4.93, 2.90),
  (30, '9100028', 2, 10.37, 6.10), (30, '9100029', 3, 15.94, 6.25),
  (30, '9100030', 2, 16.66, 9.80),
  (30, '9600001', 1, 357.00, 420.00), (30, '9600002', 1, 58.23, 68.50), (30, '9600003', 1, 166.00, 195.30), (30, '9600004', 1, 518.50, 610.00),
  (31, '9100001', 9, 141.53, 18.50), (31, '9100002', 10, 154.70, 18.20), (31, '9100003', 11, 175.78, 18.80),
  (31, '9100004', 9, 23.71, 3.10), (31, '9100005', 10, 25.93, 3.05),
  (31, '9100006', 2, 10.88, 6.40), (31, '9100007', 3, 16.70, 6.55), (31, '9100008', 4, 21.42, 6.30),
  (31, '9100009', 2, 3.74, 2.20), (31, '9100010', 3, 5.48, 2.15),
  (31, '9100011', 2, 6.12, 3.60),
  (31, '9100012', 2, 3.31, 1.95), (31, '9100013', 3, 4.84, 1.90),
  (31, '9100014', 2, 8.84, 5.20), (31, '9100015', 3, 13.64, 5.35),
  (31, '9100016', 2, 15.13, 8.90), (31, '9100017', 3, 22.18, 8.70), (31, '9100018', 4, 30.60, 9.00),
  (31, '9100023', 2, 4.42, 2.60), (31, '9100024', 3, 6.89, 2.70),
  (31, '9100025', 2, 5.35, 3.15), (31, '9100026', 3, 7.78, 3.05),
  (31, '9100027', 2, 4.93, 2.90),
  (31, '9100028', 2, 10.37, 6.10), (31, '9100029', 3, 15.94, 6.25),
  (31, '9100030', 2, 16.66, 9.80), (31, '9100031', 1, 8.16, 9.60), (31, '9100032', 1, 8.46, 9.95),
  (31, '9600001', 1, 357.00, 420.00), (31, '9600002', 1, 58.23, 68.50), (31, '9600003', 1, 166.00, 195.30), (31, '9600004', 1, 518.50, 610.00),
  (32, '9100001', 10, 157.25, 18.50), (32, '9100002', 11, 170.17, 18.20), (32, '9100003', 12, 191.76, 18.80),
  (32, '9100004', 10, 26.35, 3.10), (32, '9100005', 11, 28.52, 3.05),
  (32, '9100006', 2, 10.88, 6.40), (32, '9100007', 3, 16.70, 6.55), (32, '9100008', 4, 21.42, 6.30),
  (32, '9100009', 2, 3.74, 2.20), (32, '9100010', 3, 5.48, 2.15),
  (32, '9100011', 2, 6.12, 3.60),
  (32, '9100012', 2, 3.31, 1.95), (32, '9100013', 3, 4.84, 1.90),
  (32, '9100014', 2, 8.84, 5.20), (32, '9100015', 3, 13.64, 5.35),
  (32, '9100016', 2, 15.13, 8.90), (32, '9100017', 3, 22.18, 8.70), (32, '9100018', 4, 30.60, 9.00),
  (32, '9100023', 2, 4.42, 2.60), (32, '9100024', 3, 6.89, 2.70),
  (32, '9100025', 2, 5.35, 3.15), (32, '9100026', 3, 7.78, 3.05),
  (32, '9100027', 2, 4.93, 2.90),
  (32, '9100028', 2, 10.37, 6.10), (32, '9100029', 3, 15.94, 6.25),
  (32, '9100030', 2, 16.66, 9.80),
  (32, '9600001', 1, 357.00, 420.00), (32, '9600002', 1, 58.23, 68.50), (32, '9600003', 1, 166.00, 195.30), (32, '9600004', 1, 518.50, 610.00),
  (33, '9100001', 11, 172.97, 18.50), (33, '9100002', 12, 185.64, 18.20), (33, '9100003', 13, 207.74, 18.80),
  (33, '9100004', 11, 28.98, 3.10), (33, '9100005', 12, 31.11, 3.05),
  (33, '9100006', 2, 10.88, 6.40), (33, '9100007', 3, 16.70, 6.55), (33, '9100008', 4, 21.42, 6.30),
  (33, '9100009', 2, 3.74, 2.20), (33, '9100010', 3, 5.48, 2.15),
  (33, '9100011', 2, 6.12, 3.60),
  (33, '9100012', 2, 3.31, 1.95), (33, '9100013', 3, 4.84, 1.90),
  (33, '9100014', 2, 8.84, 5.20), (33, '9100015', 3, 13.64, 5.35),
  (33, '9100016', 2, 15.13, 8.90), (33, '9100017', 3, 22.18, 8.70), (33, '9100018', 4, 30.60, 9.00),
  (33, '9100023', 2, 4.42, 2.60), (33, '9100024', 3, 6.89, 2.70),
  (33, '9100025', 2, 5.35, 3.15), (33, '9100026', 3, 7.78, 3.05),
  (33, '9100027', 2, 4.93, 2.90),
  (33, '9100028', 2, 10.37, 6.10), (33, '9100029', 3, 15.94, 6.25),
  (33, '9100030', 2, 16.66, 9.80), (33, '9100031', 1, 8.16, 9.60), (33, '9100032', 1, 8.46, 9.95),
  (33, '9600001', 1, 357.00, 420.00), (33, '9600002', 1, 58.23, 68.50), (33, '9600003', 1, 166.00, 195.30), (33, '9600004', 1, 518.50, 610.00);
GO

-- Tablas 4DB (catálogo de distribuidor: PVL negociado + descuentos por modelo)
CREATE TABLE _4DB_CAT_CatalogoArt (
  codigoNacional INT,
  pvl            DECIMAL(10,4),
  catalogo       INT DEFAULT 1,
  iva            CHAR(1) DEFAULT 'S'
);
GO

CREATE TABLE _4DB_CAT_Models (
  codigonacional INT,
  discount       DECIMAL(8,4),
  nombre         VARCHAR(50),
  catalogo       INT DEFAULT 1
);
GO

INSERT INTO _4DB_CAT_CatalogoArt (codigoNacional, pvl, catalogo, iva) VALUES
  (1000001, 2.79, 1, 'S'),
  (1000002, 1.40, 1, 'S'),
  (1000003, 1.73, 1, 'S'),
  (1000004, 0.79, 1, 'S'),
  (1000005, 2.45, 1, 'S'),
  (1000006, 1.18, 1, 'S'),
  (1000007, 1.02, 1, 'S'),
  (1000008, 0.95, 1, 'S'),
  -- 10 GH nuevos — descuentos distintos por laboratorio dentro de cada grupo, para que el
  -- ranking verde/amarillo/gris de Genéricos tenga sentido (no todos empatados).
  (9000001, 1.73, 1, 'S'), (9000002, 1.70, 1, 'S'), (9000003, 1.76, 1, 'S'),
  (9000004, 2.21, 1, 'S'), (9000005, 2.19, 1, 'S'),
  (9000006, 1.59, 1, 'S'), (9000007, 1.62, 1, 'S'),
  (9000008, 1.00, 1, 'S'), (9000009, 0.97, 1, 'S'), (9000010, 1.03, 1, 'S'),
  (9000011, 1.13, 1, 'S'), (9000012, 1.11, 1, 'S'),
  (9000013, 1.84, 1, 'S'), (9000014, 1.81, 1, 'S'),
  (9000015, 1.40, 1, 'S'),
  (9000016, 0.92, 1, 'S'), (9000017, 0.89, 1, 'S'),
  (9000018, 2.05, 1, 'S'), (9000019, 2.03, 1, 'S'),
  (9000020, 0.84, 1, 'S'), (9000021, 0.81, 1, 'S'),
  (9100001, 9.9900, 1, 'S'), (9100002, 9.8280, 1, 'S'), (9100003, 10.1520, 1, 'S'),
  (9100004, 1.6740, 1, 'S'), (9100005, 1.6470, 1, 'S'),
  (9100006, 3.4560, 1, 'S'), (9100007, 3.5370, 1, 'S'), (9100008, 3.4020, 1, 'S'),
  (9100009, 1.1880, 1, 'S'), (9100010, 1.1610, 1, 'S'),
  (9100011, 1.9440, 1, 'S'),
  (9100012, 1.0530, 1, 'S'), (9100013, 1.0260, 1, 'S'),
  (9100014, 2.8080, 1, 'S'), (9100015, 2.8890, 1, 'S'),
  (9100016, 4.8060, 1, 'S'), (9100017, 4.6980, 1, 'S'), (9100018, 4.8600, 1, 'S'),
  (9100019, 3.1050, 1, 'S'), (9100020, 3.0240, 1, 'S'),
  (9100021, 2.3220, 1, 'S'), (9100022, 2.4030, 1, 'S'),
  (9100023, 1.4040, 1, 'S'), (9100024, 1.4580, 1, 'S'),
  (9100025, 1.7010, 1, 'S'), (9100026, 1.6470, 1, 'S'),
  (9100027, 1.5660, 1, 'S'),
  (9100028, 3.2940, 1, 'S'), (9100029, 3.3750, 1, 'S'),
  (9100030, 5.2920, 1, 'S'), (9100031, 5.1840, 1, 'S'), (9100032, 5.3730, 1, 'S');
GO

INSERT INTO _4DB_CAT_Models (codigonacional, discount, nombre, catalogo) VALUES
  (1000001, 5.00, 'COFARES DIRECTO', 1),
  (1000002, 5.00, 'COFARES DIRECTO', 1),
  (1000003, 4.00, 'NEXO',            1),
  (1000004, 5.00, 'COFARES DIRECTO', 1),
  (1000005, 3.00, 'NEXO',            1),
  (1000006, 4.00, 'COFARES DIRECTO', 1),
  (1000007, 3.00, 'NEXO',            1),
  (1000008, 5.00, 'COFARES DIRECTO', 1),
  (9000001, 5.00, 'COFARES DIRECTO', 1), (9000002, 4.00, 'NEXO', 1), (9000003, 3.00, 'NEXO', 1),
  (9000004, 5.00, 'COFARES DIRECTO', 1), (9000005, 3.00, 'NEXO', 1),
  (9000006, 4.00, 'NEXO', 1),            (9000007, 5.00, 'COFARES DIRECTO', 1),
  (9000008, 5.00, 'COFARES DIRECTO', 1), (9000009, 4.00, 'NEXO', 1), (9000010, 3.00, 'NEXO', 1),
  (9000011, 5.00, 'COFARES DIRECTO', 1), (9000012, 3.00, 'NEXO', 1),
  (9000013, 5.00, 'COFARES DIRECTO', 1), (9000014, 4.00, 'NEXO', 1),
  (9000015, 4.00, 'NEXO', 1),
  (9000016, 4.00, 'COFARES DIRECTO', 1), (9000017, 3.00, 'NEXO', 1),
  (9000018, 5.00, 'COFARES DIRECTO', 1), (9000019, 3.00, 'NEXO', 1),
  (9000020, 3.00, 'NEXO', 1),            (9000021, 4.00, 'COFARES DIRECTO', 1),
  (9100001, 5.00, 'COFARES DIRECTO', 1), (9100002, 3.50, 'NEXO', 1), (9100003, 5.00, 'COFARES DIRECTO', 1),
  (9100004, 5.00, 'COFARES DIRECTO', 1), (9100005, 3.50, 'NEXO', 1),
  (9100006, 5.00, 'COFARES DIRECTO', 1), (9100007, 5.00, 'COFARES DIRECTO', 1), (9100008, 3.50, 'NEXO', 1),
  (9100009, 5.00, 'COFARES DIRECTO', 1), (9100010, 3.50, 'NEXO', 1),
  (9100011, 5.00, 'COFARES DIRECTO', 1),
  (9100012, 5.00, 'COFARES DIRECTO', 1), (9100013, 3.50, 'NEXO', 1),
  (9100014, 5.00, 'COFARES DIRECTO', 1), (9100015, 5.00, 'COFARES DIRECTO', 1),
  (9100016, 5.00, 'COFARES DIRECTO', 1), (9100017, 3.50, 'NEXO', 1), (9100018, 5.00, 'COFARES DIRECTO', 1),
  (9100019, 5.00, 'COFARES DIRECTO', 1), (9100020, 3.50, 'NEXO', 1),
  (9100021, 5.00, 'COFARES DIRECTO', 1), (9100022, 5.00, 'COFARES DIRECTO', 1),
  (9100023, 5.00, 'COFARES DIRECTO', 1), (9100024, 5.00, 'COFARES DIRECTO', 1),
  (9100025, 5.00, 'COFARES DIRECTO', 1), (9100026, 3.50, 'NEXO', 1),
  (9100027, 5.00, 'COFARES DIRECTO', 1),
  (9100028, 5.00, 'COFARES DIRECTO', 1), (9100029, 5.00, 'COFARES DIRECTO', 1),
  (9100030, 5.00, 'COFARES DIRECTO', 1), (9100031, 3.50, 'NEXO', 1), (9100032, 3.50, 'NEXO', 1);
GO

-- ============================================================
-- CONSEJO — grupos homogéneos
-- ============================================================
USE Consejo;
GO

CREATE TABLE BP_CONJUNTOS (
  CODCONJUNTO INT          PRIMARY KEY,
  CODCCAA     INT          DEFAULT 0,
  NOMBRE      VARCHAR(200),
  PVPMENOR    DECIMAL(10,4),
  TIPO        VARCHAR(10)
);
GO

CREATE TABLE BP_CONJARTI (
  CODIGO      VARCHAR(20),
  CODConjunto INT,
  CODCCAA     INT DEFAULT 0
);
GO

-- PVPMENOR fijado al Pvp más alto de cada grupo (ver Articu más arriba) — con el valor
-- original (más bajo que algún miembro), fetchProductos() descartaba 1000001/1000002/
-- 1000004/1000008 enteros como "pvpSuperior" (dato inconsistente) y nunca llegaban a
-- Railway. No es un caso de prueba deliberado, era un desajuste de los datos de origen.
-- CODCONJUNTO 901-910 (no 107-116): ese rango ya lo usaba una siembra de datos anterior
-- de este mismo tenant en Railway con un bug de mapeo (ver comentario junto a Articu más
-- arriba) — se evita a propósito para no volver a mezclarse con esos datos viejos.
INSERT INTO BP_CONJUNTOS (CODCONJUNTO, CODCCAA, NOMBRE, PVPMENOR, TIPO) VALUES
  (101, 0, N'IBUPROFENO 600MG EFG',    5.58, 'EFG'),
  (102, 0, N'PARACETAMOL 1G EFG',      2.82, 'EFG'),
  (103, 0, N'AMOXICILINA 500MG EFG',   3.49, 'EFG'),
  (104, 0, N'OMEPRAZOL 20MG EFG',      1.62, 'EFG'),
  (105, 0, N'METFORMINA 850MG EFG',    2.12, 'EFG'),
  (106, 0, N'ATORVASTATINA 20MG EFG',  1.94, 'EFG'),
  (901, 0, N'SIMVASTATINA 20MG EFG',   3.25, 'EFG'),
  (902, 0, N'LOSARTAN 50MG EFG',       4.10, 'EFG'),
  (903, 0, N'ENALAPRIL 20MG EFG',      3.00, 'EFG'),
  (904, 0, N'AMLODIPINO 10MG EFG',     1.90, 'EFG'),
  (905, 0, N'FUROSEMIDA 40MG EFG',     2.10, 'EFG'),
  (906, 0, N'PANTOPRAZOL 40MG EFG',    3.40, 'EFG'),
  (907, 0, N'TRAMADOL 50MG EFG',       2.60, 'EFG'),
  (908, 0, N'DIAZEPAM 5MG EFG',        1.70, 'EFG'),
  (909, 0, N'CANDESARTAN 16MG EFG',    3.80, 'EFG'),
  (910, 0, N'BISOPROLOL 5MG EFG',      1.55, 'EFG'),
  -- 2ª tanda (2026-08-01) — 15 GH más, variedad terapéutica (cardio/psiquiatría/
  -- antibióticos/endocrino) y patrones de rotación (ver comentario junto a Articu).
  (911, 0, N'CLOPIDOGREL 75MG EFG',        18.80, 'EFG'),
  (912, 0, N'LEVOTIROXINA 100MCG EFG',      3.10, 'EFG'),
  (913, 0, N'SERTRALINA 50MG EFG',          6.55, 'EFG'),
  (914, 0, N'ALPRAZOLAM 0.5MG EFG',         2.20, 'EFG'),
  (915, 0, N'ACENOCUMAROL 4MG EFG',         3.60, 'EFG'),
  (916, 0, N'HIDROCLOROTIAZIDA 25MG EFG',   1.95, 'EFG'),
  (917, 0, N'DOXAZOSINA 4MG EFG',           5.35, 'EFG'),
  (918, 0, N'ESCITALOPRAM 10MG EFG',        9.00, 'EFG'),
  (919, 0, N'AZITROMICINA 500MG EFG',       5.75, 'EFG'),
  (920, 0, N'CIPROFLOXACINO 500MG EFG',     4.45, 'EFG'),
  (921, 0, N'LORATADINA 10MG EFG',          2.70, 'EFG'),
  (922, 0, N'PREDNISONA 5MG EFG',           3.15, 'EFG'),
  (923, 0, N'WARFARINA 5MG EFG',            2.90, 'EFG'),
  (924, 0, N'GLICLAZIDA 30MG EFG',          6.25, 'EFG'),
  (925, 0, N'ROSUVASTATINA 20MG EFG',       9.95, 'EFG');
GO

INSERT INTO BP_CONJARTI (CODIGO, CODConjunto, CODCCAA) VALUES
  ('1000001', 101, 0),
  ('1000005', 101, 0),
  ('1000002', 102, 0),
  ('1000003', 103, 0),
  ('1000004', 104, 0),
  ('1000007', 105, 0),
  ('1000008', 106, 0),
  ('9000001', 901, 0), ('9000002', 901, 0), ('9000003', 901, 0),
  ('9000004', 902, 0), ('9000005', 902, 0),
  ('9000006', 903, 0), ('9000007', 903, 0),
  ('9000008', 904, 0), ('9000009', 904, 0), ('9000010', 904, 0),
  ('9000011', 905, 0), ('9000012', 905, 0),
  ('9000013', 906, 0), ('9000014', 906, 0),
  ('9000015', 907, 0),
  ('9000016', 908, 0), ('9000017', 908, 0),
  ('9000018', 909, 0), ('9000019', 909, 0),
  ('9000020', 910, 0), ('9000021', 910, 0),
  ('9100001', 911, 0), ('9100002', 911, 0), ('9100003', 911, 0),
  ('9100004', 912, 0), ('9100005', 912, 0),
  ('9100006', 913, 0), ('9100007', 913, 0), ('9100008', 913, 0),
  ('9100009', 914, 0), ('9100010', 914, 0),
  ('9100011', 915, 0),
  ('9100012', 916, 0), ('9100013', 916, 0),
  ('9100014', 917, 0), ('9100015', 917, 0),
  ('9100016', 918, 0), ('9100017', 918, 0), ('9100018', 918, 0),
  ('9100019', 919, 0), ('9100020', 919, 0),
  ('9100021', 920, 0), ('9100022', 920, 0),
  ('9100023', 921, 0), ('9100024', 921, 0),
  ('9100025', 922, 0), ('9100026', 922, 0),
  ('9100027', 923, 0),
  ('9100028', 924, 0), ('9100029', 924, 0),
  ('9100030', 925, 0), ('9100031', 925, 0), ('9100032', 925, 0);
GO

-- ============================================================
-- ESPEPARA (Módulo Receta) — clasificación oficial del Consejo General de Colegios
-- Farmacéuticos (BOT PLUS): DISPENSACION/TIPO/EFG/APORTACION, ver documento §1/§1.1.
-- ============================================================
CREATE TABLE ESPEPARA (
  CODIGO       VARCHAR(20)  PRIMARY KEY,
  DISPENSACION CHAR(1),
  TIPO         CHAR(1),
  EFG          VARCHAR(3),
  APORTACION   VARCHAR(10),
  FECHABAJA    DATETIME     NULL
);
GO

INSERT INTO ESPEPARA (CODIGO, DISPENSACION, TIPO, EFG, APORTACION, FECHABAJA) VALUES
  -- Genéricos EFG reales (mismo CN que ya tienen ch en BP_CONJARTI) — receta humana.
  ('1000001', 'R', 'E', 'EFG', 'AJ', NULL),
  ('1000002', 'R', 'E', 'EFG', 'AJ', NULL),
  ('1000003', 'R', 'E', 'EFG', 'AJ', NULL),
  ('1000004', 'R', 'E', 'EFG', 'AJ', NULL),
  ('1000005', 'R', 'E', 'EFG', 'AJ', NULL),
  -- 1000006 (LORAZEPAM) — receta humana SIN EFG (ético, sin genérico) y SIN CODConjunto en
  -- BP_CONJARTI: ya era el caso de "favorito real sin grupo homogéneo oficial" (ver más
  -- arriba); con DISPENSACION='R' pasa además a ser un candidato a GH único (Fase 3).
  ('1000006', 'R', 'E', NULL, 'AJ', NULL),
  ('1000007', 'R', 'E', 'EFG', 'AJ', NULL),
  ('1000008', 'R', 'E', 'EFG', 'AJ', NULL),
  -- Publicitarios/parafarmacia — DISPENSACION vacío, NUNCA deben colarse en Receta aunque
  -- tengan ventas reales (ver documento §3.1, filtro maestro DISPENSACION='R').
  ('2000001', NULL, 'P', NULL, NULL, NULL),
  ('2000002', NULL, 'P', NULL, NULL, NULL),
  -- Hospitalarios de dispensación ambulatoria, sin bioequivalente (Fase 3, GH único genuino
  -- por huérfano — no tienen fila en BP_CONJARTI).
  ('9500001', 'R', 'E', NULL, 'TLD', NULL),
  ('9500002', 'R', 'E', NULL, 'TLD', NULL),
  ('9500003', 'R', 'E', NULL, 'TLD', NULL),
  -- 10 GH nuevos multi-laboratorio (sustitución real para Genéricos, no solo GH único).
  ('9000001', 'R', 'E', 'EFG', 'AJ', NULL), ('9000002', 'R', 'E', 'EFG', 'AJ', NULL), ('9000003', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000004', 'R', 'E', 'EFG', 'AJ', NULL), ('9000005', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000006', 'R', 'E', 'EFG', 'AJ', NULL), ('9000007', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000008', 'R', 'E', 'EFG', 'AJ', NULL), ('9000009', 'R', 'E', 'EFG', 'AJ', NULL), ('9000010', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000011', 'R', 'E', 'EFG', 'AJ', NULL), ('9000012', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000013', 'R', 'E', 'EFG', 'AJ', NULL), ('9000014', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000015', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000016', 'R', 'E', 'EFG', 'AJ', NULL), ('9000017', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000018', 'R', 'E', 'EFG', 'AJ', NULL), ('9000019', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9000020', 'R', 'E', 'EFG', 'AJ', NULL), ('9000021', 'R', 'E', 'EFG', 'AJ', NULL),
  -- 15 GH más (2ª tanda) — todos genéricos EFG reales.
  ('9100001', 'R', 'E', 'EFG', 'AJ', NULL), ('9100002', 'R', 'E', 'EFG', 'AJ', NULL), ('9100003', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100004', 'R', 'E', 'EFG', 'AJ', NULL), ('9100005', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100006', 'R', 'E', 'EFG', 'AJ', NULL), ('9100007', 'R', 'E', 'EFG', 'AJ', NULL), ('9100008', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100009', 'R', 'E', 'EFG', 'AJ', NULL), ('9100010', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100011', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100012', 'R', 'E', 'EFG', 'AJ', NULL), ('9100013', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100014', 'R', 'E', 'EFG', 'AJ', NULL), ('9100015', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100016', 'R', 'E', 'EFG', 'AJ', NULL), ('9100017', 'R', 'E', 'EFG', 'AJ', NULL), ('9100018', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100019', 'R', 'E', 'EFG', 'AJ', NULL), ('9100020', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100021', 'R', 'E', 'EFG', 'AJ', NULL), ('9100022', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100023', 'R', 'E', 'EFG', 'AJ', NULL), ('9100024', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100025', 'R', 'E', 'EFG', 'AJ', NULL), ('9100026', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100027', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100028', 'R', 'E', 'EFG', 'AJ', NULL), ('9100029', 'R', 'E', 'EFG', 'AJ', NULL),
  ('9100030', 'R', 'E', 'EFG', 'AJ', NULL), ('9100031', 'R', 'E', 'EFG', 'AJ', NULL), ('9100032', 'R', 'E', 'EFG', 'AJ', NULL),
  -- 4 huérfanos hospitalarios más (2ª tanda) — sin BP_CONJARTI, candidatos a GH único.
  ('9600001', 'R', 'E', NULL, 'TLD', NULL),
  ('9600002', 'R', 'E', NULL, 'TLD', NULL),
  ('9600003', 'R', 'E', NULL, 'TLD', NULL),
  ('9600004', 'R', 'E', NULL, 'TLD', NULL);
GO

PRINT 'Inicialización completada: Farmatic + Consejo con datos de prueba';
GO
