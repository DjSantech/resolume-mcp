# resolume-mcp

Control de **Resolume Arena** desde Claude y automatización de visuales para eventos en vivo.

El proyecto tiene dos partes que usan la REST API de Resolume (el Webserver de Arena):

1. **Servidor MCP** (`src/index.ts`): le da a Claude Desktop herramientas para leer la composición y lanzar clips, columnas, opacidad y BPM.
2. **Autopiloto** (`src/autopilot.ts`): recorre los visuales de una capa en bucle, dejando cada uno entre 2 y 3 minutos, y vuelve a empezar.

```
PC de control  ──HTTP──▶  Resolume Arena (Webserver :8080)
 ├─ Claude Desktop + servidor MCP
 └─ Autopiloto (.bat)
```

El PC de control y el de Resolume pueden ser el mismo o dos equipos en la misma red.

**¿Quieres manejarlo desde el celular?** Mira el [panel web](panel/README.md): vista en vivo de la salida, control de clips y automatizaciones, con acceso de administrador y de observador, en local o desplegado en la nube.

## Requisitos

- Node.js 18 o superior
- Resolume Arena 7.x con el Webserver activo: **Preferences → Webserver → Enable Webserver & REST API** (puerto 8080 por defecto)
- Claude Desktop, solo para la parte MCP

## Instalación

```bash
npm install
npm run build
```

La URL de Resolume se pasa con la variable `RESOLUME_URL` (por defecto `http://127.0.0.1:8080`). Si cambia la IP no hace falta recompilar.

## 1. Servidor MCP para Claude Desktop

Agrega el servidor a `claude_desktop_config.json` (en Claude Desktop: Settings → Developer → Edit Config). Hay un ejemplo en [claude_desktop_config.example.json](claude_desktop_config.example.json):

```json
{
  "mcpServers": {
    "resolume": {
      "command": "node",
      "args": ["C:\\ruta\\a\\resolume-mcp\\dist\\index.js"],
      "env": { "RESOLUME_URL": "http://172.20.10.2:8080" }
    }
  }
}
```

Reinicia Claude Desktop por completo. Herramientas disponibles (los índices empiezan en 1, igual que en Arena):

| Herramienta | Qué hace |
|---|---|
| `get_composition_summary()` | Lista capas, columnas y clips con su estado. Úsala primero. |
| `trigger_clip(layer, column)` | Lanza un clip |
| `select_column(column)` | Lanza una columna entera |
| `set_layer_opacity(layer, value)` | Opacidad de una capa (0 a 1) |
| `set_master_opacity(value)` | Opacidad general (0 a 1) |
| `set_bpm(bpm)` | Cambia el tempo |
| `clear_all()` | Apaga todos los clips |

Para probar: *"dame un resumen de la composición"*, luego *"lanza la columna 2"* en un show de prueba.

## 2. Autopiloto

Recorre los clips cargados en una capa, en orden de columna, y vuelve a empezar. Cada clip queda entre `MIN_SECONDS` y `MAX_SECONDS`:

- **Clip corto:** se repite un número entero de veces hasta caer en el rango, así el cambio coincide con el final de una repetición.
- **Clip largo, o uno que no encaja exacto:** se corta en un momento al azar dentro del rango.

Los clips se lanzan por su id, así que si alguien cambia de pestaña en Resolume el autopiloto sigue lanzando los correctos. En cada vuelta relee la capa, por si agregaste o quitaste visuales.

Antes de lanzar cada clip lo ajusta a la pantalla (`src/fit.ts`): si su proporción es parecida a la de la composición lo pone en **Fill** (llena sin bordes); si es vertical, cuadrado o muy panorámico, en **Fit** (completo, con bordes). También deja la escala del Transform del clip en 100%. Se hace en cada lanzamiento porque Resolume descarta estos ajustes hechos por la API cuando se cambia de pestaña. `FIT=off` lo desactiva. `trigger_clip` del servidor MCP hace lo mismo.

### Arrancar

Doble clic en el `.bat` que corresponda:

| Archivo | Pestaña (deck) | Capa |
|---|---|---|
| `Autopilot Capa 1.bat` | Fiesta Santech | 1 |
| `Autopilot Protocol Santech.bat` | Protocol Santech | 1 |

Se abre una ventana que muestra cada visual que lanza. **Déjala abierta**: al cerrarla el bucle se detiene. Ctrl+C también lo detiene, y el clip que esté sonando se queda en pantalla.

Corre uno a la vez: los dos usan la capa 1.

### Ver el plan sin lanzar nada

```bash
npm run autopilot:plan
```

### Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `RESOLUME_URL` | `http://127.0.0.1:8080` | Dirección del Webserver de Resolume |
| `DECK` | (la pestaña abierta) | Nombre de la pestaña. Si no está abierta, la abre al arrancar |
| `LAYER` | `1` | Capa que recorre |
| `MIN_SECONDS` / `MAX_SECONDS` | `120` / `180` | Tiempo de cada visual |
| `FIT` | `on` | `off` para no ajustar el tamaño de los clips antes de lanzarlos |

Ejemplo manual:

```bash
RESOLUME_URL=http://172.20.10.2:8080 DECK="Protocol Santech" node dist/autopilot.js --dry-run
```

## 3. Herramientas de preparación (`tools/`)

Scripts que se usaron para elegir y cargar los visuales del show. Ninguno lanza clips ni toca casillas que estén al aire.

| Script | Qué hace |
|---|---|
| `contact_sheets.py` | Hace una hoja de 8 fotogramas y estadísticas de color (amarillo, blanco, movimiento) por cada video de una carpeta local |
| `render_thumbs.mjs` | Saca 4 miniaturas de videos que solo existen en el PC de Resolume: los carga en una casilla vacía, toma las miniaturas por la API y la vuelve a vaciar |
| `tile_thumbs.py` | Une esas miniaturas en hojas y calcula las mismas estadísticas |
| `setup_decks.mjs` | Carga la selección de fiesta en la capa 1 y crea la pestaña "Protocol Santech" con 15 visuales dorados y blancos |
| `fit_clips.mjs` | Pone en Fill/Fit todos los clips de video y su escala en 100%. `--current` solo la pestaña abierta, `--layers=1` solo esas capas, `--dry-run` solo muestra |

Los scripts de Python necesitan `opencv-python` y `numpy`.

La API de Resolume no permite listar carpetas, pero `POST /api/v1/file-info` dice si un archivo existe y su duración, formato y resolución. Con eso se puede saber qué hay en el disco del PC de Resolume probando nombres.

## Notas

- Las rutas de la API pueden variar entre versiones de Arena. Si algo da 404, revisa `http://<ip>:8080/api/v1/composition` o la especificación en `http://<ip>:8080/api/docs/rest/swagger.yaml`.
- Prueba todo en un ensayo antes de usarlo en un evento real.
- Las capas son compartidas entre pestañas: al pasar a Protocol, lo que suene en las capas 2 y 3 sigue sonando hasta que lo apagues.
