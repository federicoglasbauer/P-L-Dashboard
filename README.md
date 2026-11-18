# P&L Dashboard — EPM Hub

Dashboard de P&L de Despegar (Planning & Control) que consulta Oracle PBCS (EPM).
Migrado desde Google Apps Script para correr en **Ownia**.

## Estructura

```
server.js                  Servidor Node/Express: login, proxy a PBCS, Medidas, log
public/index.html          Front del dashboard (idéntico al de Apps Script)
public/gas-shim.js         Reemplaza google.script.run → llamadas a /api/rpc/*
specs/                     Metodología SDD (spec → plan → tareas)
  constitution.md          Principios del proyecto
  001-migracion-apps-script-a-ownia/
    spec.md                Qué y por qué (requerimientos y criterios de aceptación)
    plan.md                Cómo (arquitectura, equivalencias, configuración)
    tasks.md               Tareas y checklist de validación
legacy/apps-script/        Código original de Apps Script como referencia (sin credenciales)
```

## Metodología (SDD)
Todo cambio arranca con una spec nueva en `specs/NNN-nombre/` con `spec.md`, `plan.md` y
`tasks.md`, respetando `specs/constitution.md`. El código se escribe recién cuando la spec y el
plan están acordados.

## Alta en Ownia
1. El repo tiene que estar en la organización **`despegar`** de GitHub (Ownia no despliega repos
   personales ni forks).
2. Crear la app en Ownia apuntando a este repo, con base de datos **DynamoDB**.
3. Cargar en los secretos de la app:
   - `PBCS_USER` y `PBCS_PASSWORD` (credenciales de Oracle PBCS)
   - Opcional: `ADMIN_EMAILS` (admins de Medidas, separados por comas)
4. Seguir la checklist de validación en `specs/001-migracion-apps-script-a-ownia/tasks.md`.

Todo lo demás (`DYNAMODB_*`, `GOOGLE_PROXY_*`, `BASE_PATH`) lo provee Ownia.
Detalle completo en [plan.md](specs/001-migracion-apps-script-a-ownia/plan.md).

## Correr local
Requiere Node 20+.

```bash
npm install
```

```bash
PBCS_USER=... PBCS_PASSWORD=... DEV_USER_EMAIL=tu.nombre@despegar.com npm start
```

Abrir http://localhost:8080/. Sin `GOOGLE_PROXY_APP_SECRET`, `DEV_USER_EMAIL` simula la sesión y
la config de Medidas se guarda en memoria.

## Seguridad
Nunca commitear credenciales. La contraseña de PBCS estuvo en texto plano en Apps Script:
se recomienda rotarla antes del go-live.
