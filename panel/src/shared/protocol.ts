// Contrato de mensajes entre el puente (PC del evento), el servidor (nube o local) y la web.
// Todos los mensajes viajan como JSON por WebSocket. Índices de capa/columna/pestaña empiezan en 1.

// ---------------------------------------------------------------- Estado de un evento

export type ClipState = "empty" | "disconnected" | "previewing" | "connected";

export interface ClipInfo {
  column: number;
  id: number;
  name: string;
  state: ClipState;
  /** Duración efectiva en segundos (transport.position.max / 1000). Ausente en clips vacíos. */
  durationS?: number;
  /** true si es un archivo de video/imagen (se puede ajustar Fill/Fit). false para fuentes y efectos. */
  isFile: boolean;
}

export interface LayerInfo {
  index: number;
  id: number;
  name: string;
  /** Opacidad de la capa, 0 a 1 (layer.video.opacity). */
  opacity: number;
  bypassed: boolean;
  solo: boolean;
  clips: ClipInfo[];
}

export interface DeckInfo {
  index: number;
  id: number;
  name: string;
  selected: boolean;
}

export interface CompositionInfo {
  name: string;
  bpm: number;
  /** Master de la composición, 0 a 1. */
  master: number;
  width: number;
  height: number;
  decks: DeckInfo[];
  columns: { index: number; name: string }[];
  /** Capas de la pestaña abierta. */
  layers: LayerInfo[];
}

export interface NowPlaying {
  layer: number;
  layerName: string;
  column: number;
  clipId: number;
  name: string;
}

export interface AutomationClip {
  clipId: number;
  column: number;
  name: string;
}

export interface Automation {
  id: string;
  name: string;
  /** Pestaña a abrir al arrancar. Vacío = la que esté abierta. */
  deckName: string;
  layer: number;
  /** Clips a recorrer en este orden. Vacío = todos los clips cargados en la capa (se relee en cada vuelta). */
  clips: AutomationClip[];
  minSeconds: number;
  maxSeconds: number;
  order: "sequential" | "shuffle";
  /** Ajustar Fill/Fit y escala 100% antes de lanzar cada clip. */
  fit: boolean;
  updatedAt: number;
}

export interface RunnerState {
  automationId: string;
  automationName: string;
  startedAt: number;
  /** Clip que está sonando por la automatización. */
  current: { clipId: number; column: number; name: string; startedAt: number; until: number; how: string } | null;
  /** Siguiente clip previsto (puede cambiar si la lista se relee). */
  next: { clipId: number; column: number; name: string } | null;
  loops: number;
}

// ---------------------------------------------------------------- Pantallas (mapeo de Salida Avanzada)
// Una pantalla LED armada con gabinetes. Cada pieza es un rectángulo de gabinetes: una forma en "L" o "Γ" son dos piezas.

export interface ScreenPiece {
  id: string;
  name: string;
  /** Tamaño en gabinetes. */
  cols: number;
  rows: number;
  /** Posición en el escenario (cómo se ve afuera), en píxeles reales desde la esquina superior izquierda. */
  x: number;
  y: number;
  /** Posición en la salida (lo que recibe el procesador LED), en píxeles. El tamaño en la salida es cols×cabinetW por rows×cabinetH. */
  outX: number;
  outY: number;
}

export interface ScreenLayout {
  id: string;
  name: string;
  /** Texto del gabinete, p. ej. "P3.9 500×500 mm". */
  cabinetLabel: string;
  /** Píxeles por gabinete. */
  cabinetW: number;
  cabinetH: number;
  pieces: ScreenPiece[];
  /** Tamaño de la composición de Resolume. El escenario se escala para caber, centrado. Si es igual al escenario, 1:1. */
  composition: { width: number; height: number };
  /** Tamaño de la salida (la pantalla/tarjeta que va al procesador LED). */
  output: { width: number; height: number };
  updatedAt: number;
}

/** Resumen de la Salida Avanzada que Resolume tiene guardada (Preferences/AdvancedOutput.xml). */
export interface AdvancedOutputInfo {
  found: boolean;
  /** Carpeta "Resolume Arena" usada (en el PC del puente). */
  resolumeDir: string | null;
  composition: { width: number; height: number } | null;
  output: { name: string; width: number; height: number } | null;
  slices: { name: string; kind: "slice" | "polygon"; input: { x: number; y: number; w: number; h: number }; output: { x: number; y: number; w: number; h: number } }[];
}

