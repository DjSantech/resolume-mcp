// Pantallas: diseños de pantallas LED armadas con gabinetes y su conversión a la Salida Avanzada de Resolume.
// La Salida Avanzada no se puede tocar por la API: se escribe el XML que Resolume usa (formato de Arena 7.28),
// como preset en Presets/Advanced Output o, con Resolume cerrado, en Preferences/AdvancedOutput.xml.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdvancedOutputInfo, ScreenLayout, ScreenPiece } from "../shared/protocol.js";

// ---------------------------------------------------------------- Validación

const int = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 1_000_000 ? n : null;
};
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Valida un diseño que manda la web (o leído del disco). Devuelve el diseño limpio o un mensaje de error. */
export function parseScreenLayout(input: unknown): ScreenLayout | string {
  if (!input || typeof input !== "object") return "Diseño inválido";
  const a = input as Record<string, unknown>;

  let id = text(a.id, 64);
  if (!id) id = randomUUID();
  if (!/^[\w-]{1,64}$/.test(id)) return "Id de diseño inválido";
  const name = text(a.name, 80);
  if (!name) return "Falta el nombre del diseño";

  const cabinetW = int(a.cabinetW, 8, 4096), cabinetH = int(a.cabinetH, 8, 4096);
  if (!cabinetW || !cabinetH) return "Tamaño de gabinete inválido";

  const size = (v: unknown, what: string): { width: number; height: number } | string => {
    const o = (v ?? {}) as Record<string, unknown>;
    const width = int(o.width, 16, 32768), height = int(o.height, 16, 32768);
    return width && height ? { width, height } : `Tamaño de ${what} inválido`;
  };
  const composition = size(a.composition, "composición");
  if (typeof composition === "string") return composition;
  const output = size(a.output, "salida");
  if (typeof output === "string") return output;

  if (!Array.isArray(a.pieces) || a.pieces.length === 0) return "El diseño no tiene piezas";
  if (a.pieces.length > 300) return "Demasiadas piezas";
  const pieces: ScreenPiece[] = [];
  for (const raw of a.pieces) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const cols = int(p.cols, 1, 500), rows = int(p.rows, 1, 500);
    const x = num(p.x), y = num(p.y), outX = num(p.outX), outY = num(p.outY);
    if (!cols || !rows || x === null || y === null || outX === null || outY === null) return "Hay una pieza con medidas inválidas";
    pieces.push({
      id: text(p.id, 64) || randomUUID(),
      name: text(p.name, 60) || `Pieza ${pieces.length + 1}`,
      cols, rows, x, y, outX, outY,
    });
  }
  const updatedAt = Number.isFinite(Number(a.updatedAt)) ? Number(a.updatedAt) : Date.now();
  return { id, name, cabinetLabel: text(a.cabinetLabel, 60), cabinetW, cabinetH, pieces, composition, output, updatedAt };
}

// ---------------------------------------------------------------- Almacén (DATA_DIR/screens.json)

export class ScreenStore {
  private items: ScreenLayout[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly dir: string, private readonly warn: (text: string) => void) {
    this.path = join(dir, "screens.json");
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      const bad = `${this.path}.danado-${Date.now()}`;
      await rename(this.path, bad).catch(() => undefined);
      this.warn(`screens.json estaba dañado; lo aparté como ${bad}`);
      return;
    }
    const list = (data as { screens?: unknown })?.screens;
    for (const item of Array.isArray(list) ? list : []) {
      const l = parseScreenLayout(item);
      if (typeof l === "string") this.warn(`Ignoré un diseño de pantalla inválido: ${l}`);
      else if (!this.items.some((x) => x.id === l.id)) this.items.push(l);
    }
  }

  list(): ScreenLayout[] {
    return this.items.map((l) => ({ ...l, pieces: l.pieces.map((p) => ({ ...p })) }));
  }

  get(id: string): ScreenLayout | undefined {
    return this.items.find((l) => l.id === id);
  }

  async save(l: ScreenLayout): Promise<void> {
    const i = this.items.findIndex((x) => x.id === l.id);
    if (i >= 0) this.items[i] = l;
    else this.items.push(l);
    await this.persist();
  }

  async remove(id: string): Promise<ScreenLayout | undefined> {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [removed] = this.items.splice(i, 1);
    await this.persist();
    return removed;
  }

  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, screens: this.items }, null, 2);
    const next = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      await writeFile(tmp, snapshot, "utf8");
      try {
        await rename(tmp, this.path);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
    });
    this.writing = next;
    return next;
  }
}

