# Constitución del proyecto — P&L Dashboard (EPM Hub)

Principios que toda spec, plan y cambio de código de este repo tiene que respetar.
Si una propuesta contradice alguno, se cambia la propuesta o se enmienda esta constitución
explícitamente (con fecha y motivo al final del archivo).

## 1. Spec primero
Ningún cambio de comportamiento entra al código sin una spec en `specs/NNN-nombre/`
(`spec.md` → `plan.md` → `tasks.md`). Los bugfixes chicos pueden referenciar una spec existente.

## 2. Paridad funcional con Apps Script
La migración no cambia números. Los cálculos del P&L (árbol de cuentas, Bimonetario, PPA,
As Reported, Medidas, deltas) viven en el front (`public/index.html`) y no se tocan como parte
de la migración. Cualquier diferencia contra el dashboard de Apps Script es un bug.

## 3. Cero secretos en el repo
Credenciales de Oracle PBCS, tokens y passwords se leen solo de `APP_SECRETS` (Ownia) o de
variables de entorno. Nunca en código, specs, commits ni issues.

## 4. Acceso restringido
Solo cuentas `@despegar.com` pueden ver la página o llamar a la API. Las acciones de admin
(editar Medidas) se validan en el servidor, nunca solo en el front.

## 5. El servidor es un proxy fino
El backend no tiene lógica de negocio del P&L: autentica, reenvía a PBCS y persiste config/logs.
Mantenerlo chico facilita auditar qué datos salen de Oracle.

## 6. Plataforma Ownia
Se despliega en Ownia (AWS, Despegar). Se usan solo capacidades soportadas por la plataforma:
`APP_SECRETS`, DynamoDB (`pk`/`sk`), proxy de Google, `BASE_PATH`. Nada de infraestructura propia.
