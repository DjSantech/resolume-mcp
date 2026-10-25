# Arquitectura del panel

```
 Celular / PC (web)  ──HTTPS + WS──▶  Servidor  ◀──WS saliente──  Puente (PC del evento)  ──HTTP──▶  Resolume Arena :8080
   admin u observador                 (nube o local)              uno por evento
```

- **Puente** (`src/bridge/`): corre en un PC de la red del evento. Lee Resolume, manda el estado al servidor, ejecuta órdenes y **corre las automatizaciones**. Se conecta hacia afuera, así que no hay que abrir puertos en la red del evento. Si se cae internet, las automatizaciones siguen; reconecta solo.
- **Servidor** (`src/server/`): sirve la web, autentica, y relevan mensajes entre la web y los puentes. No guarda nada en disco: todo el estado vive en los puentes.
- **Web** (`web/`): HTML/CSS/JS sin compilar, pensada primero para celular.
- **Modo local** (`src/local.ts`): servidor + puente en un solo proceso, para usar el panel por el Wi-Fi/hotspot del evento sin internet.

El contrato de mensajes está en [`src/shared/protocol.ts`](../src/shared/protocol.ts). Es la fuente de verdad.

## Reglas comunes

- Node 20+, TypeScript estricto, ESM (`"type": "module"`, imports con extensión `.js`). Única dependencia de producción: `ws`.
- Comentarios y textos de interfaz en español, breves.
- Índices de capa/columna/pestaña empiezan en 1, como en Arena.
- Nunca imprimir tokens ni códigos de acceso en logs.

## Puente

Variables de entorno:

| Variable | Por defecto | |
|---|---|---|
| `RESOLUME_URL` | `http://127.0.0.1:8080` | Webserver de Resolume |
| `SERVER_URL` | — | `wss://mi-panel.onrender.com` (o `ws://127.0.0.1:3000` en local) |
| `BRIDGE_TOKEN` | — | Secreto compartido con el servidor |
| `EVENT_ID` | nombre del PC en minúsculas | Identificador único del evento (`[a-z0-9-]`) |
| `EVENT_NAME` | `EVENT_ID` | Nombre visible ("Boda Ana y Luis") |
| `DATA_DIR` | `./data` | Dónde guarda `automations.json` |
| `POLL_MS` | `1000` | Cada cuánto lee la composición |
| `SNAPSHOT_MS` | `3000` | Cada cuánto manda captura de la salida, solo si alguien mira |

Exporta `startBridge(config): Promise<{ stop(): Promise<void> }>` desde `src/bridge/bridge.ts`. `src/bridge/main.ts` lee el entorno y la llama.

Comportamiento:

- **Lectura**: `GET /api/v1/composition` cada `POLL_MS`. Convierte el JSON de Resolume a `EventState` (ver mapeo abajo). Manda `state` al servidor solo si cambió algo (comparar sin `updatedAt`), y como mínimo uno cada 15 s. Si Resolume no responde: `resolumeOnline=false`, `composition=null`, y sigue intentando.
- **Capturas**: con `watch.snapshots=true`, cada `SNAPSHOT_MS` pide `GET /composition/monitors/{id}/snapshot.jpg` del monitor llamado `"Composition"` (de `GET /composition/monitors`; si no está, id 1) y lo manda en base64.
- **Órdenes**: responde siempre con `result` (mismo `requestId`). Registra un `log` con `by` para las que cambian algo.
  - `triggerClip`: si el clip es archivo, primero ajustarlo (ver "Ajuste a pantalla"), luego `POST /composition/clips/by-id/{id}/connect`.
  - `triggerColumn`: `POST /composition/columns/{n}/connect`.
  - `clearLayer`: `POST /composition/layers/{n}/clear`. `clearAll`: `POST /composition/disconnect-all`.
  - `setLayerOpacity`: `PUT /parameter/by-id/{layer.video.opacity.id}` `{"value": v}`.
  - `setMaster`: `PUT /parameter/by-id/{composition.master.id}`. `setBpm`: `PUT /parameter/by-id/{composition.tempocontroller.tempo.id}`.
  - `selectDeck`: `POST /composition/decks/{n}/select` y esperar a que `decks[n-1].selected.value` sea true (Resolume tarda ~1-2 s).
  - `getThumbnail`: `GET /composition/clips/by-id/{id}/thumbnail` → `{ mime, data }` base64.
  - `saveAutomation`/`deleteAutomation`: persistir en `DATA_DIR/automations.json` (escritura atómica: archivo temporal + rename). `id` lo pone la web (si viene vacío, generar uno).
  - `startAutomation`/`stopAutomation`/`skipAutomation`: ver "Automatizaciones".
