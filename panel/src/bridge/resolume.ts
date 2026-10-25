// Cliente HTTP del Webserver de Resolume y conversión de su JSON al estado del panel.

import type { ClipInfo, ClipState, CompositionInfo, NowPlaying } from "../shared/protocol.js";

export type Method = "GET" | "POST" | "PUT";

export interface ResolumeApi {
  /** Llama a `/api/v1{path}` y devuelve el JSON (o null si la respuesta viene vacía). */
  call(method: Method, path: string, body?: unknown): Promise<unknown>;
  /** GET de una imagen (miniatura o captura). */
  binary(path: string): Promise<{ mime: string; data: Buffer }>;
}

export function createResolumeApi(baseUrl: string, timeoutMs = 5000): ResolumeApi {
  const api = `${baseUrl.replace(/\/+$/, "")}/api/v1`;

  const request = async (method: Method, path: string, body?: unknown): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(`${api}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(networkMessage(e));
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Resolume respondió ${res.status} en ${method} ${path}`);
    }
    return res;
  };

  return {
    async call(method, path, body) {
      const res = await request(method, path, body);
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Resolume devolvió algo que no es JSON en ${method} ${path}`);
      }
    },
    async binary(path) {
      const res = await request("GET", path);
      const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      return { mime, data: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

function networkMessage(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "Resolume no respondió a tiempo";
  const detail = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
  return `No pude hablar con Resolume (${detail})`;
}

// ---------------------------------------------------------------- JSON de Resolume (solo lo que se usa)

export interface RParam {
  id?: number;
  value?: unknown;
  min?: number;
  max?: number;
}

export interface RClip {
  id?: number;
  name?: RParam;
  connected?: RParam;
  transport?: { position?: RParam } | null;
  video?: {
    fileinfo?: { width?: number; height?: number } | null;
    resize?: RParam;
    effects?: { name?: string; params?: Record<string, RParam | undefined> }[];
  } | null;
}

export interface RLayer {
  id?: number;
  name?: RParam;
  bypassed?: RParam;
  solo?: RParam;
  video?: { opacity?: RParam } | null;
  clips?: RClip[];
}

export interface RDeck {
  id?: number;
  name?: RParam;
  selected?: RParam;
}

export interface RComposition {
  name?: RParam;
  master?: RParam;
  video?: { width?: RParam; height?: RParam } | null;
  tempocontroller?: { tempo?: RParam };
  decks?: RDeck[];
  columns?: { id?: number; name?: RParam }[];
  layers?: RLayer[];
}

export interface RProduct {
  name?: string;
  major?: number;
  minor?: number;
  micro?: number;
}

// ---------------------------------------------------------------- Conversión

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
/** Resolume usa `#` en los nombres como comodín del número de capa/columna. */
const numbered = (name: string, n: number) => name.replace(/#/g, String(n));

export function clipStateOf(v: unknown): ClipState {
  switch (v) {
    case "Empty":
      return "empty";
    case "Previewing":
      return "previewing";
    case "Connected":
    case "Connected & previewing":
      return "connected";
    default:
      return "disconnected";
  }
}

/** true si es un archivo de video/imagen (tiene fileinfo). Fuentes como Video Router no lo tienen. */
export const isFileClip = (clip: RClip): boolean => !!clip.video?.fileinfo;

/** Duración efectiva en segundos (position.max ya incluye cambios de velocidad), o undefined. */
export function clipLengthS(clip: RClip): number | undefined {
  const max = clip.transport?.position?.max;
  return typeof max === "number" && Number.isFinite(max) && max > 0 ? max / 1000 : undefined;
}

export function clipName(clip: RClip): string {
  return str(clip.name?.value).trim() || "(sin nombre)";
}

export function mapClip(clip: RClip, column: number): ClipInfo {
  const state = clipStateOf(clip.connected?.value);
  const info: ClipInfo = {
    column,
    id: num(clip.id),
    name: state === "empty" ? str(clip.name?.value) : clipName(clip),
    state,
    isFile: isFileClip(clip),
  };
  const length = state === "empty" ? undefined : clipLengthS(clip);
  if (length !== undefined) info.durationS = length;
  return info;
}

export function mapComposition(raw: RComposition): { composition: CompositionInfo; nowPlaying: NowPlaying[] } {
  const layers = (raw.layers ?? []).map((l, i) => ({
    index: i + 1,
    id: num(l.id),
    name: numbered(str(l.name?.value), i + 1),
    opacity: num(l.video?.opacity?.value, 1),
    bypassed: l.bypassed?.value === true,
    solo: l.solo?.value === true,
    clips: (l.clips ?? []).map((c, j) => mapClip(c, j + 1)),
  }));
  const nowPlaying: NowPlaying[] = [];
  for (const l of layers) {
    for (const c of l.clips) {
      if (c.state === "connected") nowPlaying.push({ layer: l.index, layerName: l.name, column: c.column, clipId: c.id, name: c.name });
    }
  }
  return {
    composition: {
      name: str(raw.name?.value),
      bpm: num(raw.tempocontroller?.tempo?.value),
      master: num(raw.master?.value, 1),
      width: num(raw.video?.width?.value),
      height: num(raw.video?.height?.value),
      decks: (raw.decks ?? []).map((d, i) => ({ index: i + 1, id: num(d.id), name: str(d.name?.value), selected: d.selected?.value === true })),
      columns: (raw.columns ?? []).map((c, i) => ({ index: i + 1, name: numbered(str(c.name?.value), i + 1) })),
      layers,
    },
    nowPlaying,
  };
}

export function mapProduct(raw: RProduct): { product: string; version: string } {
  return { product: str(raw.name) || "Resolume", version: [raw.major, raw.minor, raw.micro].map((n) => num(n)).join(".") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Abre la pestaña `index` (1 = primera) y espera a que Resolume la marque como seleccionada.
 * `settleMs`: espera extra, porque justo después del cambio Resolume aún puede devolver los clips de la anterior.
 */
export async function selectDeckAndWait(api: ResolumeApi, index: number, settleMs: number, timeoutMs = 10000): Promise<void> {
  await api.call("POST", `/composition/decks/${index}/select`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(250);
    const comp = (await api.call("GET", "/composition").catch(() => null)) as RComposition | null;
    if (comp?.decks?.[index - 1]?.selected?.value === true) break;
    if (Date.now() > deadline) throw new Error("Resolume no abrió la pestaña a tiempo");
  }
  if (settleMs > 0) await sleep(settleMs);
}
