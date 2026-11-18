# Tareas — Spec 001

Leyenda: `[x]` hecha · `[ ]` pendiente · (RF/RNF) que cubre.

## Fase 1 — Código (hecho)
- [x] T01 Servidor Express con las funciones de `Code.gs` como RPC (RF-03, RF-04)
- [x] T02 Shim `gas-shim.js` para `google.script.run` / `google.script.url` (RF-02, RF-08)
- [x] T03 Inyección del shim en `index.html` sin modificar el HTML original (RF-02)
- [x] T04 Credenciales de PBCS desde `APP_SECRETS` (RNF-01)
- [x] T05 Login con Google vía proxy de Ownia, solo `@despegar.com` (RF-01, RNF-03)
- [x] T06 Redirección a login al vencer la sesión (RF-09)
- [x] T07 `getUserInfo` y validación de admin en el servidor (RF-05, RF-06, RNF-04)
- [x] T08 Medidas y log de Refresh en DynamoDB (RF-06, RF-07)
- [x] T09 Soporte de `BASE_PATH` y redirect a URL con `/` final (RNF-05)
- [x] T10 Copia de referencia de `Code.gs` sin credenciales en `legacy/apps-script/`

## Fase 2 — Alta en Ownia (manual, owner)
- [ ] T11 Mover/crear el repo en la organización `despegar` de GitHub
- [ ] T12 Levantar el ticket y crear la app en Ownia con **DynamoDB**, conectada a este repo
- [ ] T13 Cargar `PBCS_USER` y `PBCS_PASSWORD` en los secretos de la app (y `ADMIN_EMAILS` si cambia la lista)
- [ ] T14 (Recomendado) Rotar la contraseña de PBCS que estaba en Apps Script
- [ ] T15 Si Oracle tiene allowlist de IPs, habilitar la salida de Ownia

## Fase 3 — Validación (antes de apagar Apps Script)
- [ ] T16 Login con cuenta `@despegar.com` entra; con cuenta externa es rechazada (RF-01)
- [ ] T17 Revisar qué permisos pide la pantalla de Google (riesgo 1 de la spec)
- [ ] T18 Comparar números contra Apps Script: Date, Country, LOB, Legal Entity, Product, con y sin Delta (RF-03)
- [ ] T19 Export Actual y RunRate descargan el archivo (RF-04)
- [ ] T20 Admin guarda Medidas y otro usuario ve el cambio; un no-admin no puede guardar (RF-06)
- [ ] T21 Un Refresh queda registrado en el log (RF-07)
- [ ] T22 Link con filtros por URL abre con los filtros aplicados (RF-08)

## Fase 4 — Go-live
- [ ] T23 Un admin vuelve a cargar la config de Medidas vigente
- [ ] T24 Comunicar la nueva URL y desactivar el deploy de Apps Script
