// Pruebas del generador de Salida Avanzada (pantallas armadas con gabinetes).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ScreenLayout } from "../shared/protocol.js";
import { buildAdvancedOutputXml, mapLayout, parseAdvancedOutput, parseScreenLayout, presetFileName, readAdvancedOutput, writeAdvancedOutput } from "../bridge/screens.js";

// Escenario tipo: torres en "Γ" a los lados (torre + brazo) y pantalla al centro. Gabinete 128×128.
const layout = (over: Partial<ScreenLayout> = {}): ScreenLayout => ({
  id: "escenario-1",
  name: "Escenario & prueba",
  cabinetLabel: "P3.9 500×500 mm",
  cabinetW: 128,
  cabinetH: 128,
  composition: { width: 1792, height: 768 },
  output: { width: 1920, height: 1080 },
  pieces: [
    { id: "a", name: "Torre izq", cols: 2, rows: 6, x: 0, y: 0, outX: 0, outY: 0 },
    { id: "b", name: "Brazo izq", cols: 2, rows: 1, x: 256, y: 0, outX: 256, outY: 0 },
    { id: "c", name: "Centro", cols: 6, rows: 3, x: 512, y: 0, outX: 512, outY: 0 },
    { id: "d", name: "Brazo der", cols: 2, rows: 1, x: 1280, y: 0, outX: 1280, outY: 0 },
    { id: "e", name: "Torre der", cols: 2, rows: 6, x: 1536, y: 0, outX: 1536, outY: 0 },
  ],
  updatedAt: 0,
  ...over,
});

// Salida Avanzada como la guarda Arena 7.28 (recortada).
const BASE = `<?xml version="1.0" encoding="utf-8"?>
<ScreenSetup name="ScreenSetup">
	<versionInfo name="Resolume Arena" majorVersion="7" minorVersion="28" microVersion="1" revision="26535"/>
	<CurrentCompositionTextureSize width="1280" height="720"/>
	<screens>
		<Screen name="Screen 1" uniqueId="1">
			<layers>
				<Slice uniqueId="2">
					<Params name="Common">
						<Param name="Name" T="STRING" default="Layer" value="Slice 5"/>
					</Params>
					<InputRect orientation="0">
						<v x="401.9" y="3.9"/><v x="883.9" y="3.9"/><v x="883.9" y="441.9"/><v x="401.9" y="441.9"/>
					</InputRect>
					<OutputRect orientation="0">
						<v x="545" y="0"/><v x="1379" y="0"/><v x="1379" y="426"/><v x="545" y="426"/>
					</OutputRect>
				</Slice>
				<Polygon uniqueId="3" IsVirgin="0">
					<Params name="Common">
						<Param name="Name" T="STRING" default="Layer" value="Polygon"/>
					</Params>
					<InputRect orientation="0">
						<v x="3.9" y="3.9"/><v x="389" y="3.9"/><v x="389" y="718"/><v x="3.9" y="718"/>
					</InputRect>
					<OutputRect orientation="0">
						<v x="0" y="0"/><v x="545" y="0"/><v x="545" y="1080"/><v x="0" y="1080"/>
					</OutputRect>
				</Polygon>
			</layers>
			<OutputDevice>
				<OutputDeviceDisplay name="Display 4" deviceId="abc" idHash="1" fullscreen="1" width="1920" height="1080"/>
			</OutputDevice>
		</Screen>
	</screens>
	<SoftEdging>
		<Params name="Soft Edge">
			<ParamRange name="Power" T="DOUBLE" default="2" value="1.5">
				<PhaseSourceStatic name="PhaseSourceStatic"/>
			</ParamRange>
		</Params>
	</SoftEdging>
</ScreenSetup>
`;