- **Reconexión** al servidor con espera creciente (1 s → 30 s máx). Las órdenes nunca se encolan mientras está desconectado.

### Mapeo desde el JSON de Resolume

| EventState | Resolume |
|---|---|
| `composition.name` | `name.value` |
| `bpm` | `tempocontroller.tempo.value` |
| `master` | `master.value` |
| `width`/`height` | `video.width.value` / `video.height.value` |
| `decks[]` | `decks[i]`: `id`, `name.value`, `selected.value` |
| `columns[]` | `columns[i].name.value` (reemplazar `#` por el número) |
| `layers[]` | `layers[i]`: `id`, `name.value` (`#` → número), `video.opacity.value`, `bypassed.value`, `solo.value` |
| `clips[]` | `layers[i].clips[j]`: `id`, `name.value`, `connected.value` (`Empty`→empty, `Disconnected`→disconnected, `Previewing`→previewing, `Connected` y `Connected & previewing`→connected), `transport.position.max/1000`, `isFile = !!video.fileinfo` |
| `nowPlaying[]` | clips con estado `connected` |
| `resolume` | `GET /api/v1/product` → `{name, major, minor, micro}` (leer una vez por conexión) |

Hay ejemplos reales del JSON en `src/mock/fixtures/` (con nombres genéricos).

### Ajuste a pantalla

Resolume carga los clips en resize `Original`: los de menor resolución que la composición se ven pequeños. Antes de lanzar un clip de archivo:
- proporción `fileinfo.width/height` a ±10 % de la composición → `Fill`; si no → `Fit`. `PUT /parameter/by-id/{video.resize.id}`.
- si el clip tiene efecto `Transform` con `params.Scale.value` ≠ 100 → ponerlo en 100.

Hay que hacerlo **en cada lanzamiento**: Resolume descarta estos cambios hechos por la API cuando se cambia de pestaña.

### Automatizaciones

Una a la vez por puente (todas usan capas compartidas). Al arrancar:
1. Si `deckName` no está vacío y no es la pestaña abierta: abrirla (como `selectDeck`).
2. Lista de clips: `clips` de la automatización; si está vacía, todos los clips no vacíos de `layer`, releídos en cada vuelta. Con `order: "shuffle"`, barajar en cada vuelta sin repetir el último.
3. Por cada clip: leer `GET /composition/clips/by-id/{id}` (si falla o está vacío, saltarlo y registrar `warn`), duración = `transport.position.max/1000`, calcular tiempo con `planDuration` (abajo), ajustar si `fit`, conectar por id, esperar. `skipAutomation` corta la espera y pasa al siguiente. `stopAutomation` deja el clip actual sonando.
4. Los clips se lanzan por id: si alguien cambia de pestaña a mano, la automatización sigue lanzando sus clips.

```ts
// Repeticiones enteras si caben en el rango; si no, un corte al azar dentro del rango.
function planDuration(lengthS: number, min: number, max: number): { seconds: number; how: string } {
  if (lengthS > 0) {
    const minLoops = Math.ceil(min / lengthS), maxLoops = Math.floor(max / lengthS);
    if (minLoops <= maxLoops) {
      const loops = minLoops + Math.floor(Math.random() * (maxLoops - minLoops + 1));
      return { seconds: loops * lengthS, how: loops === 1 ? "1 pasada completa" : `${loops} repeticiones` };
    }
  }
  return { seconds: min + Math.random() * (max - min), how: lengthS > max ? "clip largo, se corta" : "se corta dentro del rango" };
}
```

`runner` en `EventState` refleja la automatización en curso. Si el puente se reinicia, no retoma la automatización.

## Servidor

| Variable | Por defecto | |
|---|---|---|
| `PORT` | `3000` | |
| `ADMIN_CODE` | — (obligatorio) | Código de acceso con control total |
| `VIEWER_CODE` | vacío | Código de solo lectura. Vacío = no hay observadores |
| `BRIDGE_TOKEN` | — (obligatorio) | Secreto que deben presentar los puentes |
| `SESSION_SECRET` | aleatorio al arrancar | Firma de las sesiones. Fijo si quieres que las sesiones sobrevivan reinicios |
| `STATIC_DIR` | `<paquete>/web` | Carpeta de la web |

