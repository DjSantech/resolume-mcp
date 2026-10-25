# Panel de Resolume

Panel web para ver y controlar Resolume Arena en eventos en vivo desde el celular.

- **Ver**: captura en vivo de la salida, qué suena en cada capa, BPM, master, automatización en curso y registro de quién hizo qué.
- **Controlar**: lanzar clips y columnas, opacidad por capa, master, BPM, cambiar de pestaña, apagar capa o todo. Un interruptor **Control** evita lanzar algo por un toque accidental.
- **Automatizar**: armar listas de visuales que se recorren en bucle (en orden o al azar, de N a M minutos cada uno) y arrancarlas, saltarlas o detenerlas desde el celular.
- **Roles**: código de administrador (todo) y de observador (solo mira).
- **Varios eventos**: cada evento con su puente aparece en el mismo panel.

```
 Celular  ──HTTPS──▶  Servidor (nube o local)  ◀──WebSocket──  Puente (PC de Resolume)  ──▶  Resolume :8080
```

El puente corre en el PC del evento, se conecta hacia afuera (no hay que abrir puertos) y ejecuta las automatizaciones: si se cae internet, los visuales siguen.

## Empezar

- **Desplegar y usar**: [docs/DEPLOY.md](docs/DEPLOY.md). Modo local por Wi-Fi/hotspot o modo nube en Render.
- **Cómo funciona por dentro**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). El contrato de mensajes está en [src/shared/protocol.ts](src/shared/protocol.ts).

## Desarrollo

```bash
npm install
npm test                 # compila y corre las pruebas (servidor + puente contra un Resolume simulado)
npm run mock             # Resolume simulado en :8090
ADMIN_CODE=1234 RESOLUME_URL=http://127.0.0.1:8090 npm run local   # panel completo en :3000
```

| Carpeta | |
|---|---|
| `src/server/` | Web, ingreso y relevo WebSocket |
| `src/bridge/` | Puente: lee Resolume, ejecuta órdenes, corre automatizaciones |
| `src/local.ts` | Servidor + puente en un proceso |
| `src/mock/` | Resolume simulado para pruebas |
| `web/` | Interfaz (HTML/CSS/JS sin compilar) |

Antes de lanzar un clip el puente lo ajusta a la pantalla (Fill o Fit según su proporción, escala 100%), igual que el autopiloto de la carpeta principal.
