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
  -- Módulo Receta, Fase 3 (4.3) — hospitalario de dispensación ambulatoria, GENUINAMENTE
  -- huérfano: no aparece en BP_CONJARTI/BP_CONJUNTOS más abajo, ni tiene fila en GeneArti.
  -- Con DISPENSACION='R' en ESPEPARA + venta real reciente, debe entrar al universo de
  -- Receta como GH único (ch sintético negativo) — sin este caso no se prueba la Fase 3.
  ('1500001', N'ADALIMUMAB 40MG JERINGA PRECARGADA 2 UDS', 'E0863', 285.40, 245.60, 245.60, '4', 0, 1, 0, 0, 3, 1, 2),
  -- Segundo huérfano genuino — mismo caso que 1500001 pero patrón "sobrestock" distinto,
  -- para no depender de un único ejemplo de GH único al probar Fase 3.
  ('1500002', N'RIVASTIGMINA 4,6MG/24H 30 PARCHES TRANSDERMICOS', 'E0863', 95.20, 82.10, 82.10, '4', 0, 1, 0, 0, 22, 6, 12),
  -- 4 GH nuevos, cada uno con 2-3 laboratorios — para tener sustitución real que enseñar en
  -- Genéricos (no solo GH único de Receta). PVPMENOR de cada CODConjunto (ver BP_CONJUNTOS
  -- más abajo) se fija al Pvp más alto del grupo, para no repetir el filtro pvpSuperior que
  -- descartó 1000001/1000002/1000004/1000008.
  ('3000001', N'SIMVASTATINA CINFA 20MG 28 COMP EFG',   'E0111', 3.20, 1.73, 1.64, '4', 0, 1, 0, 0, 24, 13, 20),
  ('3000002', N'SIMVASTATINA NORMON 20MG 28 COMP EFG',  'E0426', 3.15, 1.70, 1.61, '4', 0, 1, 0, 0, 18, 13, 20),
  ('3000003', N'SIMVASTATINA KERN 20MG 28 COMP EFG',    'E0863', 3.25, 1.75, 1.66, '4', 0, 1, 0, 0, 12, 13, 20),
  ('3000004', N'LOSARTAN CINFA 50MG 28 COMP EFG',       'E0111', 4.10, 2.21, 2.10, '4', 0, 1, 0, 0, 16, 13, 20),
  ('3000005', N'LOSARTAN TEVA 50MG 28 COMP EFG',        'E1079', 4.05, 2.18, 2.07, '4', 0, 1, 0, 0, 10, 13, 20),
  ('3000006', N'ENALAPRIL NORMON 20MG 30 COMP EFG',     'E0426', 2.95, 1.59, 1.51, '4', 0, 1, 0, 0,  4, 15, 25),
  ('3000007', N'ENALAPRIL KERN 20MG 30 COMP EFG',       'E0863', 3.00, 1.62, 1.54, '4', 0, 1, 0, 0, 20, 15, 25),
  ('3000008', N'AMLODIPINO CINFA 10MG 30 COMP EFG',     'E0111', 1.85, 1.00, 0.94, '4', 0, 1, 0, 0, 30, 15, 25),
  ('3000009', N'AMLODIPINO NORMON 10MG 30 COMP EFG',    'E0426', 1.80, 0.97, 0.92, '4', 0, 1, 0, 0, 22, 15, 25),
  ('3000010', N'AMLODIPINO TEVA 10MG 30 COMP EFG',      'E1079', 1.90, 1.02, 0.97, '4', 0, 1, 0, 0, 14, 15, 25);
GO

INSERT INTO GeneArti (IdArticu, IdGrupoGen, EFG) VALUES
  ('1000001', 101, 1),
  ('1000002', 102, 1),
  ('1000003', 103, 1),
  ('1000004', 104, 1),
  ('1000005', 101, 1),
  ('1000007', 105, 1),
  ('1000008', 106, 1),
  ('3000001', 107, 1),
  ('3000002', 107, 1),
  ('3000003', 107, 1),
  ('3000004', 108, 1),
  ('3000005', 108, 1),
  ('3000006', 109, 1),
  ('3000007', 109, 1),
  ('3000008', 110, 1),
  ('3000009', 110, 1),
  ('3000010', 110, 1);
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