Exporta `startServer(config): Promise<{ port: number; close(): Promise<void> }>` desde `src/server/server.ts`. `src/server/main.ts` lee el entorno, falla con un mensaje claro si falta `ADMIN_CODE` o `BRIDGE_TOKEN`, y la llama.

- `GET /` y archivos de `STATIC_DIR` (tipos MIME correctos, sin listar carpetas, sin salir de la carpeta). `GET /healthz` → `ok`.
- `POST /api/login` `{name, code}` → `{token, role, name}` o 401. Comparación en tiempo constante. Límite: 10 intentos fallidos por IP cada 10 min → 429. Token: `base64url(JSON{name, role, exp}) + "." + HMAC-SHA256(SESSION_SECRET)`, vence en 7 días. `name` recortado a 40 caracteres.
- `WS /ws/bridge?event=&name=&token=`: rechaza token incorrecto o `event` inválido. Si ya hay un puente con ese `event`, el nuevo reemplaza al viejo (cierra el viejo).
- `WS /ws/client?token=`: rechaza token inválido/vencido. Envía `welcome` y `events`.
- Por evento guarda: resumen, último `state`, última captura, últimos 200 `log`. Eventos desconectados siguen en la lista con `online=false` y se borran a las 24 h sin verse.
- `events` a todos los clientes cuando cambia la lista o un resumen (como mucho 1 por segundo).
- `subscribe`: manda el último `state`, la última captura (si `snapshots`) y `logs`. A partir de ahí reenvía `state`, `log` y (si `snapshots`) `snapshot` de ese evento. Cuando cambia el número de clientes mirando capturas de un evento (0 ↔ >0), manda `watch` al puente.
- `command`: si el rol es `viewer` y la acción no está en `VIEWER_ACTIONS` → `result` con error. Si el puente no está → error "El evento no está conectado". Reenvía al puente con `by` = nombre de la sesión y un `requestId` interno; devuelve el `result` al cliente que la pidió con su `requestId` original. Timeout 15 s.
- Ping/pong de WebSocket cada 25 s para detectar conexiones muertas (los proxies de Render/Railway cortan conexiones inactivas).

## Web

Archivos estáticos en `web/`: `index.html`, `app.js` (módulo ES, sin dependencias), `styles.css`, `manifest.webmanifest`, `icon.svg`. Español, primero para celular (360-430 px), también usable en escritorio. Tema oscuro (se usa en cabina oscura).

- **Ingreso**: nombre + código. Guarda el token en `localStorage`. Si el WS se cierra con token inválido, vuelve al ingreso. Reconexión automática con aviso visible ("Reconectando…").
- **Eventos**: tarjetas con nombre, punto en línea/fuera de línea, Resolume conectado o no, qué suena por capa, automatización en curso. Si hay un solo evento en línea, entra directo.
- **Evento**, con pestañas:
  - **En vivo**: captura de la salida (se actualiza sola; `subscribe` con `snapshots: true` solo mientras esta pestaña está visible y la página está en primer plano), qué suena en cada capa, BPM, master, automatización en curso con barra de progreso del clip actual (`current.startedAt`→`until`) y botones Saltar/Detener.
  - **Clips**: selector de pestaña (deck) de Resolume, capas con sus clips en cuadrícula con miniatura (`getThumbnail`, cacheada por clipId), el que suena resaltado. Tocar un clip lo lanza. Por seguridad hay un interruptor **"Control"** que está apagado al entrar: con él apagado tocar no lanza nada. Por capa: opacidad (slider) y botón apagar capa. Master y BPM. "Apagar todo" con confirmación dentro de la página.
  - **Automatizaciones**: lista con Iniciar/Editar/Borrar; editor con nombre, pestaña (texto o elegir de las existentes), capa, clips (lista con casillas y miniaturas tomada de la pestaña abierta; ninguno marcado = todos los de la capa), orden, mínimo y máximo en minutos, ajuste a pantalla. Validar min ≤ max y min ≥ 10 s.
  - **Registro**: últimos eventos del log, con hora y quién.
- Observador: ve todo, sin controles (sin interruptor Control, sin botones de cambio, sin editor).
- Sin `alert/confirm/prompt`: confirmaciones dentro de la página.
- Accesible: botones grandes (≥ 44 px), foco visible, `prefers-reduced-motion`.