// ---------------------------------------------------------------- Geometría

export interface Rect { x: number; y: number; w: number; h: number }

export interface MappedPiece { name: string; input: Rect; output: Rect }

/** Escenario → composición: el escenario se escala uniforme para caber en la composición, centrado. Salida 1:1 en píxeles. */
export function mapLayout(layout: ScreenLayout): { scale: number; pieces: MappedPiece[] } {
  const cw = layout.cabinetW, ch = layout.cabinetH;
  const rects = layout.pieces.map((p) => ({ p, w: p.cols * cw, h: p.rows * ch }));
  const minX = Math.min(...rects.map((r) => r.p.x)), minY = Math.min(...rects.map((r) => r.p.y));
  const maxX = Math.max(...rects.map((r) => r.p.x + r.w)), maxY = Math.max(...rects.map((r) => r.p.y + r.h));
  const stageW = maxX - minX, stageH = maxY - minY;
  const { width: compW, height: compH } = layout.composition;
  const scale = Math.min(compW / stageW, compH / stageH);
  const offX = (compW - stageW * scale) / 2, offY = (compH - stageH * scale) / 2;
  return {
    scale,
    pieces: rects.map(({ p, w, h }) => ({
      name: p.name,
      input: { x: offX + (p.x - minX) * scale, y: offY + (p.y - minY) * scale, w: w * scale, h: h * scale },
      output: { x: p.outX, y: p.outY, w, h },
    })),
  };
}

// ---------------------------------------------------------------- XML de la Salida Avanzada

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v: number) => String(Math.round(v * 1000) / 1000);
const v = (x: number, y: number, tabs: string) => `${tabs}<v x="${n(x)}" y="${n(y)}"/>`;
const quad = (r: Rect, tabs: string) =>
  [v(r.x, r.y, tabs), v(r.x + r.w, r.y, tabs), v(r.x + r.w, r.y + r.h, tabs), v(r.x, r.y + r.h, tabs)].join("\n");

let lastId = 0;
/** Ids únicos con la forma que usa Resolume (milisegundos). */
function uniqueId(): number {
  lastId = Math.max(Date.now(), lastId + 1);
  return lastId;
}

function sliceXml(m: MappedPiece): string {
  const o = m.output;
  const grid: string[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) grid.push(v(o.x + (o.w * col) / 3, o.y + (o.h * row) / 3, "\t\t\t\t\t\t\t\t\t"));
  return `\t\t\t\t<Slice uniqueId="${uniqueId()}">
\t\t\t\t\t<Params name="Common">
\t\t\t\t\t\t<Param name="Name" T="STRING" default="Layer" value="${esc(m.name)}"/>
\t\t\t\t\t</Params>
\t\t\t\t\t<InputRect orientation="0">
${quad(m.input, "\t\t\t\t\t\t")}
\t\t\t\t\t</InputRect>
\t\t\t\t\t<OutputRect orientation="0">
${quad(o, "\t\t\t\t\t\t")}
\t\t\t\t\t</OutputRect>
\t\t\t\t\t<Warper>
\t\t\t\t\t\t<BezierWarper controlWidth="4" controlHeight="4">
\t\t\t\t\t\t\t<vertices>
${grid.join("\n")}
\t\t\t\t\t\t\t</vertices>
\t\t\t\t\t\t</BezierWarper>
\t\t\t\t\t\t<Homography>
\t\t\t\t\t\t\t<src>
${quad(o, "\t\t\t\t\t\t\t\t")}
\t\t\t\t\t\t\t</src>
\t\t\t\t\t\t\t<dst>
${quad(o, "\t\t\t\t\t\t\t\t")}
\t\t\t\t\t\t\t</dst>
\t\t\t\t\t\t</Homography>
\t\t\t\t\t</Warper>
\t\t\t\t</Slice>`;
}

