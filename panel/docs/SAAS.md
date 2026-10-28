# VisualMaping: modo cuentas (SaaS)

Especificación de la versión comercial. Complementa a [ARCHITECTURE.md](ARCHITECTURE.md), que sigue vigente para el puente, el protocolo WebSocket y el modo local.

## Modos del servidor

| Modo | Cuándo | Ingreso | Puentes |
|---|---|---|---|
| **cuentas** | `DATABASE_URL` definido, o `ACCOUNTS_STORE=memory` (pruebas) | correo + contraseña, por empresa | PCs vinculados con código (agente) |
| **códigos** | ninguno de los anteriores (modo local, `npm run local`) | nombre + `ADMIN_CODE`/`VIEWER_CODE` (como hoy) | `BRIDGE_TOKEN` (como hoy) |

El modo códigos no cambia. Todo lo de abajo es el modo cuentas.

## Marca y configuración

| Variable | Por defecto | |
|---|---|---|
| `BRAND_NAME` | `VisualMaping` | Nombre visible en la web y el agente. **Nunca** escribir el nombre de la marca a mano en otro lado: leerlo de aquí (servidor) o de `GET /api/config` (web). |
| `DATABASE_URL` | — | Postgres (Neon, Render, Supabase…). Activa el modo cuentas. |
| `ACCOUNTS_STORE` | — | `memory` = modo cuentas sin base de datos (pruebas y desarrollo; se pierde al reiniciar). |
| `SESSION_SECRET` | aleatorio | Firma de sesiones. En la nube debe ser fijo. |
| `SUPERADMIN_EMAILS` | vacío | Correos (separados por coma) que ven el panel de superadministrador. |
| `CONTACT_WHATSAPP` | vacío | Número para pagos/soporte, p. ej. `573001234567`. La web arma `https://wa.me/<número>`. |
| `AGENT_VERSION` / `AGENT_DOWNLOAD_URL` / `AGENT_SHA256` | vacío | Última versión del agente publicada, de dónde bajarla y su hash. Los usan la web (botón Descargar) y la auto-actualización. |
| `PUBLIC_URL` | derivado de la petición | URL pública (`https://visualmaping.onrender.com`) para armar enlaces de invitación. |

## Planes (precios en pesos colombianos)

Fijos en el código del servidor (`src/server/plans.ts`) y publicados en `GET /api/plans`:

| id | Nombre | COP / mes | PCs | Notas |
|---|---|---|---|---|
| `prueba` | Prueba | 0 | 1 | 14 días desde el registro |
| `vj` | VJ | 60.000 | 1 | |
| `productora` | Productora | 200.000 | 5 | equipo ilimitado |
| `empresa` | Empresa | 520.000 | 15 | soporte prioritario |

Una empresa tiene `plan` y `planExpiresAt`. **Plan vencido**: se puede entrar y mirar (todos quedan como observadores, también el dueño), no se puede controlar, no se pueden vincular PCs nuevos. Los PCs siguen conectados y sus automatizaciones locales siguen corriendo (nunca cortar un show). El superadministrador cambia plan y vencimiento a mano (pago por Nequi/transferencia); Mercado Pago llega después.

Límite de PCs: no se puede **generar** un código de vinculación si la empresa ya tiene `maxPcs` PCs vinculados.

## Datos

```
orgs          id, name, plan, plan_expires_at, created_at
users         id, email (único, minúsculas), name, password_hash, token_version, created_at
memberships   org_id, user_id, role ('owner'|'operator'|'viewer'), created_at   (una empresa por usuario en esta versión)
invites       code, org_id, role, created_by, expires_at, used_at
pairing_codes code, org_id, created_by, expires_at, used_at
agents        id, org_id, name, secret_hash, version, last_seen_at, created_at, revoked_at
```

- Contraseñas: `scrypt` (node:crypto) con sal aleatoria; mínimo 8 caracteres.
- Secretos de agente y de invitación: aleatorios (≥ 24 bytes, base64url). En la base se guarda solo el **hash** (SHA-256) del secreto del agente.
- Código de vinculación: 6 caracteres sin ambiguos (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), se muestra como `ABC-123`, vence a los 15 minutos, un solo uso. Se acepta con o sin guion, en minúsculas o mayúsculas.
- Invitación: código largo de un solo uso, vence a los 7 días.
- Interfaz `Store` (en `src/server/store/`) con dos implementaciones: `MemoryStore` (pruebas/desarrollo) y `PgStore` (`pg`, crea las tablas con `CREATE TABLE IF NOT EXISTS` al arrancar). El resto del servidor solo usa la interfaz.

## Sesión

Mismo formato de token firmado que hoy (`base64url(JSON).HMAC`), con: `uid`, `oid`, `role` (`owner|operator|viewer`), `tv` (token_version), `name`, `exp` (30 días). El servidor rechaza el token si `tv` no coincide con el de la base (cambiar contraseña o sacar a alguien del equipo cierra sus sesiones).

Rol hacia el protocolo WebSocket: `owner` y `operator` → `admin`; `viewer` → `viewer`; con plan vencido todos → `viewer`.

La web manda el token en `Authorization: Bearer <token>` a la API REST y en `?token=` al WebSocket (como hoy).

## API REST (JSON)

Errores: `{ "error": "mensaje en español" }` con el código HTTP que corresponda (400 datos inválidos, 401 sin sesión, 403 sin permiso, 404, 409 conflicto, 429 límite de intentos).

**Públicas**

