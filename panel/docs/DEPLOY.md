# Despliegue del panel

Hay dos formas de usarlo. Las dos necesitan el **puente** corriendo en el PC del evento.

| | Modo local | Modo nube |
|---|---|---|
| Quién puede entrar | Celulares en la misma red (Wi-Fi o hotspot del evento) | Cualquiera con el link y un código, desde cualquier lugar |
| Internet | No hace falta | Hace falta en el evento |
| Varios eventos a la vez | No (uno por PC) | Sí, todos en el mismo panel |
| Costo | Gratis | Gratis en Render (con limitaciones) o ~7 USD/mes |

## Antes de empezar: dónde va el puente

**Instala el puente en el mismo PC donde corre Resolume.** Si lo instalas en otro PC, cada lectura pasa por el Wi-Fi: con un hotspot de celular la composición (~400 KB) tarda de 6 a 10 segundos, y el panel se siente lento. En el mismo PC la API de Resolume responde al instante.

En ese PC:

1. Instala [Node.js](https://nodejs.org) 22 LTS.
2. En Resolume: **Preferences → Webserver → Enable Webserver & REST API** (puerto 8080).
3. Descarga el proyecto: `git clone https://github.com/DjSantech/resolume-mcp.git` (o "Code → Download ZIP" en GitHub).
4. En `resolume-mcp\panel`, copia `panel-config.example.bat` como `panel-config.bat` y edítalo. Ese archivo tiene tus códigos y no se sube a git.

## Modo local (sin internet)

1. En `panel-config.bat` pon `ADMIN_CODE` (y `VIEWER_CODE` si quieres un código de solo lectura).
2. Doble clic en **`Panel Local.bat`**. La primera vez compila solo.
3. La ventana muestra direcciones como `http://172.20.10.2:3000`. Ábrela en el celular conectado a la misma red.
4. La primera vez, Windows pregunta si permite que Node.js use la red: marca **Redes privadas** y acepta. Si no aparece el aviso y el celular no carga la página, abre el puerto 3000 en el Firewall de Windows.

Si el celular es el que da el hotspot, también funciona: el PC y el celular están en la misma red.

## Modo nube (Render)

### 1. Desplegar el servidor (una sola vez)

1. Entra a [render.com](https://render.com) con tu cuenta de GitHub.
2. **New → Blueprint**, elige el repositorio `DjSantech/resolume-mcp` y como ruta del Blueprint pon `panel/render.yaml`.
3. Render pide tres valores:
   - `ADMIN_CODE`: el código con control total (para ti).
   - `VIEWER_CODE`: el código de solo lectura (para quien solo mira). Puede quedar vacío.
   - `BRIDGE_TOKEN`: un secreto largo para los puentes. Genera uno con
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
4. Crea el servicio. Al terminar, Render te da una dirección como `https://resolume-panel.onrender.com`.

`SESSION_SECRET` se genera solo. Cada `git push` a `main` vuelve a desplegar.

### 2. Conectar cada evento

En el PC de Resolume de cada evento, en `panel-config.bat`:

```bat
set EVENT_NAME=Boda Ana y Luis
set EVENT_ID=boda-ana-luis
set SERVER_URL=wss://resolume-panel.onrender.com
set BRIDGE_TOKEN=el-mismo-de-render
```

Doble clic en **`Panel Puente.bat`** y deja la ventana abierta. El evento aparece en el panel en unos segundos. Cada evento necesita un `EVENT_ID` distinto.

### 3. Entrar

Abre `https://resolume-panel.onrender.com` en el celular, escribe tu nombre y el código. Quien entre con `VIEWER_CODE` ve todo pero no puede cambiar nada. Desde el celular puedes "Agregar a pantalla de inicio" para usarlo como app.

### Limitaciones del plan gratis de Render

- El servicio se duerme tras 15 minutos sin tráfico y tarda ~1 minuto en despertar. Mientras un puente está conectado manda estado cada 15 s, lo que debería mantenerlo despierto; verifícalo en tu primer evento. Para eventos importantes conviene el plan **Starter** (~7 USD/mes), que no se duerme.
- Al reiniciarse o redesplegarse se borra el registro de actividad (el estado vuelve en segundos porque lo mandan los puentes). Las automatizaciones no se pierden: viven en cada puente (`panel\data\automations.json`).

### Otras opciones

- **Docker** (Railway, Fly.io, un VPS): hay un `Dockerfile` en `panel/`. Variables: `ADMIN_CODE`, `VIEWER_CODE`, `BRIDGE_TOKEN`, `SESSION_SECRET`, `PORT`. El proveedor debe soportar WebSocket y HTTPS.
- **Modo local + túnel**: corre `Panel Local.bat` y publica el puerto 3000 con [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared tunnel --url http://localhost:3000`). Sirve para un evento puntual sin desplegar nada.

## Datos móviles

Mientras alguien mira la pestaña **En vivo**, el puente sube una captura de la salida (~180-290 KB) cada 3 s, unos 4-6 MB por minuto. Si el evento usa datos móviles, sube `SNAPSHOT_MS` (por ejemplo 8000) o mira la pestaña Clips, que no pide capturas. Sin nadie mirando no se manda ninguna.

## Seguridad

- Usa códigos largos; el servidor bloquea 10 minutos tras 10 intentos fallidos por IP.
- `BRIDGE_TOKEN` es como una llave de los eventos: no lo compartas ni lo subas a git.
- Para quitarle el acceso a alguien, cambia el código en Render. Si cambias `SESSION_SECRET`, todas las sesiones abiertas se cierran.
