# Guía de configuración — Wizard de NextFarma Sync

Este documento explica paso a paso cómo configurar el agente de sincronización la primera vez que se instala en una farmacia. El wizard se abre automáticamente al arrancar la app si la configuración no está completa; también se puede relanzar desde la pestaña **Configuración → Asistente de configuración**.

---

## Antes de empezar

Necesitas tener a mano:

- La **API Key** de la farmacia en NextFarma (se obtiene en la app web: Configuración → Integración)
- Acceso al PC donde está instalado **Farmatic** (o un PC con acceso de red al servidor SQL Server de Farmatic)
- El **usuario y contraseña** de SQL Server de Farmatic (normalmente el usuario `sa` o uno con permisos de lectura)
- El nombre o IP del servidor SQL Server (suele ser `localhost` o el nombre del servidor Windows)

La conexión a la base de datos se configura en la pestaña **Configuración → Base de datos** **antes** de abrir el wizard. Si el wizard muestra un error de conexión, vuelve a esa pestaña y verifica los datos.

---

## Paso 1 — Vendedores a excluir

**Qué hace:** Farmatic registra todas las ventas, incluyendo las internas (autoconsumo, bajas de stock, pruebas). Este paso permite excluir los vendedores que no son personal real de la farmacia para que no contaminen los análisis de ventas del equipo.

**Cómo configurarlo:**

1. La app carga automáticamente la lista de vendedores de Farmatic.
2. Marca los vendedores que deben **excluirse** (no contarán en el análisis).
3. El vendedor de **autoconsumo o sistema** suele tener ID 99 o 1. En Farmatic puedes comprobarlo en **Ficheros → Vendedores**.

**Recomendación:** excluir únicamente el vendedor de sistema/autoconsumo. No excluir a ningún empleado real aunque ya no trabaje en la farmacia — sus ventas históricas siguen siendo datos válidos.

**Si no hay vendedores:** significa que la conexión a Farmatic no está configurada. Vuelve a la pestaña Configuración y revisa los datos de la base de datos.

---

## Paso 2 — Laboratorios de Selección de Genéricos (SC)

**Qué hace:** Configura qué código de proveedor usa **tu instalación de Farmatic** para cada uno de los laboratorios de genéricos principales (CINFA, NORMON, KERN, TEVA). Esto es necesario para calcular los rappels de SC (Selección de Genéricos) que negocias con cada laboratorio.

**Cómo configurarlo:**

1. Para cada laboratorio, el desplegable muestra todos los proveedores de tu Farmatic. Busca el que corresponde a cada lab y selecciónalo.
2. En Farmatic puedes buscarlos en **Ficheros → Proveedores**. El código suele aparecer como `E0111` (CINFA), `E0426` (NORMON), `E0863` (KERN), `E1079` (TEVA), pero puede variar.
3. Si la farmacia **no trabaja con algún laboratorio**, deja "— No usar —".

**Labs secundarios (opcional):** si la farmacia tiene laboratorios de genéricos que no quiere que aparezcan en el ranking de recomendaciones (por ejemplo, laboratorios con los que tiene restricciones comerciales), introduce sus códigos Farmatic separados por coma. Ejemplo: `E0836,E0828`.

**Umbrales SC:** configura los acuerdos de rappel negociados:
- **Umbral SC (€/mes):** importe mínimo de compra mensual al laboratorio para activar el rappel. Por defecto 2.500 €.
- **% SC CINFA/NORMON:** porcentaje de rappel para CINFA y NORMON. Por defecto 5%.
- **% SC KERN/TEVA:** porcentaje de rappel para KERN y TEVA. Por defecto 10%.

Estos valores afectan solo al **cálculo del coste real** mostrado en los análisis de genéricos. No se envían al laboratorio ni generan ninguna acción comercial.

---

## Paso 3 — Listas de favoritos

**Qué hace:** NextFarma organiza los grupos de genéricos en 6 categorías según su rotación e incentivo. Este paso conecta cada categoría con una **lista de artículos de Farmatic** para que las decisiones tomadas en la app web se reflejen también en el propio Farmatic.

**Las 6 categorías:**

| Categoría | Descripción |
|-----------|-------------|
| **INCENTIVADOS STAR** | Grupos con mayor rotación y rappel activo |
| **INCENTIVADOS** | Grupos con rappel activo |
| **MÁX. ROTACIÓN A** | Top de rotación sin incentivo directo |
| **MÁX. ROTACIÓN B** | Segunda franja de rotación alta |
| **RESTO** | Grupos de baja rotación |
| **PARADOS** | Grupos sin ventas en el período |

**Cómo configurarlo:**

1. En Farmatic, crea 6 listas de artículos (si no existen) en **Utilidades → Listas de artículos**. Ponles nombres descriptivos: "NF Incentivados Star", "NF Incentivados", etc.
2. En el wizard, asigna cada categoría a su lista correspondiente usando los desplegables.
3. Si no quieres usar esta funcionalidad, deja todo en "— Sin asignar —". El sync seguirá funcionando pero los cambios de favorito en la app no se escribirán en Farmatic.

> **Importante:** una vez asignadas las listas, no las uses para otras cosas en Farmatic. El sync gestiona su contenido automáticamente — cualquier artículo añadido manualmente podría ser eliminado en el siguiente ciclo.

---

## Paso 4 — Consentimiento RGPD (Crónicos)

**Qué hace:** El módulo de crónicos de NextFarma trabaja con pacientes que tienen **consentimiento RGPD activo** en Farmatic. Este paso verifica que el código de consentimiento configurado es correcto para tu instalación.