describe("pantallas", () => {
  it("valida diseños", () => {
    assert.equal(typeof parseScreenLayout(layout()), "object");
    assert.equal(parseScreenLayout({ ...layout(), pieces: [] }), "El diseño no tiene piezas");
    assert.equal(parseScreenLayout({ ...layout(), cabinetW: 0 }), "Tamaño de gabinete inválido");
    assert.equal(parseScreenLayout({ ...layout(), name: " " }), "Falta el nombre del diseño");
    assert.match(String(parseScreenLayout({ ...layout(), pieces: [{ cols: 0, rows: 1, x: 0, y: 0, outX: 0, outY: 0 }] })), /medidas inválidas/);
    const l = parseScreenLayout({ ...layout(), id: "" }) as ScreenLayout;
    assert.ok(l.id.length > 0, "genera id si viene vacío");
  });

  it("composición igual al escenario: 1:1", () => {
    const { scale, pieces } = mapLayout(layout());
    assert.equal(scale, 1);
    assert.deepEqual(pieces[2].input, { x: 512, y: 0, w: 768, h: 384 });
    assert.deepEqual(pieces[2].output, { x: 512, y: 0, w: 768, h: 384 });
  });

  it("composición distinta: escala uniforme y centrada", () => {
    // Escenario 1792×768 en 1280×720: manda el ancho (1280/1792), sobra alto arriba y abajo.
    const { scale, pieces } = mapLayout(layout({ composition: { width: 1280, height: 720 } }));
    assert.ok(Math.abs(scale - 1280 / 1792) < 1e-9);
    const torre = pieces[0].input;
    assert.equal(torre.x, 0);
    assert.ok(Math.abs(torre.y - (720 - 768 * scale) / 2) < 1e-9, "centrado vertical");
    assert.ok(Math.abs(torre.w - 256 * scale) < 1e-9);
    assert.deepEqual(pieces[0].output, { x: 0, y: 0, w: 256, h: 768 }, "la salida queda en píxeles reales");
  });

  it("el escenario puede empezar en cualquier coordenada", () => {
    const moved = layout({ pieces: layout().pieces.map((p) => ({ ...p, x: p.x + 500, y: p.y + 40 })) });
    assert.deepEqual(mapLayout(moved).pieces, mapLayout(layout()).pieces);
  });

  it("XML: conserva versión, pantalla de salida y soft edge; slices correctos", () => {
    const xml = buildAdvancedOutputXml(layout(), BASE);
    assert.match(xml, /minorVersion="28"/);
    assert.match(xml, /<OutputDeviceDisplay name="Display 4"[^>]*width="1920"/);
    assert.match(xml, /value="1.5"/, "soft edge de la base");
    assert.match(xml, /<CurrentCompositionTextureSize width="1792" height="768"\/>/);
    assert.match(xml, /value="Escenario &amp; prueba"/, "escapa el nombre");
    assert.equal(xml.match(/<Slice /g)?.length, 5);
    assert.equal(xml.match(/<Polygon /g), null, "no copia los slices viejos");
    // Etiquetas balanceadas.
    for (const tag of ["Slice", "InputRect", "OutputRect", "Warper", "BezierWarper", "Homography", "screens", "Screen", "layers"]) {
      const opens = xml.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
      assert.equal(opens, xml.split(`</${tag}>`).length - 1, `etiqueta ${tag} balanceada`);
    }
    // 16 vértices de bezier por slice, todos dentro del rectángulo de salida.
    assert.equal(xml.match(/<vertices>[\s\S]*?<\/vertices>/g)?.[0].match(/<v /g)?.length, 16);
    // Ids únicos.
    const ids = [...xml.matchAll(/uniqueId="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("XML: ida y vuelta con el lector", () => {
    const info = parseAdvancedOutput(buildAdvancedOutputXml(layout({ composition: { width: 1280, height: 720 } }), BASE));
    assert.deepEqual(info.composition, { width: 1280, height: 720 });
    assert.deepEqual(info.output, { name: "Display 4", width: 1920, height: 1080 });
    assert.deepEqual(info.slices.map((s) => s.name), ["Torre izq", "Brazo izq", "Centro", "Brazo der", "Torre der"]);
    assert.deepEqual(info.slices[4].output, { x: 1536, y: 0, w: 256, h: 768 });
    assert.equal(info.slices[4].input.x + info.slices[4].input.w, 1280);
  });

  it("lee la Salida Avanzada actual (incluye polígonos)", () => {
    const info = parseAdvancedOutput(BASE);
    assert.deepEqual(info.slices.map((s) => `${s.kind}:${s.name}`), ["slice:Slice 5", "polygon:Polygon"]);
    assert.deepEqual(info.slices[0].output, { x: 545, y: 0, w: 834, h: 426 });
  });

  it("sin base: XML válido sin pantalla de salida asignada", () => {
    const xml = buildAdvancedOutputXml(layout(), null);
    assert.doesNotMatch(xml, /<OutputDevice>/);
    assert.match(xml, /<SoftEdging>/);
  });

  it("nombres de preset seguros", () => {
    assert.equal(presetFileName('Boda: "Ana/Luis"'), "Boda AnaLuis");
    assert.equal(presetFileName("   "), "Pantalla");
    assert.equal(presetFileName("fin. "), "fin");
  });

  it("escribe el preset y reemplaza preferencias con respaldo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolume-docs-"));
    await mkdir(join(dir, "Preferences"));
    await writeFile(join(dir, "Preferences", "AdvancedOutput.xml"), BASE, "utf8");

    const info = await readAdvancedOutput(dir);
    assert.equal(info.found, true);
    assert.equal(info.slices.length, 2);

    const preset = await writeAdvancedOutput(layout(), "Mi escenario", "preset", dir);
    assert.equal(preset.path, join(dir, "Presets", "Advanced Output", "Mi escenario.xml"));
    assert.match(await readFile(preset.path, "utf8"), /Display 4/);

    const prefs = await writeAdvancedOutput(layout(), "x", "preferences", dir);
    assert.ok(prefs.backup);
    assert.equal(await readFile(prefs.backup!, "utf8"), BASE, "respaldo idéntico al original");
    assert.equal((await readAdvancedOutput(dir)).slices.length, 5);
    assert.equal((await readdir(join(dir, "Preferences"))).length, 2);
  });

  it("sin carpeta de Resolume: error claro", async () => {
    await assert.rejects(writeAdvancedOutput(layout(), "x", "preset", join(tmpdir(), "no-existe-resolume-xyz")), /No encontré la carpeta/);
    assert.equal((await readAdvancedOutput(join(tmpdir(), "no-existe-resolume-xyz"))).found, false);
  });
});