-- Módulo Receta — ventas de los últimos 3 meses completos (mayo/junio/julio) para 1000006
-- (huérfano ya existente sin CODConjunto, ver comentario más arriba) y 1500001 (huérfano
-- nuevo, hospitalario sin BP_CONJARTI) — ambos necesitan venta RECIENTE de verdad para
-- pasar el filtro de relevancia de Fase 2 y tener una propuesta de stock (Fase 5) distinta
-- de "encargo puro" (vel_mes=0). IdVenta 25-30 (tras las 24 anteriores).
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2026, 5, '2026-05-14 10:15', 2, 1002, 'C',   2.28, 1),
  (2026, 6, '2026-06-12 09:45', 1, 1001, 'C',   2.28, 1),
  (2026, 7, '2026-07-08 11:20', 3, 1003, 'C',   2.28, 1),
  (2026, 5, '2026-05-22 12:00', 1, 1001, 'C', 285.40, 1),
  (2026, 6, '2026-06-18 10:30', 2, 1004, 'C', 285.40, 1),
  (2026, 7, '2026-07-15 09:00', 1, 1002, 'C', 285.40, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (25, '1000006', 1,   2.28,   2.28),
  (26, '1000006', 1,   2.28,   2.28),
  (27, '1000006', 1,   2.28,   2.28),
  (28, '1500001', 1, 285.40, 285.40),
  (29, '1500001', 1, 285.40, 285.40),
  (30, '1500001', 1, 285.40, 285.40);
GO

-- Ventas mensuales (mayo/junio/julio 2026) para los 4 GH nuevos multi-laboratorio y para
-- 1500002 — cada laboratorio con un volumen distinto dentro de su grupo, para que la
-- sustitución/favorito/color de Genéricos tengan sentido (no todo a cero ni empatado).
-- IdVenta 31-33 (una "cesta" por mes, tras las 30 anteriores).
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, XClie_IdCliente, TipoVenta, TotalVenta, Facturada) VALUES
  (2026, 5, '2026-05-12 10:00', 1, 1001, 'C', 193.25, 1),
  (2026, 6, '2026-06-14 11:00', 2, 1002, 'C', 193.25, 1),
  (2026, 7, '2026-07-10 09:30', 3, 1003, 'C', 193.25, 1);
GO

INSERT INTO LineaVenta (IdVenta, Codigo, Cantidad, ImporteNeto, PVP) VALUES
  (31, '3000001', 4, 12.80, 3.20), (31, '3000002', 2,  6.30, 3.15), (31, '3000003', 1,  3.25, 3.25),
  (31, '3000004', 5, 20.50, 4.10), (31, '3000005', 2,  8.10, 4.05),
  (31, '3000006', 3,  8.85, 2.95), (31, '3000007', 6, 18.00, 3.00),
  (31, '3000008', 7, 12.95, 1.85), (31, '3000009', 3,  5.40, 1.80), (31, '3000010', 1,  1.90, 1.90),
  (31, '1500002', 1, 95.20, 95.20),
  (32, '3000001', 4, 12.80, 3.20), (32, '3000002', 2,  6.30, 3.15), (32, '3000003', 1,  3.25, 3.25),
  (32, '3000004', 5, 20.50, 4.10), (32, '3000005', 2,  8.10, 4.05),
  (32, '3000006', 3,  8.85, 2.95), (32, '3000007', 6, 18.00, 3.00),
  (32, '3000008', 7, 12.95, 1.85), (32, '3000009', 3,  5.40, 1.80), (32, '3000010', 1,  1.90, 1.90),
  (32, '1500002', 1, 95.20, 95.20),
  (33, '3000001', 4, 12.80, 3.20), (33, '3000002', 2,  6.30, 3.15), (33, '3000003', 1,  3.25, 3.25),
  (33, '3000004', 5, 20.50, 4.10), (33, '3000005', 2,  8.10, 4.05),
  (33, '3000006', 3,  8.85, 2.95), (33, '3000007', 6, 18.00, 3.00),
  (33, '3000008', 7, 12.95, 1.85), (33, '3000009', 3,  5.40, 1.80), (33, '3000010', 1,  1.90, 1.90),
  (33, '1500002', 1, 95.20, 95.20);
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
  -- 4 GH nuevos — descuentos distintos por laboratorio dentro de cada grupo, para que el
  -- ranking verde/amarillo/gris de Genéricos tenga sentido (no todos empatados).
  (3000001, 1.73, 1, 'S'),
  (3000002, 1.70, 1, 'S'),
  (3000003, 1.75, 1, 'S'),
  (3000004, 2.21, 1, 'S'),
  (3000005, 2.18, 1, 'S'),
  (3000006, 1.59, 1, 'S'),
  (3000007, 1.62, 1, 'S'),
  (3000008, 1.00, 1, 'S'),
  (3000009, 0.97, 1, 'S'),
  (3000010, 1.02, 1, 'S');
