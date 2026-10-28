// Estado de la app en memoria y un bus de avisos mínimo.

import { ClockSync } from "./util.js";

/**
 * Tipos (copiados de src/shared/protocol.ts, solo como referencia):
 * @typedef {"empty"|"disconnected"|"previewing"|"connected"} ClipState
 * @typedef {{column:number,id:number,name:string,state:ClipState,durationS?:number,isFile:boolean}} ClipInfo
 * @typedef {{index:number,id:number,name:string,opacity:number,bypassed:boolean,solo:boolean,clips:ClipInfo[]}} LayerInfo
 * @typedef {{index:number,id:number,name:string,selected:boolean}} DeckInfo
 * @typedef {{name:string,bpm:number,master:number,width:number,height:number,decks:DeckInfo[],columns:{index:number,name:string}[],layers:LayerInfo[]}} CompositionInfo
 * @typedef {{layer:number,layerName:string,column:number,clipId:number,name:string}} NowPlaying
 * @typedef {{clipId:number,column:number,name:string}} AutomationClip
 * @typedef {{id:string,name:string,deckName:string,layer:number,clips:AutomationClip[],minSeconds:number,maxSeconds:number,order:"sequential"|"shuffle",fit:boolean,updatedAt:number}} Automation
 * @typedef {{automationId:string,automationName:string,startedAt:number,current:{clipId:number,column:number,name:string,startedAt:number,until:number,how:string}|null,next:{clipId:number,column:number,name:string}|null,loops:number}} RunnerState
 * @typedef {{resolumeOnline:boolean,resolume:{product:string,version:string}|null,composition:CompositionInfo|null,nowPlaying:NowPlaying[],automations:Automation[],runner:RunnerState|null,updatedAt:number}} EventState
 * @typedef {{eventId:string,name:string,online:boolean,resolumeOnline:boolean,lastSeen:number,nowPlaying:NowPlaying[],runner:{automationName:string,current:string|null}|null}} EventSummary
 * @typedef {{at:number,level:"info"|"warn"|"error",by:string,text:string}} LogEntry
 * @typedef {"admin"|"viewer"} Role
 */

export const S = {
  /** Configuración pública (GET /api/config). */
  cfg: { mode: "codes", brand: "", contactWhatsapp: "", agent: null },
  /** Modo cuentas: { me } tras ingresar. */
  account: null,
  /** Planes (GET /api/plans). */
  plans: [],
  /** @type {{token:string, role:Role, name:string} | null} */
  auth: null,
  /** "idle" | "connecting" | "open" | "reconnecting" */
  conn: "idle",
  /** @type {EventSummary[]} */
  events: [],
  eventsLoaded: false,
  /** "login" | "events" | "event" */
  route: "login",
  /** @type {string | null} */
  eventId: null,
  /** @type {EventState | null} */
  state: null,
  /** @type {LogEntry[]} más nuevo primero */
  logs: [],
  /** @type {{url:string, at:number} | null} */
  snapshot: null,
  /** "live" | "clips" | "autos" | "log" */
  tab: "live",
  /** Interruptor de seguridad. Siempre apagado al entrar a un evento. */
  control: false,
  /** Reloj del puente (state.updatedAt, runner) y de las capturas. */
  stateClock: new ClockSync(),
  snapClock: new ClockSync(),
};

export const isAdmin = () => S.auth?.role === "admin";

/** @returns {EventSummary | undefined} */
export const currentSummary = () => S.events.find((e) => e.eventId === S.eventId);

const subs = new Map();

export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic)?.delete(fn);
}

export function emit(topic, payload) {
  for (const fn of [...(subs.get(topic) || [])]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[${topic}]`, err);
    }
  }
}
