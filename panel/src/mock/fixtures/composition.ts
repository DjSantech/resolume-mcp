// Composición de ejemplo para el simulador de Resolume.
// Misma forma que el JSON real de Arena 7.28 (GET /api/v1/composition), recortada y con nombres genéricos.
// Se arma con funciones para que los ids sean únicos y deterministas.

export interface Param {
  id: number;
  valuetype: string;
  value: unknown;
  min?: number;
  max?: number;
  in?: number;
  out?: number;
  index?: number;
  options?: string[];
}

export interface EffectJson {
  id: number;
  is_user_removable: boolean;
  name: string;
  display_name: string;
  params: Record<string, Param>;
}

export interface ClipJson {
  id: number;
  name: Param;
  colorid: Param;
  selected: Param;
  connected: Param;
  transporttype: Param;
  transport: { position: Param; controls: Record<string, Param> } | null;
  audio: null;
  video: {
    width: Param;
    height: Param;
    opacity: Param;
    mixer: Record<string, Param>;
    effects: EffectJson[];
    description: string;
    fileinfo?: {
      path: string;
      exists: boolean;
      format: string;
      duration: string;
      duration_ms: number;
      framerate: { num: number; denom: number };
      width: number;
      height: number;
    };
    resize: Param;
    sourceparams: Record<string, Param> | null;
  } | null;
  thumbnail: { last_update: string; is_default: boolean; id: number; path: string };
}

export interface LayerJson {
  id: number;
  name: Param;
  colorid: Param;
  selected: Param;
  bypassed: Param;
  solo: Param;
  master: Param;
  video: { width: Param; height: Param; opacity: Param; mixer: Record<string, Param>; effects: EffectJson[] };
  transition: { duration: Param };
  clips: ClipJson[];
}

export interface DeckJson {
  id: number;
  closed: boolean;
  name: Param;
  colorid: Param;
  selected: Param;
  scrollx: Param;
}

export interface ColumnJson {
  id: number;
  name: Param;
  colorid: Param;
  connected: Param;
  selected: Param;
}

export interface CompositionJson {
  name: Param;
  description: Param;
  selected: Param;
  bypassed: Param;
  master: Param;
  speed: Param;
  video: { width: Param; height: Param; opacity: Param; mixer: null; effects: EffectJson[] };
  crossfader: { id: number; phase: Param };
  decks: DeckJson[];
  layers: LayerJson[];
  columns: ColumnJson[];
  layergroups: unknown[];
  tempocontroller: { tempo: Param; play_state: Param };
}

export interface Fixture {
  /** Composición sin clips: `layers[i].clips` lo rellena el simulador con los de la pestaña abierta. */
  composition: CompositionJson;
  /** Clips por pestaña: `deckClips[deck][layer][column]`. */
  deckClips: ClipJson[][][];
  product: { name: string; major: number; minor: number; micro: number; revision: number };
  monitors: { id: number; name: string; associated_object: string | null }[];
}

type ClipSpec =
  | { kind: "file"; name: string; width: number; height: number; lengthMs: number; resize?: string; scale?: number }
  | { kind: "source"; name: string; lengthMs: number }
  | { kind: "empty" };

export const CLIP_STATES = ["Empty", "Disconnected", "Previewing", "Connected", "Connected & previewing"];
export const RESIZE_OPTIONS = ["Fill", "Fit", "Stretch", "Original"];

const COLUMNS = 4;

const empty: ClipSpec = { kind: "empty" };
const file = (name: string, width: number, height: number, lengthMs: number, scale = 100): ClipSpec =>
  ({ kind: "file", name, width, height, lengthMs, resize: "Original", scale });

/** Pestañas de ejemplo. Cada una tiene 3 capas × 4 columnas. */
const DECKS: { name: string; layers: ClipSpec[][] }[] = [
  {
    name: "Fiesta",
    layers: [
      [
        file("Tunnel Neon", 960, 540, 20053.333, 50),
        file("Gold Particles", 1920, 1080, 40080),
        file("Flores Vertical", 1080, 1920, 10000),
        empty,
      ],
      [{ kind: "source", name: "Video Router", lengthMs: 10000 }, empty, file("Laser Grid", 1280, 720, 8008), empty],
      [empty, empty, empty, file("Logo Loop", 1024, 768, 16650)],
    ],
  },
  {
    name: "Protocolo",
    layers: [
      [file("Cortina Azul", 1920, 1080, 30000), file("Brillo Suave", 1280, 720, 15000), empty, empty],
      [empty, empty, empty, empty],
      [empty, empty, empty, empty],
    ],
  },
];

