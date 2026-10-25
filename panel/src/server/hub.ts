// Relevo entre puentes (uno por evento) y clientes web. Todo el estado vive en memoria.
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  VIEWER_ACTIONS,
  type BridgeToServer,
  type Command,
  type EventState,
  type EventSummary,
  type LogEntry,
  type ServerToBridge,
  type ServerToClient,
} from "../shared/protocol.js";
import type { Session } from "./auth.js";
import { cleanNowPlaying, parseBridgeMessage, parseClientMessage, parseJson } from "./validate.js";

export const CLOSE_REPLACED = 4000;
export const CLOSE_BAD_SESSION = 4001;

const MAX_LOGS = 200;
const MAX_PENDING_PER_CLIENT = 50;
/** Si un cliente acumula más que esto sin enviar, se le saltan capturas. */
const MAX_BUFFERED_FOR_SNAPSHOT = 4 * 1024 * 1024;

export type LogFn = (level: "info" | "warn" | "error", text: string) => void;

export interface HubOptions {
  commandTimeoutMs: number;
  eventsThrottleMs: number;
  offlineTtlMs: number;
  log: LogFn;
}

interface Conn {
  ws: WebSocket;
  alive: boolean;
}

interface BridgeConn extends Conn {
  eventId: string;
}

interface ClientConn extends Conn {
  session: Session;
  sub: { eventId: string | null; snapshots: boolean };
  pending: Set<string>;
}

interface EventRecord {
  id: string;
  name: string;
  bridge: BridgeConn | null;
  lastSeen: number;
  state: EventState | null;
  snapshot: { mime: string; data: string; at: number } | null;
  logs: LogEntry[];
  /** Último valor de `watch` enviado al puente. */
  watching: boolean;
  /** Huella del resumen (sin lastSeen) para detectar cambios. */
  summaryKey: string;
}

interface Pending {
  client: ClientConn;
  clientRequestId: string;
  bridge: BridgeConn;
  timer: NodeJS.Timeout;
}

function send(ws: WebSocket, msg: ServerToClient | ServerToBridge): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Nombre visible del evento: sin caracteres de control, máx. 80. */
export function cleanEventName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || fallback;
}

export class Hub {
  private readonly events = new Map<string, EventRecord>();
  private readonly clients = new Set<ClientConn>();
  private readonly pending = new Map<string, Pending>();
  private eventsTimer: NodeJS.Timeout | null = null;
  private lastEventsAt = 0;
  private closed = false;

  constructor(private readonly opts: HubOptions) {}

  // ------------------------------------------------------------ Puentes

  addBridge(ws: WebSocket, eventId: string, name: string): void {
    const now = Date.now();
    let e = this.events.get(eventId);
    if (!e) {
      e = {
        id: eventId,
        name: cleanEventName(name, eventId),
        bridge: null,
        lastSeen: now,
        state: null,
        snapshot: null,
        logs: [],
        watching: false,
        summaryKey: "",
      };
      this.events.set(eventId, e);
    } else if (name) {
      e.name = cleanEventName(name, e.name);
    }

    const conn: BridgeConn = { ws, alive: true, eventId };
    const old = e.bridge;
    e.bridge = conn;
    e.lastSeen = now;
    if (old) {
      this.failPendingFor(old, "El puente se reemplazó por otra conexión");
      old.ws.close(CLOSE_REPLACED, "Reemplazado por una conexión nueva");
      this.opts.log("info", `Puente de "${eventId}" reemplazado por una conexión nueva`);
    } else {
      this.opts.log("info", `Puente conectado: "${eventId}"`);
    }

    ws.on("message", (data, isBinary) => this.onBridgeMessage(conn, data, isBinary));
    ws.on("close", () => this.onBridgeClose(conn));
    ws.on("error", (err) => this.opts.log("warn", `Error en puente "${eventId}": ${err.message}`));
    ws.on("pong", () => {
      conn.alive = true;
      if (e && e.bridge === conn) e.lastSeen = Date.now();
    });

    // El puente siempre sabe al conectarse si alguien mira capturas.
    e.watching = this.countWatchers(eventId) > 0;
    send(ws, { type: "watch", snapshots: e.watching });
    this.scheduleEvents();
  }

  private onBridgeClose(conn: BridgeConn): void {
    this.failPendingFor(conn, "El evento se desconectó");
    const e = this.events.get(conn.eventId);
    if (!e || e.bridge !== conn) return;
    e.bridge = null;
    e.lastSeen = Date.now();
    this.opts.log("info", `Puente desconectado: "${conn.eventId}"`);
    this.scheduleEvents();
  }

  private onBridgeMessage(conn: BridgeConn, data: RawData, isBinary: boolean): void {
    const e = this.events.get(conn.eventId);
    if (!e || e.bridge !== conn) return;
    if (isBinary) return;
    const msg = parseBridgeMessage(parseJson(rawToString(data)));
    if (!msg) {
      this.opts.log("warn", `Mensaje inválido del puente "${conn.eventId}" (ignorado)`);
      return;
    }
    e.lastSeen = Date.now();
    this.handleBridgeMessage(e, conn, msg);
  }