| | |
|---|---|
| `GET /api/config` | `{ mode: "accounts"\|"codes", brand, contactWhatsapp, agent: { version, downloadUrl } \| null }` |
| `GET /api/plans` | `[{ id, name, priceCop, maxPcs, trialDays?, features: string[] }]` |
| `POST /api/signup` | `{ orgName, name, email, password }` → `{ token, me }`. Crea empresa en plan `prueba` con 14 días y al usuario como `owner`. 409 si el correo ya existe. |
| `POST /api/login` | modo cuentas: `{ email, password }` → `{ token, me }` · modo códigos: igual que hoy. Límite de intentos por IP (como hoy). |
| `GET /api/invites/:code` | `{ orgName, role, expiresAt }` o 404/410 |
| `POST /api/invites/:code/accept` | `{ name, email, password }` → `{ token, me }`. Si el correo ya existe y la contraseña es correcta, lo une a la empresa (si no pertenece a otra). |
| `POST /api/agent/pair` | `{ code, pcName, agentVersion }` → `{ agentId, agentSecret, orgName, pcName }`. Límite de intentos por IP. Rechaza código vencido/usado o empresa sin cupo. |
| `GET /api/agent/version` | `{ version, downloadUrl, sha256 }` (vacíos si no hay publicada) |

**Con sesión**

| | Rol | |
|---|---|---|
| `GET /api/me` | todos | `me = { user: {id, name, email}, org: {id, name}, role, plan: {id, name, maxPcs, expiresAt, active, daysLeft}, superadmin: bool }` |
| `PATCH /api/me` | todos | `{ name?, password?, currentPassword? }` (cambiar contraseña exige la actual y sube `token_version`) |
| `PATCH /api/org` | owner | `{ name }` |
| `GET /api/team` | todos | `[{ userId, name, email, role, createdAt }]` + invitaciones pendientes para owner |
| `POST /api/invites` | owner | `{ role: "operator"\|"viewer" }` → `{ code, url, expiresAt }` (`url` = `PUBLIC_URL/app/#invitacion-<code>` ) |
| `DELETE /api/invites/:code` | owner | anula una invitación pendiente |
| `PATCH /api/team/:userId` | owner | `{ role }` (no puede quitarse a sí mismo el rol de owner si es el único) |
| `DELETE /api/team/:userId` | owner | saca a alguien (sube su `token_version`, cierra sus WebSocket) |
| `GET /api/pcs` | todos | `[{ id, name, online, resolumeOnline, version, lastSeenAt, createdAt }]` |
| `POST /api/pcs/pairing-code` | owner, operator | `{ code, expiresAt }`; 403 si el plan está vencido o sin cupo (mensaje claro con el límite) |
| `PATCH /api/pcs/:id` | owner, operator | `{ name }` → se refleja como nombre del evento en el panel |
| `DELETE /api/pcs/:id` | owner | desvincula: marca `revoked_at`, cierra su WebSocket; ese agente ya no puede entrar |

**Superadministrador** (`SUPERADMIN_EMAILS`)

| | |
|---|---|
| `GET /api/admin/orgs` | `[{ id, name, plan, planExpiresAt, owners: [{name, email}], members, pcs, pcsOnline, createdAt }]` |
| `PATCH /api/admin/orgs/:id` | `{ plan?, planExpiresAt? }` |

## WebSocket en modo cuentas

- **Web**: `/ws/client?token=` como hoy. El cliente solo ve y controla los eventos (PCs) **de su empresa**. `events` lista los PCs de su empresa (también los desconectados, con `online=false`). `eventId` = id del PC. `name` = nombre del PC guardado en la base.
- **Agente**: `/ws/bridge?agent=<agentId>&secret=<agentSecret>`. Se rechaza (401) si no existe, está desvinculado o el secreto no coincide. Al conectar se actualizan `version` y `last_seen_at`. El nombre que manda el puente en `hello` se ignora: manda el de la base.
- Si un agente se desvincula o alguien sale del equipo, se cierran sus conexiones (código 4001 para la web, como sesión inválida).

## Agente (el `.exe`)

Programa para el PC de Resolume. No necesita Node instalado ni el repositorio.

1. Al abrirlo levanta una página local en `http://127.0.0.1:7377` (que además sirve de candado: si el puerto está ocupado, ya hay un agente corriendo → abre esa página y sale) y la abre en el navegador.
2. Sin vincular: la página pide **servidor** (prellenado con la URL de fábrica, editable en "avanzado"), **código** y **nombre del PC**. Llama a `POST /api/agent/pair` y guarda `{ serverUrl, agentId, agentSecret }` en `%APPDATA%\VisualMaping\agente.json`.
3. Vinculado: arranca el puente (`startBridge` con credenciales de agente, `DATA_DIR` = `%APPDATA%\VisualMaping\data`) y la página muestra: estado del servidor y de Resolume, empresa y nombre del PC, versión, botón **Abrir panel** y **Desvincular este PC**.
4. **Arranque con Windows**: se registra en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` y arranca sin ventana visible. Se puede desactivar desde la página local.
5. **Actualización**: al arrancar y cada 6 h consulta `GET /api/agent/version`; si hay una versión mayor, la descarga, verifica el SHA-256, se reemplaza y se reinicia. Nunca en medio de una automatización: espera a que no haya ninguna corriendo.
6. Se construye con Node SEA (single executable application): `npm run build:agente` → `dist-agente/VisualMaping-Agente.exe`.
