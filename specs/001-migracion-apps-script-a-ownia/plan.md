# Plan técnico — Spec 001

## Arquitectura

```
Navegador ──► Ownia (Caddy, BASE_PATH=/<app>) ──► Node/Express (server.js)
   │                                                  ├─► Oracle PBCS (REST, Basic auth)
   │                                                  ├─► DynamoDB (config Medidas + log)
   │                                                  └─► Proxy de Google de Ownia (login)
   └── public/index.html  +  public/gas-shim.js
```

- **Front:** `public/index.html` es el HTML de Apps Script **sin modificar**. El servidor le
  inyecta `<script src="gas-shim.js">` antes de `</head>`.
- **Shim:** `public/gas-shim.js` define `google.script.run` y `google.script.url` en el navegador.
  Cada `google.script.run.X(args)` se convierte en `POST api/rpc/X` con `{ args: [...] }`.
  Así el front sigue llamando a las mismas funciones que en Apps Script.
- **Back:** `server.js` (Express) expone las mismas funciones que `Code.gs` en un objeto `RPC`.

## Equivalencias Apps Script → Ownia

| Apps Script | Ownia |
|-------------|-------|
| `HtmlService.createHtmlOutputFromFile` | `GET /` sirve `public/index.html` |
| `google.script.run.X()` | `POST /api/rpc/X` (vía `gas-shim.js`) |
| `UrlFetchApp.fetch` | `fetch` nativo de Node 20 |
| `Utilities.base64Encode` | `Buffer.toString('base64')` |
| `Utilities.zip` | `adm-zip` |
| Credenciales hardcodeadas | `APP_SECRETS.PBCS_USER` / `PBCS_PASSWORD` |
| `Session.getActiveUser()` | Sesión propia tras login con Google (proxy de Ownia), dominio `despegar.com` |
| `PropertiesService` (Medidas) | DynamoDB: `pk=config`, `sk=medidas` |
| `SpreadsheetApp` (log) | DynamoDB: `pk=refreshlog#YYYY-MM`, `sk=<iso>#<rand>` + log en stdout |
| Restricción de dominio de la web app | Middleware de sesión + validación de dominio |

## Flujo de login (RF-01, RF-09)
1. Request sin sesión a `/` → redirect a `/login`.
2. `/login` genera un id aleatorio, guarda cookie firmada `pnl_login` (15 min) y pide a Ownia un
   `connect_url` (`POST {GOOGLE_PROXY_INTERNAL_URL}/google/connect-token`) con
   `next=https://<host>/<app>/auth/callback`.
3. El usuario aprueba en Google y vuelve a `/auth/callback`.
4. El servidor lee el email (Drive `about`, con fallback a Gmail profile y Calendar primary).
5. Si el dominio está en `ALLOWED_EMAIL_DOMAINS` (default `despegar.com`) emite la cookie
   `pnl_session` (12 h). Si no, 403.
6. La API devuelve `401 { login: true }` sin sesión; el shim redirige a `login`.

## Configuración (APP_SECRETS)

| Clave | Obligatoria | Origen | Uso |
|-------|-------------|--------|-----|
| `PBCS_USER` | Sí | Cargar a mano | Usuario de Oracle PBCS |
| `PBCS_PASSWORD` | Sí | Cargar a mano | Password de Oracle PBCS |
| `DYNAMODB_TABLE`, `DYNAMODB_PK`, `DYNAMODB_SK` | Sí | Ownia (al crear la app con DynamoDB) | Medidas y log |
| `GOOGLE_PROXY_APP_SECRET`, `GOOGLE_PROXY_INTERNAL_URL` | Sí | Ownia (automático) | Login |
| `ADMIN_EMAILS` | No | Cargar a mano | Lista de admins separada por comas (si no, usa la del código) |
| `ALLOWED_EMAIL_DOMAINS` | No | Cargar a mano | Default `despegar.com` |
| `APP_NAME` | No | — | Default: `BASE_PATH` sin `/` |
| `SESSION_SECRET` | No | — | Default: derivado de `GOOGLE_PROXY_APP_SECRET` |

## Infraestructura a pedir en Ownia
- App Node.js (Ownia genera el Dockerfile; `npm start` levanta `server.js`).
- Base de datos: **DynamoDB**.
- Sin SMTP.
- Health check: `GET /<app>/health`.

## Decisiones
- **No reescribir el front.** Es grande y tiene la lógica de negocio validada; el shim evita
  tocarlo y reduce el riesgo de diferencias de números (constitución §2).
- **Login con el proxy de Google de Ownia** en vez de un OAuth propio: no requiere proyecto de
  Google Cloud ni client secrets. Riesgo de permisos anotado en la spec.
- **Medidas arranca en default:** la config de Apps Script vive en Script Properties y no se
  migra automáticamente. Un admin la vuelve a guardar una vez.