export function buildFixture(): Fixture {
  let next = 1800000000000;
  const id = () => next++;

  const str = (value: string): Param => ({ valuetype: "ParamString", id: id(), value });
  const bool = (value: boolean): Param => ({ valuetype: "ParamBoolean", id: id(), value });
  const trigger = (value: boolean): Param => ({ id: id(), valuetype: "ParamTrigger", value });
  const range = (value: number, min: number, max: number): Param =>
    ({ id: id(), valuetype: "ParamRange", min, max, in: min, out: max, value });
  const choice = (value: string, options: string[]): Param =>
    ({ id: id(), valuetype: "ParamChoice", value, index: options.indexOf(value), options });
  const state = (value: string): Param =>
    ({ value, valuetype: "ParamState", options: CLIP_STATES, index: CLIP_STATES.indexOf(value), id: id() });

  const transform = (scale: number): EffectJson => ({
    id: id(),
    is_user_removable: false,
    name: "Transform",
    display_name: "Transform",
    params: {
      "Position X": range(0, -32768, 32768),
      "Position Y": range(0, -32768, 32768),
      Scale: range(scale, 0, 1000),
      "Scale W": range(100, 0, 1000),
      "Scale H": range(100, 0, 1000),
      "Rotation Z": range(0, -180, 180),
    },
  });

  const fmtDuration = (ms: number) => {
    const s = ms / 1000;
    return `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
  };

  const clip = (spec: ClipSpec): ClipJson => {
    const clipId = id();
    const base = {
      id: clipId,
      name: str(spec.kind === "empty" ? "" : spec.name),
      colorid: choice("1", ["1", "2", "3", "4", "5", "6"]),
      selected: trigger(false),
      connected: state(spec.kind === "empty" ? "Empty" : "Disconnected"),
      transporttype: choice("Timeline", ["Timeline", "BPM Sync", "SMPTE 1", "SMPTE 2", "Denon DJ", "Pioneer DJ"]),
      audio: null,
      thumbnail: {
        last_update: spec.kind === "empty" ? "0" : "1",
        is_default: spec.kind === "empty",
        id: clipId,
        path: spec.kind === "empty" ? "/api/v1/composition/thumbnail/dummy" : `/api/v1/composition/clips/by-id/${clipId}/thumbnail`,
      },
    };
    if (spec.kind === "empty") return { ...base, transport: null, video: null };

    const transport = {
      position: range(0, 0, spec.lengthMs),
      controls: {
        playmode: choice("Loop", ["Loop", "Bounce", "Random", "Play Once & Clear", "Play Once & Hold"]),
        speed: range(1, 0, 10),
        duration: range(spec.lengthMs / 1000, 0.001, 604800),
      },
    };
    const w = spec.kind === "file" ? spec.width : 1920;
    const h = spec.kind === "file" ? spec.height : 1080;
    const video: NonNullable<ClipJson["video"]> = {
      width: range(w, 0, 32768),
      height: range(h, 0, 32768),
      opacity: range(1, 0, 1),
      mixer: { "Blend Mode": choice("Layer Determined", ["Layer Determined", "Add", "Alpha"]) },
      effects: [transform(spec.kind === "file" ? spec.scale ?? 100 : 100)],
      description: spec.kind === "file"
        ? `${spec.name}.mov\nDXV 3.0 Normal Quality, No Alpha, ${w}x${h}, 25.00 Fps\n${fmtDuration(spec.lengthMs)}`
        : spec.name,
      resize: choice(spec.kind === "file" ? spec.resize ?? "Original" : "Fill", RESIZE_OPTIONS),
      sourceparams: spec.kind === "source" ? { Input: choice("Layer 1", ["Layer 1", "Layer 2", "Layer 3"]) } : null,
    };
    if (spec.kind === "file") {
      video.fileinfo = {
        path: `D:\\Videos\\${spec.name}.mov`,
        exists: true,
        format: "DXV 3.0 Normal Quality, No Alpha",
        duration: fmtDuration(spec.lengthMs),
        duration_ms: spec.lengthMs,
        framerate: { num: 25, denom: 1 },
        width: spec.width,
        height: spec.height,
      };
    }
    return { ...base, transport, video };
  };

  const compWidth = 1920, compHeight = 1080;
  const layerCount = DECKS[0].layers.length;

  const layers: LayerJson[] = Array.from({ length: layerCount }, () => ({
    id: id(),
    name: str("Capa #"),
    colorid: choice("1", ["1", "2", "3", "4", "5", "6"]),
    selected: trigger(false),
    bypassed: bool(false),
    solo: bool(false),
    master: range(1, 0, 1),
    video: {
      width: range(compWidth, 0, 32768),
      height: range(compHeight, 0, 32768),
      opacity: range(1, 0, 1),
      mixer: { "Blend Mode": choice("Add", ["Add", "Alpha", "Screen"]) },
      effects: [transform(100)],
    },
    transition: { duration: range(0, 0, 10) },
    clips: [],
  }));
  layers[0].selected.value = true;

  const decks: DeckJson[] = DECKS.map((d, i) => ({
    id: id(),
    closed: false,
    name: str(d.name),
    colorid: choice("1", ["1", "2", "3", "4", "5", "6"]),
    selected: trigger(i === 0),
    scrollx: { valuetype: "ParamNumber", id: id(), value: 0 },
  }));

  const columns: ColumnJson[] = Array.from({ length: COLUMNS }, () => ({
    id: id(),
    name: str("Columna #"),
    colorid: choice("1", ["1", "2", "3", "4", "5", "6"]),
    connected: state("Disconnected"),
    selected: trigger(false),
  }));

  const deckClips = DECKS.map((d) => d.layers.map((specs) => specs.map(clip)));

  const composition: CompositionJson = {
    name: str("Evento Demo"),
    description: str(""),
    selected: trigger(false),
    bypassed: bool(false),
    master: range(1, 0, 1),
    speed: range(1, 0, 10),
    video: { width: range(compWidth, 0, 32768), height: range(compHeight, 0, 32768), opacity: range(1, 0, 1), mixer: null, effects: [] },
    crossfader: { id: 1, phase: range(0, -1, 1) },
    decks,
    layers,
    columns,
    layergroups: [],
    tempocontroller: { tempo: range(128, 20, 500), play_state: choice("Play", ["Play", "Pause"]) },
  };

  const monitors: Fixture["monitors"] = [
    { id: 1, name: "Composition", associated_object: null },
    { id: 2, name: "Preview", associated_object: null },
    { id: 11, name: "Result", associated_object: null },
    ...layers.map((l, i) => ({ id: 268435456 * (i + 1), name: `Capa ${i + 1}`, associated_object: `/composition/layers/by-id/${l.id}` })),
  ];

  return {
    composition,
    deckClips,
    product: { name: "Arena", major: 7, minor: 28, micro: 1, revision: 10000 },
    monitors,
  };
}
