// Validación defensiva de los mensajes entrantes. Devuelve null si la forma no es válida.
import type {
  BridgeToServer,
  ClientToServer,
  Command,
  CommandAction,
  EventState,
  LogEntry,
  NowPlaying,
} from "../shared/protocol.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isStr = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;

export const EVENT_ID_RE = /^[a-z0-9-]{1,64}$/;
const REQUEST_ID_MAX = 128;
const LOG_TEXT_MAX = 2000;
const SNAPSHOT_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isEventId(v: unknown): v is string {
  return typeof v === "string" && EVENT_ID_RE.test(v);
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Órdenes

const COMMAND_CHECKS: Record<CommandAction, (c: Obj) => boolean> = {
  triggerClip: (c) => isInt(c.clipId),
  triggerColumn: (c) => isInt(c.column) && c.column >= 1,
  clearLayer: (c) => isInt(c.layer) && c.layer >= 1,
  clearAll: () => true,
  setLayerOpacity: (c) => isInt(c.layer) && c.layer >= 1 && isNum(c.value) && c.value >= 0 && c.value <= 1,
  setMaster: (c) => isNum(c.value) && c.value >= 0 && c.value <= 1,
  setBpm: (c) => isNum(c.bpm) && c.bpm > 0 && c.bpm <= 1000,
  selectDeck: (c) => isInt(c.deckIndex) && c.deckIndex >= 1,
  saveAutomation: (c) => isObj(c.automation) && isStr(c.automation.id, 100) && isStr(c.automation.name, 200),
  deleteAutomation: (c) => isStr(c.id, 100) && c.id.length > 0,
  startAutomation: (c) => isStr(c.id, 100) && c.id.length > 0,
  stopAutomation: () => true,
  skipAutomation: () => true,
  getThumbnail: (c) => isInt(c.clipId),
  getSnapshot: () => true,
  saveScreenLayout: (c) => isObj(c.layout) && isStr(c.layout.name, 200) && Array.isArray(c.layout.pieces),
  deleteScreenLayout: (c) => isStr(c.id, 100),
  applyScreenLayout: (c) => isStr(c.id, 100) && isStr(c.presetName, 200) && (c.target === undefined || c.target === "preset" || c.target === "preferences"),
  readAdvancedOutput: () => true,
};

export function parseCommand(v: unknown): Command | null {
  if (!isObj(v) || typeof v.action !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_CHECKS, v.action)) return null;
  const check = COMMAND_CHECKS[v.action as CommandAction];
  return check(v) ? (v as unknown as Command) : null;
}

// ---------------------------------------------------------------- Web → servidor

export type ClientParse = { ok: true; msg: ClientToServer } | { ok: false; error: string };

export function parseClientMessage(v: unknown): ClientParse {
  if (!isObj(v) || typeof v.type !== "string") return { ok: false, error: "Mensaje inválido" };
  switch (v.type) {
    case "subscribe": {
      if (v.eventId !== null && !isEventId(v.eventId)) return { ok: false, error: "Evento inválido" };
      return { ok: true, msg: { type: "subscribe", eventId: v.eventId, snapshots: v.snapshots === true } };
    }
    case "command": {
      if (!isStr(v.requestId, REQUEST_ID_MAX) || v.requestId.length === 0) {
        return { ok: false, error: "Falta requestId" };
      }
      if (!isEventId(v.eventId)) return { ok: false, error: "Evento inválido" };
      const command = parseCommand(v.command);
      if (!command) return { ok: false, error: "Orden inválida" };
      return { ok: true, msg: { type: "command", requestId: v.requestId, eventId: v.eventId, command } };
    }
    default:
      return { ok: false, error: "Tipo de mensaje desconocido" };
  }
}

// ---------------------------------------------------------------- Puente → servidor

function parseState(v: unknown): EventState | null {
  if (!isObj(v)) return null;
  if (typeof v.resolumeOnline !== "boolean") return null;
  if (!Array.isArray(v.nowPlaying) || !Array.isArray(v.automations)) return null;
  if (v.composition !== null && !isObj(v.composition)) return null;
  if (v.runner !== null && !isObj(v.runner)) return null;
  if (v.resolume !== null && !isObj(v.resolume)) return null;
  if (!isNum(v.updatedAt)) return null;
  return v as unknown as EventState;
}

function parseLogEntry(v: unknown): LogEntry | null {
  if (!isObj(v)) return null;
  if (!isNum(v.at) || typeof v.by !== "string" || typeof v.text !== "string") return null;
  if (v.level !== "info" && v.level !== "warn" && v.level !== "error") return null;
  return { at: v.at, level: v.level, by: v.by.slice(0, 100), text: v.text.slice(0, LOG_TEXT_MAX) };
}

export function parseBridgeMessage(v: unknown): BridgeToServer | null {
  if (!isObj(v) || typeof v.type !== "string") return null;
  switch (v.type) {
    case "hello":
      if (!isStr(v.eventId, 64) || !isStr(v.name, 200) || !isStr(v.bridgeVersion, 50)) return null;
      return { type: "hello", eventId: v.eventId, name: v.name, bridgeVersion: v.bridgeVersion };
    case "state": {
      const state = parseState(v.state);
      return state ? { type: "state", state } : null;
    }
    case "snapshot": {
      if (typeof v.mime !== "string" || !SNAPSHOT_MIME.has(v.mime)) return null;
      if (typeof v.data !== "string" || v.data.length === 0 || !BASE64_RE.test(v.data)) return null;
      if (!isNum(v.at)) return null;
      return { type: "snapshot", mime: v.mime, data: v.data, at: v.at };
    }
    case "result": {
      if (!isStr(v.requestId, REQUEST_ID_MAX) || typeof v.ok !== "boolean") return null;
      const msg: BridgeToServer = { type: "result", requestId: v.requestId, ok: v.ok };
      if (typeof v.error === "string") msg.error = v.error.slice(0, LOG_TEXT_MAX);
      if (v.data !== undefined) msg.data = v.data;
      return msg;
    }
    case "log": {
      const entry = parseLogEntry(v.entry);
      return entry ? { type: "log", entry } : null;
    }
    default:
      return null;
  }
}

/** Extrae lo que suena de un estado, ignorando entradas mal formadas. */
export function cleanNowPlaying(list: unknown): NowPlaying[] {
  if (!Array.isArray(list)) return [];
  const out: NowPlaying[] = [];
  for (const n of list) {
    if (!isObj(n)) continue;
    if (!isInt(n.layer) || !isInt(n.column) || !isInt(n.clipId)) continue;
    out.push({
      layer: n.layer,
      layerName: typeof n.layerName === "string" ? n.layerName : "",
      column: n.column,
      clipId: n.clipId,
      name: typeof n.name === "string" ? n.name : "",
    });
  }
  return out;
}