GO

INSERT INTO _4DB_CAT_Models (codigonacional, discount, nombre, catalogo) VALUES
  (1000001, 5.00, 'COFARES DIRECTO', 1),
  (1000002, 5.00, 'COFARES DIRECTO', 1),
  (1000003, 4.00, 'NEXO',            1),
  (1000004, 5.00, 'COFARES DIRECTO', 1),
  (1000005, 3.00, 'NEXO',            1),
  (3000001, 5.00, 'COFARES DIRECTO', 1),
  (3000002, 4.00, 'NEXO',            1),
  (3000003, 3.00, 'NEXO',            1),
  (3000004, 5.00, 'COFARES DIRECTO', 1),
  (3000005, 3.00, 'NEXO',            1),
  (3000006, 4.00, 'NEXO',            1),
  (3000007, 5.00, 'COFARES DIRECTO', 1),
  (3000008, 5.00, 'COFARES DIRECTO', 1),
  (3000009, 4.00, 'NEXO',            1),
  (3000010, 3.00, 'NEXO',            1),
  (1000006, 4.00, 'COFARES DIRECTO', 1),
  (1000007, 3.00, 'NEXO',            1),
  (1000008, 5.00, 'COFARES DIRECTO', 1);
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
INSERT INTO BP_CONJUNTOS (CODCONJUNTO, CODCCAA, NOMBRE, PVPMENOR, TIPO) VALUES
  (101, 0, N'IBUPROFENO 600MG EFG',    5.58, 'EFG'),
  (102, 0, N'PARACETAMOL 1G EFG',      2.82, 'EFG'),
  (103, 0, N'AMOXICILINA 500MG EFG',   3.49, 'EFG'),
  (104, 0, N'OMEPRAZOL 20MG EFG',      1.62, 'EFG'),
  (105, 0, N'METFORMINA 850MG EFG',    2.12, 'EFG'),
  (106, 0, N'ATORVASTATINA 20MG EFG',  1.94, 'EFG'),
  (107, 0, N'SIMVASTATINA 20MG EFG',   3.25, 'EFG'),
  (108, 0, N'LOSARTAN 50MG EFG',       4.10, 'EFG'),
  (109, 0, N'ENALAPRIL 20MG EFG',      3.00, 'EFG'),
  (110, 0, N'AMLODIPINO 10MG EFG',     1.90, 'EFG');
GO

INSERT INTO BP_CONJARTI (CODIGO, CODConjunto, CODCCAA) VALUES
  ('1000001', 101, 0),
  ('1000005', 101, 0),
  ('1000002', 102, 0),
  ('1000003', 103, 0),
  ('1000004', 104, 0),
  ('1000007', 105, 0),
  ('1000008', 106, 0),
  ('3000001', 107, 0),
  ('3000002', 107, 0),
  ('3000003', 107, 0),
  ('3000004', 108, 0),
  ('3000005', 108, 0),
  ('3000006', 109, 0),
  ('3000007', 109, 0),
  ('3000008', 110, 0),
  ('3000009', 110, 0),
  ('3000010', 110, 0);
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
  ('1500001', 'R', 'E', NULL, 'TLD', NULL),
  ('1500002', 'R', 'E', NULL, 'TLD', NULL),
  -- 4 GH nuevos multi-laboratorio (sustitución real para Genéricos, no solo GH único).
  ('3000001', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000002', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000003', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000004', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000005', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000006', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000007', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000008', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000009', 'R', 'E', 'EFG', 'AJ', NULL),
  ('3000010', 'R', 'E', 'EFG', 'AJ', NULL);
GO

PRINT 'Inicialización completada: Farmatic + Consejo con datos de prueba';
GO
