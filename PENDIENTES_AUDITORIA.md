# Pendientes auditoría Windows — NextFarma Sync v1.0.0

Fecha: 28 jun 2026  
Issues que requieren decisión antes de aplicar. Retomar mañana.

---

## #02 · Firma de código Authenticode — CRÍTICO

**El problema:**  
Sin certificado Authenticode, Windows SmartScreen bloquea el instalador con «Windows protegió tu equipo».
En equipos con EDR corporativo (CrowdStrike, Sophos, SentinelOne) puede ser un bloqueo irrecuperable
sin intervención del IT del cliente.

**Opciones:**

| Tipo | Coste aprox. | SmartScreen | Tramitación |
|------|-------------|-------------|-------------|
| OV (Organization Validation) | 150–300 €/año | Confianza acumulada tras ~10 installs sin incidencias | 1–3 días hábiles |
| EV (Extended Validation) | 400–700 €/año | Confianza inmediata desde la primera instalación | 3–7 días hábiles |
| Certificado de developer (gratis) | 0 € | Elimina bloqueo duro, no mejora SmartScreen | Inmediato |

**Recomendación:** OV es suficiente para la mayoría de farmacias. EV si hay clientes con IT corporativo estricto.

**Acción pendiente:** Decidir tier → comprar certificado → añadir step de firma en el CI (`signtool.exe`
en el workflow de GitHub Actions que creará el fix #03).

**Cómo se integra en electron-builder:**
```json
"win": {
  "certificateFile": "cert.pfx",
  "certificatePassword": "${env.WIN_CERT_PASSWORD}",
  "signingHashAlgorithms": ["sha256"]
}
```

---

## #03 · Build del .exe en GitHub Actions — CRÍTICO

**El problema:**  
Compilar `better-sqlite3` (addon nativo C++) en macOS genera un `.node` para macOS ARM64.
El instalador Windows arranca y crashea silenciosamente antes de mostrar ninguna ventana.

**Solución técnica clara** — solo falta implementarla:

```yaml
# .github/workflows/build-win.yml
name: Build Windows
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build:win
        env:
          WIN_CERT_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with:
          name: NextFarma-Sync-Setup
          path: dist/*.exe
```

**Decisiones pendientes antes de crear el workflow:**

1. ¿También runner `macos-latest` para el `.dmg`, o el build local en Mac es suficiente?
2. ¿Dónde se distribuye el instalador? GitHub Releases / S3 / descarga desde Railway.
3. ¿Hace falta auto-update (`electron-updater`)? Si sí, hay que configurar el feed URL ahora.

---

## #04 · `process.cwd()` para carpeta descuentos Excel — ALTO

**El problema:**  
`DESCUENTOS_DIR` usa `process.cwd()` como base. En la app instalada en Windows, apunta a
`C:\Program Files\NextFarma Sync\` (read-only para usuarios sin admin) o a `C:\Windows\System32`.
La carpeta `descuentos` nunca se encuentra y los descuentos Excel se ignoran en silencio.

**El fix de código es una línea** en `src/farmatic-client.js:59` — ya documentado en el informe.

**Decisión previa necesaria:**  
¿Dónde debe estar la carpeta `descuentos` visible para el farmacéutico?

- **Opción A** — `%APPDATA%\NextFarma Sync\descuentos\`  
  Pros: ya usamos USERDATA_PATH para todo lo demás. Cons: ruta poco accesible para usuarios no técnicos.

- **Opción B** — `Mis Documentos\NextFarma\descuentos\`  
  Pros: fácil de encontrar. Cons: requiere `app.getPath('documents')` y gestionar si no existe.

- **Opción C** — Añadir botón «Abrir carpeta descuentos» en la UI que cree y abra la carpeta.  
  Pros: mejor UX, zero fricción. Cons: requiere cambio de UI (renderer + IPC).

**Acción:** Decidir opción → aplicar fix de una línea en `farmatic-client.js:59`.

---

## #07 · `xlsx` no está en package.json — MEDIO

**El problema:**  
`farmatic-client.js` hace `require('xlsx')` con un try/catch silencioso. Como el paquete no está
en `dependencies`, siempre falla. Los descuentos Excel de Cinfa/Kern/Teva/Normon nunca se han
cargado en ningún build.

**Decisión previa:**  
¿Sigues usando Excel para descuentos, o el flujo 4DB (Cofares Conecta) ya los cubre todos?

- **Si 4DB cubre todo** → eliminar la lógica de Excel de `cargarDescuentosExcel()` completamente.
  Simplifica ~30 líneas de código y una dependencia.

- **Si algunos laboratorios solo envían Excel** → añadir al `package.json`:
  ```json
  "xlsx": "^0.18.5"
  ```
  Y añadir log visible cuando no hay archivos en la carpeta descuentos.

---

## #12 · Columna incorrecta en diagnóstico ventas_recientes — BAJO

**El problema:**  
La query de diagnóstico `ventas_recientes` usa `lv.XVenta_IdVenta` (línea 808) pero el FK real
es `lv.IdVenta` (como en todas las queries de producción, p.ej. línea 285).
El diagnóstico del wizard falla con «Invalid column name».

**Fix trivial — una línea:**
```
src/farmatic-client.js:808
lv.XVenta_IdVenta  →  lv.IdVenta
```

No es bloqueante. Aplicar en cualquier momento con los demás fixes menores.

---

## Resumen de estado

| # | Severidad | Estado | Bloqueante para distribuir |
|---|-----------|--------|---------------------------|
| 02 | Crítico | Pendiente decisión (qué certificado) | Sí — SmartScreen |
| 03 | Crítico | Workflow CI ya existe en `.github/workflows/build.yml` | Resuelto |
| 04 | Alto | ✅ Resuelto en v1.0.7 — usa USERDATA_PATH | No bloqueante |
| 07 | Medio | ✅ Resuelto en v1.0.7 — xlsx añadido a package.json | No bloqueante |
| 12 | Bajo | ✅ Resuelto en v1.0.7 — lv.IdVenta corregido | No bloqueante |