  private handleBridgeMessage(e: EventRecord, conn: BridgeConn, msg: BridgeToServer): void {
    switch (msg.type) {
      case "hello": {
        if (msg.eventId !== e.id) {
          this.opts.log("warn", `El puente "${e.id}" dice ser "${msg.eventId.slice(0, 64)}" (ignorado)`);
          return;
        }
        const name = cleanEventName(msg.name, e.name);
        if (name !== e.name) {
          e.name = name;
          this.scheduleEvents();
        }
        return;
      }
      case "state": {
        e.state = msg.state;
        const key = JSON.stringify(this.summaryCore(e));
        if (key !== e.summaryKey) this.scheduleEvents();
        this.toSubscribers(e.id, { type: "state", eventId: e.id, state: msg.state });
        return;
      }
      case "snapshot": {
        e.snapshot = { mime: msg.mime, data: msg.data, at: msg.at };
        const raw = JSON.stringify({ type: "snapshot", eventId: e.id, mime: msg.mime, data: msg.data, at: msg.at });
        for (const c of this.clients) {
          if (c.sub.eventId !== e.id || !c.sub.snapshots) continue;
          if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > MAX_BUFFERED_FOR_SNAPSHOT) continue;
          c.ws.send(raw);
        }
        return;
      }
      case "result": {
        const p = this.pending.get(msg.requestId);
        if (!p || p.bridge !== conn) return;
        this.settle(msg.requestId, p);
        const out: ServerToClient = { type: "result", requestId: p.clientRequestId, ok: msg.ok };
        if (msg.error !== undefined) out.error = msg.error;
        if (msg.data !== undefined) out.data = msg.data;
        send(p.client.ws, out);
        return;
      }
      case "log": {
        e.logs.push(msg.entry);
        if (e.logs.length > MAX_LOGS) e.logs.splice(0, e.logs.length - MAX_LOGS);
        this.toSubscribers(e.id, { type: "log", eventId: e.id, entry: msg.entry });
        return;
      }
    }
  }

  // ------------------------------------------------------------ Clientes web

  addClient(ws: WebSocket, session: Session): void {
    const conn: ClientConn = {
      ws,
      alive: true,
      session,
      sub: { eventId: null, snapshots: false },
      pending: new Set(),
    };
    this.clients.add(conn);
    ws.on("message", (data, isBinary) => this.onClientMessage(conn, data, isBinary));
    ws.on("close", () => this.onClientClose(conn));
    ws.on("error", () => {
      /* el cierre se maneja en "close" */
    });
    ws.on("pong", () => {
      conn.alive = true;
    });
    send(ws, { type: "welcome", role: session.role, name: session.name });
    send(ws, { type: "events", events: this.summaries() });
  }

  private onClientClose(conn: ClientConn): void {
    this.clients.delete(conn);
    for (const id of conn.pending) {
      const p = this.pending.get(id);
      if (p) clearTimeout(p.timer);
      this.pending.delete(id);
    }
    conn.pending.clear();
    if (conn.sub.eventId) this.updateWatch(conn.sub.eventId);
  }

  private onClientMessage(conn: ClientConn, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      send(conn.ws, { type: "error", message: "Solo se aceptan mensajes de texto" });
      return;
    }
    const raw = parseJson(rawToString(data));
    if (raw === undefined) {
      send(conn.ws, { type: "error", message: "JSON inválido" });
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      // Si era una orden con requestId, se responde como resultado para que la web no quede esperando.
      const r = raw as { type?: unknown; requestId?: unknown };
      if (r && r.type === "command" && typeof r.requestId === "string" && r.requestId.length <= 128) {
        send(conn.ws, { type: "result", requestId: r.requestId, ok: false, error: parsed.error });
      } else {
        send(conn.ws, { type: "error", message: parsed.error });
      }
      return;
    }
    const msg = parsed.msg;
    if (msg.type === "subscribe") this.subscribe(conn, msg.eventId, msg.snapshots);
    else this.command(conn, msg.requestId, msg.eventId, msg.command);
  }

  private subscribe(conn: ClientConn, eventId: string | null, snapshots: boolean): void {
    const prev = conn.sub.eventId;
    conn.sub = { eventId, snapshots: eventId !== null && snapshots };
    if (prev && prev !== eventId) this.updateWatch(prev);
    if (!eventId) return;

    const e = this.events.get(eventId);
    if (e?.state) send(conn.ws, { type: "state", eventId, state: e.state });
    if (conn.sub.snapshots && e?.snapshot) send(conn.ws, { type: "snapshot", eventId, ...e.snapshot });
    send(conn.ws, { type: "logs", eventId, entries: e ? [...e.logs] : [] });
    this.updateWatch(eventId);
  }

  private command(conn: ClientConn, requestId: string, eventId: string, command: Command): void {
    const fail = (error: string) => send(conn.ws, { type: "result", requestId, ok: false, error });

    if (conn.session.role !== "admin" && !VIEWER_ACTIONS.includes(command.action)) {
      return fail("Solo lectura: no tienes permiso para esta acción");
    }
    const e = this.events.get(eventId);
    const bridge = e?.bridge;
    if (!bridge || bridge.ws.readyState !== WebSocket.OPEN) return fail("El evento no está conectado");
    if (conn.pending.size >= MAX_PENDING_PER_CLIENT) return fail("Demasiadas órdenes en curso, espera un momento");

    const internalId = randomUUID();
    const timer = setTimeout(() => {
      const p = this.pending.get(internalId);
      if (!p) return;
      this.settle(internalId, p);
      send(p.client.ws, { type: "result", requestId, ok: false, error: "El evento no respondió a tiempo" });
    }, this.opts.commandTimeoutMs);
    this.pending.set(internalId, { client: conn, clientRequestId: requestId, bridge, timer });
    conn.pending.add(internalId);
    send(bridge.ws, { type: "command", requestId: internalId, command, by: conn.session.name });
  }

  private settle(internalId: string, p: Pending): void {
    clearTimeout(p.timer);
    this.pending.delete(internalId);
    p.client.pending.delete(internalId);
  }

  private failPendingFor(bridge: BridgeConn, error: string): void {
    for (const [id, p] of this.pending) {
      if (p.bridge !== bridge) continue;
      this.settle(id, p);
      send(p.client.ws, { type: "result", requestId: p.clientRequestId, ok: false, error });
    }
  }

  // ------------------------------------------------------------ Capturas y resúmenes

  private countWatchers(eventId: string): number {
    let n = 0;
    for (const c of this.clients) if (c.sub.eventId === eventId && c.sub.snapshots) n++;
    return n;
  }

  /** Avisa al puente solo cuando pasa de 0 a >0 clientes mirando capturas, o al revés. */
  private updateWatch(eventId: string): void {
    const e = this.events.get(eventId);
    if (!e) return;
    const want = this.countWatchers(eventId) > 0;
    if (want === e.watching) return;
    e.watching = want;
    if (e.bridge) send(e.bridge.ws, { type: "watch", snapshots: want });
  }

  private toSubscribers(eventId: string, msg: ServerToClient): void {
    let raw: string | null = null;
    for (const c of this.clients) {
      if (c.sub.eventId !== eventId || c.ws.readyState !== WebSocket.OPEN) continue;
      raw ??= JSON.stringify(msg);
      c.ws.send(raw);
    }
  }

  private summaryCore(e: EventRecord): Omit<EventSummary, "lastSeen"> {
    const online = e.bridge !== null;
    const st = online ? e.state : null;
    const runner = st?.runner;
    let runnerSummary: EventSummary["runner"] = null;
    if (runner && typeof runner === "object" && typeof runner.automationName === "string") {
      const cur = runner.current;
      runnerSummary = {
        automationName: runner.automationName,
        current: cur && typeof cur === "object" && typeof cur.name === "string" ? cur.name : null,
      };
    }
    return {
      eventId: e.id,
      name: e.name,
      online,
      resolumeOnline: st?.resolumeOnline === true,
      nowPlaying: cleanNowPlaying(st?.nowPlaying),
      runner: runnerSummary,
    };
  }

  private summaries(): EventSummary[] {
    const list: EventSummary[] = [];
    for (const e of this.events.values()) {
      const core = this.summaryCore(e);
      list.push({ ...core, lastSeen: e.lastSeen });
    }
    // En línea primero, luego por nombre.
    list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "es"));
    return list;
  }

  /** Manda `events` a todos, como mucho uno por `eventsThrottleMs`. */
  private scheduleEvents(): void {
    if (this.eventsTimer || this.closed) return;
    const wait = Math.max(0, this.lastEventsAt + this.opts.eventsThrottleMs - Date.now());
    this.eventsTimer = setTimeout(() => {
      this.eventsTimer = null;
      this.lastEventsAt = Date.now();
      for (const e of this.events.values()) e.summaryKey = JSON.stringify(this.summaryCore(e));
      const raw = JSON.stringify({ type: "events", events: this.summaries() } satisfies ServerToClient);
      for (const c of this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
    }, wait);
  }

  // ------------------------------------------------------------ Mantenimiento

  /** Ping/pong: corta conexiones que no respondieron al ping anterior y sesiones vencidas. */
  heartbeat(now = Date.now()): void {
    const conns: Conn[] = [...this.clients];
    for (const e of this.events.values()) if (e.bridge) conns.push(e.bridge);
    for (const c of conns) {
      if ("session" in c && (c as ClientConn).session.exp <= now) {
        c.ws.close(CLOSE_BAD_SESSION, "Sesión vencida");
        continue;
      }
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
  }

  /** Borra eventos desconectados que no se ven hace más de `offlineTtlMs`. */
  prune(now = Date.now()): void {
    let changed = false;
    for (const [id, e] of this.events) {
      if (!e.bridge && now - e.lastSeen > this.opts.offlineTtlMs) {
        this.events.delete(id);
        changed = true;
      }
    }
    if (changed) this.scheduleEvents();
  }

  close(): void {
    this.closed = true;
    if (this.eventsTimer) clearTimeout(this.eventsTimer);
    this.eventsTimer = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const c of this.clients) c.ws.terminate();
    for (const e of this.events.values()) e.bridge?.ws.terminate();
  }
}
