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
  IdArticu    VARCHAR(20)   NOT NULL PRIMARY KEY,
  Descripcion VARCHAR(200),
  Laboratorio VARCHAR(50),
  Pvp         DECIMAL(10,4),
  Pvl         DECIMAL(10,4),
  Puc         DECIMAL(10,4),
  IVA         VARCHAR(10),
  Efp         BIT           DEFAULT 0,
  Receta      BIT           DEFAULT 0,
  ExcluidoSS  BIT           DEFAULT 0,
  Baja        BIT           DEFAULT 0
);
GO

CREATE TABLE GeneArti (
  IdArticu   VARCHAR(20),
  IdGrupoGen INT,
  EFG        BIT DEFAULT 0
);
GO

CREATE TABLE Venta (
  IdVenta          INT      IDENTITY(1,1) PRIMARY KEY,
  Ejercicio        SMALLINT,
  Mes              TINYINT,
  FechaHora        DATETIME,
  XVend_IdVendedor INT,
  TipoVenta        CHAR(1),
  Facturada        BIT      DEFAULT 1
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

CREATE TABLE ListaArticu (
  IdLista INT PRIMARY KEY,
  Nombre  VARCHAR(100)
);
GO

CREATE TABLE ItemListaArticu (
  XItem_IdLista  INT,
  XItem_IdArticu INT
);
GO

CREATE TABLE ClienteRGPD (
  IdCliente INT IDENTITY(1,1) PRIMARY KEY,
  OpcRGPD   INT
);
GO

CREATE TABLE Encargo (
  IdEncargo      INT IDENTITY(1,1) PRIMARY KEY,
  Codigo         VARCHAR(20),
  Cantidad       DECIMAL(10,3),
  FechaRecepcion DATE
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
INSERT INTO Articu (IdArticu, Descripcion, Laboratorio, Pvp, Pvl, Puc, IVA, Efp, Receta, ExcluidoSS, Baja) VALUES
  ('1000001', N'IBUPROFENO 600MG 40 COMP EFG',     'E0111',  5.58, 3.01, 2.87, '4', 0, 1, 0, 0),
  ('1000002', N'PARACETAMOL 1G 10 COMP EFG',        'E0426',  2.82, 1.52, 1.45, '4', 0, 0, 0, 0),
  ('1000003', N'AMOXICILINA 500MG 24 CAPS EFG',     'E0863',  3.49, 1.88, 1.78, '4', 0, 1, 0, 0),
  ('1000004', N'OMEPRAZOL 20MG 28 CAPS EFG',        'E0111',  1.62, 0.87, 0.82, '4', 0, 1, 0, 0),
  ('1000005', N'IBUPROFENO 400MG 40 COMP EFG',      'E1079',  4.70, 2.53, 2.40, '4', 0, 0, 0, 0),
  ('1000006', N'LORAZEPAM 1MG 50 COMP',             'E0426',  2.28, 1.23, 1.15, '4', 0, 1, 0, 0),
  ('1000007', N'METFORMINA 850MG 50 COMP EFG',      'E0863',  2.12, 1.14, 1.05, '4', 0, 1, 0, 0),
  ('1000008', N'ATORVASTATINA 20MG 28 COMP EFG',    'E0111',  1.94, 1.04, 0.98, '4', 0, 1, 0, 0),
  ('2000001', N'CREMA HIDRATANTE 200ML',             'NEUTRO', 8.95, NULL, NULL, '21',1, 0, 1, 0),
  ('2000002', N'GEL ANTISÉPTICO 500ML',              'NEUTRO', 4.50, NULL, NULL, '21',1, 0, 1, 0);
GO

INSERT INTO GeneArti (IdArticu, IdGrupoGen, EFG) VALUES
  ('1000001', 101, 1),
  ('1000002', 102, 1),
  ('1000003', 103, 1),
  ('1000004', 104, 1),
  ('1000005', 101, 1),
  ('1000007', 105, 1),
  ('1000008', 106, 1);
GO

-- Ventas 2024 (enero–diciembre)
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, TipoVenta, Facturada) VALUES
  (2024,  1, '2024-01-15 09:00', 1, 'C', 1),
  (2024,  1, '2024-01-20 11:30', 2, 'C', 1),
  (2024,  2, '2024-02-10 10:00', 1, 'C', 1),
  (2024,  3, '2024-03-12 11:00', 2, 'C', 1),
  (2024,  4, '2024-04-18 09:30', 3, 'C', 1),
  (2024,  5, '2024-05-22 14:00', 1, 'C', 1),
  (2024,  6, '2024-06-05 10:30', 2, 'C', 1),
  (2024,  7, '2024-07-08 10:00', 3, 'C', 1),
  (2024,  8, '2024-08-14 11:00', 1, 'C', 1),
  (2024,  9, '2024-09-19 09:00', 2, 'C', 1),
  (2024, 10, '2024-10-25 10:00', 1, 'C', 1),
  (2024, 11, '2024-11-08 14:30', 3, 'C', 1),
  (2024, 12, '2024-12-20 10:00', 2, 'C', 1);
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
INSERT INTO Venta (Ejercicio, Mes, FechaHora, XVend_IdVendedor, TipoVenta, Facturada) VALUES
  (2025, 1, '2025-01-10 09:00', 1, 'C', 1),
  (2025, 2, '2025-02-14 10:00', 2, 'C', 1),
  (2025, 3, '2025-03-20 11:00', 1, 'C', 1),
  (2025, 4, '2025-04-15 09:30', 3, 'C', 1),
  (2025, 5, '2025-05-22 14:00', 2, 'C', 1),
  (2025, 6, '2025-06-10 10:30', 1, 'C', 1);
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

-- Recepciones (últimos 2 meses)
INSERT INTO Recep (FechaRecep, XProv_IdProveedor) VALUES
  ('2025-05-10', 'E0111'),
  ('2025-05-20', 'E0426'),
  ('2025-06-01', 'E0863'),
  ('2025-06-15', 'E1079');
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

-- Listas de artículos
INSERT INTO ListaArticu (IdLista, Nombre) VALUES
  (1, N'INCENTIVADOS STAR'),
  (2, N'INCENTIVADOS'),
  (3, N'MÁXIMA ROTACIÓN A'),
  (4, N'MÁXIMA ROTACIÓN B'),
  (5, N'RESTO'),
  (6, N'PARADOS');
GO

INSERT INTO ItemListaArticu (XItem_IdLista, XItem_IdArticu) VALUES
  (1, 1000001),
  (2, 1000002),
  (3, 1000003),
  (4, 1000004),
  (5, 1000005),
  (6, 1000007);
GO

-- Clientes RGPD
INSERT INTO ClienteRGPD (OpcRGPD) VALUES
  (1),(1),(1),(1),(2),(2),(2),(3),(3),(1);
GO

-- Encargos activos
INSERT INTO Encargo (Codigo, Cantidad, FechaRecepcion) VALUES
  ('1000001', 5, '2025-07-05'),
  ('1000003', 2, '2025-07-08');
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

INSERT INTO BP_CONJUNTOS (CODCONJUNTO, CODCCAA, NOMBRE, PVPMENOR, TIPO) VALUES
  (101, 0, N'IBUPROFENO 600MG EFG',    4.70, 'EFG'),
  (102, 0, N'PARACETAMOL 1G EFG',      2.28, 'EFG'),
  (103, 0, N'AMOXICILINA 500MG EFG',   3.49, 'EFG'),
  (104, 0, N'OMEPRAZOL 20MG EFG',      1.36, 'EFG'),
  (105, 0, N'METFORMINA 850MG EFG',    2.12, 'EFG'),
  (106, 0, N'ATORVASTATINA 20MG EFG',  1.62, 'EFG');
GO

INSERT INTO BP_CONJARTI (CODIGO, CODConjunto, CODCCAA) VALUES
  ('1000001', 101, 0),
  ('1000005', 101, 0),
  ('1000002', 102, 0),
  ('1000003', 103, 0),
  ('1000004', 104, 0),
  ('1000007', 105, 0),
  ('1000008', 106, 0);
GO

PRINT 'Inicialización completada: Farmatic + Consejo con datos de prueba';
GO
