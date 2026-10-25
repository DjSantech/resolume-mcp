# Pantallas: slices automáticos para la Salida Avanzada

Para no cortar los slices a mano en cada evento: se describe la pantalla LED con sus gabinetes y el panel genera la Salida Avanzada de Resolume.

## Conceptos

- **Gabinete**: el módulo LED. Un P3.9 de 500×500 mm tiene 128×128 píxeles. Todo se mide en gabinetes, así los píxeles salen exactos.
- **Pieza**: un rectángulo de gabinetes con nombre ("Torre izquierda", 2×6). Una forma en "L" o "Γ" se arma con dos piezas (la torre y el brazo).
- **Escenario**: dónde está cada pieza vista desde el público. Define cómo se diseña el contenido.
- **Composición**: el tamaño de la composición de Resolume. Lo ideal es que mida igual que el escenario (botón *Usar tamaño exacto del escenario*): así nada se deforma. Si es distinta, el escenario se escala parejo para caber, centrado.
- **Salida**: dónde va cada pieza en la señal que recibe el procesador LED (por ejemplo una salida de 1920×1080). Cada pieza ocupa su tamaño real en píxeles. *Acomodar automático* las ordena sin encimarse; si el procesador ya está configurado, se ubican a mano donde él las espera.

## Uso

1. Pestaña **Pantallas → Nuevo diseño**. Elige el gabinete.
2. Agrega las piezas con su tamaño en gabinetes y acomódalas en **Escenario** (arrastrando o con números).
3. Ajusta la composición (recomendado: tamaño exacto del escenario) y en **Salida** acomoda las piezas.
4. **Guardar**.
5. **Plantilla para diseñar (PNG)**: imagen del tamaño de la composición con cada pieza marcada, para diseñar encima en Photoshop o After Effects.
6. **Enviar a Resolume**: el puente escribe el preset en `Documentos\Resolume Arena\Presets\Advanced Output\<nombre>.xml`. En Resolume: **Output → Advanced Output → Presets** y elige el nombre. Revisa que la composición (Composition → Settings) mida lo mismo que en el diseño.

El preset conserva la pantalla de salida (Display) y el soft edge que ya tenía Resolume. *Importar mapeo actual* muestra lo que Resolume tiene hoy.

### Reemplazar la Salida Avanzada directamente

Opción avanzada, solo con Resolume cerrado: reemplaza `Preferences\AdvancedOutput.xml` y deja una copia `AdvancedOutput.respaldo-<fecha>.xml` al lado. Al abrir Resolume ya carga los slices nuevos.

## Límites

- Las piezas son rectángulos sin rotación. Para formas libres o piezas giradas, ajustar a mano en Resolume después.
- Si la carpeta de Resolume no está en Documentos, define `RESOLUME_DOCS` en `panel-config.bat` con la ruta de la carpeta `Resolume Arena`.