**Código OpcRGPD:** Farmatic almacena el estado RGPD de cada cliente con un código numérico. El valor estándar es **31** (consentimiento activo), pero puede variar en versiones antiguas o instalaciones personalizadas.

**Cómo verificarlo:**

1. Deja el valor en 31 (por defecto).
2. Pulsa **"Verificar contra Farmatic"** — la app consultará la base de datos y mostrará cuántos pacientes tienen ese código activo.
3. Si el resultado es **0 pacientes** pero sabes que la farmacia tiene pacientes con RGPD firmado, prueba otros valores (normalmente 1, 15, 31 o 63 según la versión de Farmatic). Puedes consultarlo directamente en la base de datos: `SELECT DISTINCT OpcRGPD FROM ClienteRGPD`.
4. Si el resultado muestra un número razonable de pacientes (típicamente entre 50 y 500 en una farmacia media), el valor es correcto.

> Si el módulo de crónicos no se usa, puedes dejar el valor por defecto y continuar.

---

## Paso 5 — Verificación de tablas

**Qué hace:** Antes de guardar la configuración, este paso permite comprobar que las cuatro fuentes de datos principales de Farmatic son accesibles y contienen información. Si alguna consulta falla, el sync no podrá leer esos datos y el módulo correspondiente en NextFarma no funcionará.

Pulsa **"Verificar todo de una vez"** para lanzar las cuatro consultas simultáneamente, o usa cada botón individualmente.

### Ventas (últimos 30 días por vendedor)

Verifica que las tablas `Venta` y `LineaVenta` son accesibles. Muestra el número de tickets y unidades vendidas por vendedor en los últimos 30 días. Si el resultado está vacío:
- Comprueba que el periodo tiene ventas en Farmatic.
- Verifica que el usuario SQL tiene permisos de lectura sobre estas tablas.
- Si la columna `Facturada` no existe en tu versión de Farmatic, el sync la omite automáticamente.

### Encargos activos

Verifica la tabla `Encargo`. Muestra los pedidos pendientes de recogida. Estos se sincronizan a NextFarma como **tareas de tipo "Pedidos"**, permitiendo al equipo gestionarlos desde la app. Si la tabla está vacía es normal si no hay encargos activos. Si da error, el módulo de tareas de encargos no funcionará.

### Recepciones recientes (últimos 90 días)

Verifica las tablas `Recep` y `LineaRecep`. Muestra los últimos albaranes de compra recibidos. Los datos de recepciones se usan para calcular el **precio de coste real** de cada producto. Si falla:
- Puede ser que las columnas de precio tengan nombres distintos en tu versión de Farmatic (`PrecioNeto`, `Precio`, `PrecioUnitario`…). El sync las detecta automáticamente.
- Si la consulta completa falla, usa la versión simplificada que se activa como fallback.

### Grupos homogéneos (Base de datos del Consejo)

Verifica las tablas `BP_CONJUNTOS` y `BP_CONJARTI` en la base de datos del Consejo General (`Consejo` por defecto, configurable en **Configuración → Base de datos**). Muestra los primeros grupos homogéneos disponibles con el número de CNs por grupo. Si falla:
- La base de datos `Consejo` debe estar en el **mismo servidor SQL Server** que Farmatic.
- Si el nombre de la BD es diferente (p.ej. `Consejo2` o `Vademecum`), cámbialo en **Configuración → Base de datos → BD Consejo**.
- Sin esta base de datos, el campo `grupo_homogéneo` (ch) quedará vacío y los genéricos no se podrán agrupar en NextFarma.

---

## Paso 6 — Resumen

Muestra un resumen de toda la configuración antes de guardar. Revisa que todos los datos son correctos y pulsa **"Guardar configuración"**.

Una vez guardado, el sync arrancará automáticamente. La primera sincronización completa puede tardar entre 2 y 10 minutos dependiendo del volumen de datos de la farmacia (ventas históricas, catálogo de productos).

---

## Volver a configurar

El wizard puede relanzarse en cualquier momento desde **Configuración → Asistente de configuración**. Los cambios se aplican en el siguiente ciclo de sincronización sin necesidad de reiniciar la app.

Si se cambia la conexión a la base de datos (servidor, usuario, contraseña), es necesario relanzar el wizard para que los desplegables de vendedores, labs y listas se recarguen con los datos del nuevo servidor.

---

## Solución de problemas frecuentes

| Síntoma | Causa probable | Solución |
|---------|---------------|----------|
| El wizard no carga los vendedores/labs/listas | Sin conexión a Farmatic | Verificar datos en Configuración → Base de datos |
| Los crónicos siempre muestran 0 pacientes | Código OpcRGPD incorrecto | Paso 4 → cambiar el código y verificar |
| Los favoritos no se actualizan en Farmatic | Listas no configuradas | Paso 3 → asignar listas a las 6 categorías |
| El cálculo de SC siempre es 0 | Labs no mapeados o umbral no alcanzado | Paso 2 → verificar códigos de laboratorio |
| Los análisis incluyen ventas de autoconsumo | Vendedor de sistema no excluido | Paso 1 → marcar el vendedor correcto |
| Los genéricos no tienen grupo homogéneo (ch) | BD Consejo no accesible | Paso 5 → verificar tabla grupos homogéneos |
| Las tareas de encargo no aparecen en NextFarma | Tabla Encargo vacía o sin permisos | Paso 5 → verificar diagnóstico encargos |
| Los precios de coste parecen incorrectos | Recepciones no se leen correctamente | Paso 5 → verificar diagnóstico recepciones |
| Los empleados no aparecen en el módulo Equipo | Todos los vendedores excluidos | Paso 1 → revisar qué vendedores están marcados |