const DEFAULT_VERSION = `<versionInfo name="Resolume Arena" majorVersion="7" minorVersion="28" microVersion="1" revision="26535"/>`;
const DEFAULT_SOFT_EDGE = `<SoftEdging>
\t\t<Params name="Soft Edge">
\t\t\t<ParamRange name="Power" T="DOUBLE" default="2" value="2">
\t\t\t\t<PhaseSourceStatic name="PhaseSourceStatic"/>
\t\t\t</ParamRange>
\t\t</Params>
\t</SoftEdging>`;

/**
 * Arma el XML completo. De `baseXml` (la Salida Avanzada actual) conserva la versión, la pantalla de salida
 * asignada (OutputDevice) y el soft edge, para que el preset salga por la misma pantalla que ya usa.
 */
export function buildAdvancedOutputXml(layout: ScreenLayout, baseXml?: string | null): string {
  const { pieces } = mapLayout(layout);
  const version = baseXml?.match(/<versionInfo\b[^>]*\/>/)?.[0] ?? DEFAULT_VERSION;
  const device = baseXml?.match(/<OutputDevice>[\s\S]*?<\/OutputDevice>/)?.[0];
  const soft = baseXml?.match(/<SoftEdging>[\s\S]*?<\/SoftEdging>/)?.[0] ?? DEFAULT_SOFT_EDGE;
  return `<?xml version="1.0" encoding="utf-8"?>
<ScreenSetup name="ScreenSetup">
\t${version}
\t<CurrentCompositionTextureSize width="${layout.composition.width}" height="${layout.composition.height}"/>
\t<screens>
\t\t<Screen name="Screen 1" uniqueId="${uniqueId()}">
\t\t\t<Params name="Params">
\t\t\t\t<Param name="Name" T="STRING" default="" value="${esc(layout.name)}"/>
\t\t\t</Params>
\t\t\t<guides>
\t\t\t\t<ScreenGuide name="ScreenGuide" type="0"/>
\t\t\t\t<ScreenGuide name="ScreenGuide" type="1"/>
\t\t\t</guides>
\t\t\t<layers>
${pieces.map(sliceXml).join("\n")}
\t\t\t</layers>
${device ? `\t\t\t${device}\n` : ""}\t\t</Screen>
\t</screens>
\t${soft}
</ScreenSetup>
`;
}

// ---------------------------------------------------------------- Lectura de la Salida Avanzada actual

function rectOf(block: string, tag: string): Rect {
  const inner = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
  const pts = [...inner.matchAll(/<v x="([-\d.e+]+)" y="([-\d.e+]+)"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const r = (k: number) => Math.round(k * 10) / 10;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: r(x), y: r(y), w: r(Math.max(...xs) - x), h: r(Math.max(...ys) - y) };
}

export function parseAdvancedOutput(xml: string): Omit<AdvancedOutputInfo, "found" | "resolumeDir"> {
  const comp = xml.match(/<CurrentCompositionTextureSize\b[^>]*width="(\d+)"[^>]*height="(\d+)"/);
  const dev = xml.match(/<OutputDevice\w*\b[^>]*name="([^"]*)"[^>]*width="(\d+)"[^>]*height="(\d+)"/);
  const slices: AdvancedOutputInfo["slices"] = [];
  for (const m of xml.matchAll(/<(Slice|Polygon)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const name = m[2].match(/<Param name="Name"[^>]*value="([^"]*)"/)?.[1] ?? m[1];
    slices.push({ name, kind: m[1] === "Polygon" ? "polygon" : "slice", input: rectOf(m[2], "InputRect"), output: rectOf(m[2], "OutputRect") });
  }
  return {
    composition: comp ? { width: Number(comp[1]), height: Number(comp[2]) } : null,
    output: dev ? { name: dev[1], width: Number(dev[2]), height: Number(dev[3]) } : null,
    slices,
  };
}