export interface EventState {
  /** true si el puente puede hablar con Resolume. */
  resolumeOnline: boolean;
  resolume: { product: string; version: string } | null;
  composition: CompositionInfo | null;
  nowPlaying: NowPlaying[];
  automations: Automation[];
  runner: RunnerState | null;
  /** Diseños de pantalla guardados en el puente. Ausente en puentes viejos. */
  screens?: ScreenLayout[];
  updatedAt: number;
}

export interface EventSummary {
  eventId: string;
  name: string;
  /** El puente está conectado al servidor. */
  online: boolean;
  resolumeOnline: boolean;
  lastSeen: number;
  nowPlaying: NowPlaying[];
  runner: { automationName: string; current: string | null } | null;
}

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  /** Quién hizo la acción ("Santiago", "automatización", "puente"). */
  by: string;
  text: string;
}

// ---------------------------------------------------------------- Órdenes

export type Command =
  | { action: "triggerClip"; clipId: number }
  | { action: "triggerColumn"; column: number }
  | { action: "clearLayer"; layer: number }
  | { action: "clearAll" }
  | { action: "setLayerOpacity"; layer: number; value: number }
  | { action: "setMaster"; value: number }
  | { action: "setBpm"; bpm: number }
  | { action: "selectDeck"; deckIndex: number }
  | { action: "saveAutomation"; automation: Omit<Automation, "updatedAt"> }
  | { action: "deleteAutomation"; id: string }
  | { action: "startAutomation"; id: string }
  | { action: "stopAutomation" }
  | { action: "skipAutomation" }
  /** Devuelve { mime, data(base64) } en el resultado. Permitido también para observadores. */
  | { action: "getThumbnail"; clipId: number }
  /** Una captura de la salida bajo demanda. Devuelve { mime, data(base64), at }. Permitido para observadores. */
  | { action: "getSnapshot" }
  | { action: "saveScreenLayout"; layout: Omit<ScreenLayout, "updatedAt"> }
  | { action: "deleteScreenLayout"; id: string }
  /**
   * Genera la Salida Avanzada del diseño. target "preset" (por defecto): la guarda como preset en
   * Presets/Advanced Output/<presetName>.xml para elegirla en Resolume. target "preferences": reemplaza
   * Preferences/AdvancedOutput.xml (con copia de respaldo); solo con Resolume cerrado.
   * Devuelve { path, slices }.
   */
  | { action: "applyScreenLayout"; id: string; presetName: string; target?: "preset" | "preferences" }
  /** Lee la Salida Avanzada actual de Resolume. Devuelve AdvancedOutputInfo. Permitido para observadores. */
  | { action: "readAdvancedOutput" };

export type CommandAction = Command["action"];

/** Órdenes que puede mandar un observador (solo lectura). */
export const VIEWER_ACTIONS: readonly CommandAction[] = ["getThumbnail", "getSnapshot", "readAdvancedOutput"];

// ---------------------------------------------------------------- Puente ⇄ Servidor
// El puente se conecta a  /ws/bridge?event=<eventId>&name=<nombre>&token=<BRIDGE_TOKEN>

export type BridgeToServer =
  | { type: "hello"; eventId: string; name: string; bridgeVersion: string }
  | { type: "state"; state: EventState }
  | { type: "snapshot"; mime: string; data: string; at: number }
  | { type: "result"; requestId: string; ok: boolean; error?: string; data?: unknown }
  | { type: "log"; entry: LogEntry };

export type ServerToBridge =
  | { type: "command"; requestId: string; command: Command; by: string }
  /** Si alguien está mirando la vista en vivo; el puente solo manda capturas cuando es true. */
  | { type: "watch"; snapshots: boolean };

// ---------------------------------------------------------------- Web ⇄ Servidor
// La web hace POST /api/login {name, code} → {token, role, name}
// y se conecta a /ws/client?token=<token>

export type Role = "admin" | "viewer";

export type ClientToServer =
  /** Elegir el evento que se está mirando (null = solo la lista). */
  | { type: "subscribe"; eventId: string | null; snapshots: boolean }
  | { type: "command"; requestId: string; eventId: string; command: Command };

export type ServerToClient =
  | { type: "welcome"; role: Role; name: string }
  | { type: "events"; events: EventSummary[] }
  | { type: "state"; eventId: string; state: EventState }
  | { type: "snapshot"; eventId: string; mime: string; data: string; at: number }
  | { type: "result"; requestId: string; ok: boolean; error?: string; data?: unknown }
  | { type: "log"; eventId: string; entry: LogEntry }
  /** Historial reciente al suscribirse a un evento. */
  | { type: "logs"; eventId: string; entries: LogEntry[] }
  | { type: "error"; message: string };
