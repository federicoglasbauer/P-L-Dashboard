# Spec 001 — Migrar el P&L Dashboard de Google Apps Script a Ownia

- **Estado:** Implementada (pendiente de deploy y validación en Ownia)
- **Fecha:** 2026-11-18
- **Owner:** Planning & Control

## Contexto
El P&L Dashboard (EPM Hub) hoy corre como web app de Google Apps Script. Apps Script sirve la
página y hace de proxy hacia Oracle PBCS (EPM). Queremos llevarlo a Ownia para tenerlo
versionado en git, con deploy controlado, credenciales fuera del código y acceso restringido
a cuentas de Despegar.

## Objetivo
Que los usuarios actuales usen el mismo dashboard, con los mismos números, desde una URL de
Ownia, sin depender de Apps Script.

## Fuera de alcance
- Cambios en los cálculos o la UI del P&L.
- Envío del reporte de desvíos a Slack (`sendDeviationAlert` no existía en Apps Script).
- Vista "By Channel" (ya estaba "en desarrollo").
- Log de Refresh en la Google Sheet (se reemplaza por log en la base de la app; ver RF-07).

## Usuarios
- **Usuario de negocio:** consulta el P&L, filtra, exporta CSV y dispara exports de EPM.
- **Admin de Medidas:** además edita la configuración de escenarios por mes.

## Requerimientos funcionales

| ID | Requerimiento | Criterio de aceptación |
|----|---------------|------------------------|
| RF-01 | Login solo con cuentas `@despegar.com` | Sin sesión, `/` redirige a login con Google. Una cuenta de otro dominio ve "Acceso solo para cuentas de Despegar" y no accede a datos. |
| RF-02 | Servir el dashboard | Con sesión válida, `/` devuelve el mismo HTML que Apps Script, con todas las vistas (Date, Country, LOB, Legal Entity, Product). |
| RF-03 | Proxy de data slice a PBCS | `fetchPBCS(payload)` devuelve la misma respuesta JSON que en Apps Script para el mismo payload. |
| RF-04 | Exports de EPM | `runExportJob`, `getJobStatus`, `downloadExportFile` y `downloadExportFilesZipped` se comportan igual que en Apps Script (export Actual y RunRate descargan el archivo). |
| RF-05 | Identidad del usuario | `getUserInfo()` devuelve el email de la sesión y si es admin. |
| RF-06 | Configuración de Medidas | Todos pueden leerla. Solo los admins pueden guardarla; la validación se hace en el servidor. El guardado aplica para todos los usuarios. |
| RF-07 | Log de Refresh | Cada Refresh registra timestamp (hora Argentina), usuario y vista. Si el log falla, el Refresh no se bloquea. |
| RF-08 | Filtros por URL | `?scenario=&version=&year=&country=&product=&lob=&months=` siguen funcionando. |
| RF-09 | Sesión expirada | Si la sesión vence con la página abierta, la próxima acción redirige al login. |

## Requerimientos no funcionales

| ID | Requerimiento |
|----|---------------|
| RNF-01 | Credenciales de PBCS solo en `APP_SECRETS` (`PBCS_USER`, `PBCS_PASSWORD`). |
| RNF-02 | Timeout de llamadas a PBCS: 5 minutos (similar al límite de Apps Script). |
| RNF-03 | Sesión de 12 horas, cookie `HttpOnly`, `Secure`, `SameSite=Lax`, firmada con HMAC. |
| RNF-04 | Admins configurables con el secreto `ADMIN_EMAILS` sin redeploy de código. |
| RNF-05 | Funciona detrás del prefijo `BASE_PATH` de Ownia (`/<app>/`). |

## Riesgos y preguntas abiertas
1. **Permisos del login con Google:** el proxy de Google de Ownia está pensado para acceder a
   Drive/Sheets/Gmail; la pantalla de consentimiento podría pedir más permisos de los necesarios
   solo para conocer el email. Validar en el primer deploy; si molesta, consultar a Ownia por un
   login corporativo delante de la app.
2. **Allowlist de IPs en Oracle:** si PBCS restringe IPs de origen, hay que habilitar la salida
   de Ownia.
3. **Credencial expuesta:** la contraseña de PBCS estuvo en texto plano en el Apps Script.
   Recomendado rotarla antes del go-live.
4. **Repo en la org `despegar`:** Ownia solo despliega repos de la organización `despegar`
   en GitHub (no cuentas personales ni forks). El repo tiene que vivir ahí.