// ---------------------------------------------------------------- Carpeta de Resolume

const exists = (p: string) => stat(p).then(() => true, () => false);

let myDocs: Promise<string | null> | null = null;
/** Carpeta Documentos real de Windows (puede estar en OneDrive y con otro nombre). */
function windowsDocuments(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  myDocs ??= new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { timeout: 8000, windowsHide: true }, (err, out) =>
      resolve(err ? null : out.trim() || null),
    );
  });
  return myDocs;
}

/** Busca la carpeta "Resolume Arena" (la de Preferences y Presets). `override` = RESOLUME_DOCS. */
export async function findResolumeDir(override?: string): Promise<string | null> {
  if (override) return (await exists(override)) ? override : null;
  const home = homedir();
  const docs = await windowsDocuments();
  const candidates = [
    docs && join(docs, "Resolume Arena"),
    join(home, "Documents", "Resolume Arena"),
    join(home, "OneDrive", "Documents", "Resolume Arena"),
    join(home, "OneDrive", "Documentos", "Resolume Arena"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (await exists(join(c, "Preferences"))) return c;
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

export async function readAdvancedOutput(override?: string): Promise<AdvancedOutputInfo> {
  const dir = await findResolumeDir(override);
  if (!dir) return { found: false, resolumeDir: null, composition: null, output: null, slices: [] };
  const xml = await readFile(join(dir, "Preferences", "AdvancedOutput.xml"), "utf8").catch(() => null);
  if (xml === null) return { found: false, resolumeDir: dir, composition: null, output: null, slices: [] };
  return { found: true, resolumeDir: dir, ...parseAdvancedOutput(xml) };
}

/** Nombre de archivo seguro para el preset. */
export function presetFileName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
  return clean || "Pantalla";
}

/**
 * Escribe la Salida Avanzada del diseño. "preset": Presets/Advanced Output/<nombre>.xml.
 * "preferences": reemplaza Preferences/AdvancedOutput.xml dejando una copia de respaldo al lado.
 */
export async function writeAdvancedOutput(
  layout: ScreenLayout,
  presetName: string,
  target: "preset" | "preferences",
  override?: string,
): Promise<{ path: string; slices: number; backup?: string }> {
  const dir = await findResolumeDir(override);
  if (!dir) throw new Error("No encontré la carpeta Documentos\\Resolume Arena en el PC del puente. Configura RESOLUME_DOCS con su ruta.");
  const prefs = join(dir, "Preferences", "AdvancedOutput.xml");
  const base = await readFile(prefs, "utf8").catch(() => null);
  const xml = buildAdvancedOutputXml(layout, base);

  if (target === "preferences") {
    await mkdir(join(dir, "Preferences"), { recursive: true });
    let backup: string | undefined;
    if (base !== null) {
      backup = join(dir, "Preferences", `AdvancedOutput.respaldo-${new Date().toISOString().replace(/[:.]/g, "-")}.xml`);
      await copyFile(prefs, backup);
    }
    await writeFile(prefs, xml, "utf8");
    return { path: prefs, slices: layout.pieces.length, backup };
  }
  const folder = join(dir, "Presets", "Advanced Output");
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${presetFileName(presetName)}.xml`);
  await writeFile(path, xml, "utf8");
  return { path, slices: layout.pieces.length };
}
