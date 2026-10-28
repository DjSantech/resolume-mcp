// Puente: corre en un PC de la red del evento. Lee Resolume, manda el estado al servidor por un WebSocket saliente,
// ejecuta las órdenes que llegan y corre las automatizaciones (que siguen aunque se caiga internet).

import { hostname } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";
import type {
  BridgeToServer, Command, CompositionInfo, EventState, LogEntry, NowPlaying, ServerToBridge,
} from "../shared/protocol.js";
import { AutomationRunner } from "./automation.js";
import { fitClip, ratioOf } from "./fit.js";
import {
  clipName, clipStateOf, createResolumeApi, isFileClip, mapComposition, mapProduct, selectDeckAndWait,
  type RClip, type RComposition, type RProduct, type ResolumeApi,
} from "./resolume.js";
import { AutomationStore, parseAutomation } from "./store.js";
import { ScreenStore, parseScreenLayout, readAdvancedOutput, writeAdvancedOutput } from "./screens.js";

export const BRIDGE_VERSION = "1.0.0";

export interface BridgeConfig {
  /** Webserver de Resolume. Por defecto http://127.0.0.1:8080 */
  resolumeUrl?: string;
  /** wss://mi-panel.onrender.com o ws://127.0.0.1:3000 */
  serverUrl: string;
  /** Secreto compartido con el servidor (modo códigos). Nunca se imprime. */
  bridgeToken?: string;
  /** Modo cuentas: id del agente vinculado (alternativa a bridgeToken, junto con agentSecret). */
  agentId?: string;
  /** Modo cuentas: secreto del agente. Nunca se imprime. */
  agentSecret?: string;
  /** Identificador del evento ([a-z0-9-]). Por defecto el nombre del PC. */
  eventId?: string;
  /** Nombre visible. Por defecto eventId. */
  eventName?: string;
  /** Carpeta de automations.json. Por defecto ./data */
  dataDir?: string;
  /** Cada cuánto lee la composición (ms). Por defecto 1000. */
  pollMs?: number;
  /** Cada cuánto manda captura de la salida si alguien mira (ms). Por defecto 3000. */
  snapshotMs?: number;
  /** Límite por petición a Resolume, incluida la descarga (ms). Por defecto 15000. */
  resolumeTimeoutMs?: number;
  /** Carpeta "Resolume Arena" (Preferences y Presets). Por defecto se busca en Documentos. */
  resolumeDocs?: string;

  // Opciones internas (pruebas y modo local).
  /** Salida de los mensajes del puente. Por defecto console.log. */
  logger?: (line: string) => void;
  /** Mínimo permitido para minSeconds de una automatización. Por defecto 10. */
  minAutomationSeconds?: number;
  /** Espera tras abrir una pestaña antes de leer sus clips (ms). Por defecto 1500. */
  deckSettleMs?: number;
  /** Espera antes de reintentar en una automatización (ms). Por defecto 5000. */
  retryMs?: number;
  /** Espera inicial de reconexión al servidor (ms). Por defecto 1000 (sube hasta 30 s). */
  reconnectMinMs?: number;
}

export interface Bridge {
  stop(): Promise<void>;
  /** Estado resumido (para la página local del agente). */
  status(): BridgeStatus;
}

export interface BridgeStatus {
  /** Conectado al servidor ahora mismo. */
  serverConnected: boolean;
  /** El servidor rechazó las credenciales (401/403) en el último intento. */
  serverRejected: boolean;
  /** Último error de conexión con el servidor (sin secretos). */
  serverError: string;
  resolumeOnline: boolean;
  resolume: EventState["resolume"];
  /** Nombre de la automatización en curso, o null. */
  automation: string | null;
}

/** URL del WebSocket del puente: con credenciales de agente (modo cuentas) o con token (modo códigos). */
export function bridgeWsUrl(serverUrl: string, auth: { eventId: string; eventName: string; bridgeToken?: string; agentId?: string; agentSecret?: string }): string {
  const base = serverUrl.trim().replace(/\/+$/, "").replace(/^http(s?):\/\//i, "ws$1://");
  if (auth.agentId && auth.agentSecret) {
    return `${base}/ws/bridge?agent=${encodeURIComponent(auth.agentId)}&secret=${encodeURIComponent(auth.agentSecret)}`;
  }
  return `${base}/ws/bridge?event=${encodeURIComponent(auth.eventId)}` +
    `&name=${encodeURIComponent(auth.eventName)}&token=${encodeURIComponent(auth.bridgeToken ?? "")}`;
}

/** Nombre del PC convertido a identificador válido. */
export function defaultEventId(): string {
  return hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "evento";
}

const HEARTBEAT_MS = 15_000;
const RECONNECT_MAX_MS = 30_000;
const DEAD_MS = 70_000; // el servidor manda ping cada 25 s
const MAX_PENDING_LOGS = 100;
const LOG_COALESCE_MS = 1500;

class BadCommand extends Error {}

export async function startBridge(config: BridgeConfig): Promise<Bridge> {
  const bridge = new BridgeImpl(config);
  await bridge.start();
  return { stop: () => bridge.stop(), status: () => bridge.status() };
}

class BridgeImpl {
  private readonly api: ResolumeApi;
  private readonly store: AutomationStore;
  private readonly screens: ScreenStore;
  private readonly resolumeDocs: string | undefined;
  private readonly runner: AutomationRunner;
  private readonly eventId: string;
  private readonly eventName: string;
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly agentId: string;
  private readonly agentSecret: string;
  private readonly pollMs: number;
  private readonly snapshotMs: number;
  private readonly reconnectMinMs: number;
  private readonly minAutomationSeconds: number;
  private readonly print: (line: string) => void;

  private stopped = false;
  private ws: WebSocket | null = null;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;
  private lastConnectError = "";
  private rejected = false;

  // Resolume
  private resolumeOnline: boolean | null = null;
  private product: EventState["resolume"] = null;
  private raw: RComposition | null = null;
  private composition: CompositionInfo | null = null;
  private nowPlaying: NowPlaying[] = [];
  private monitorId: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private pollAgain = false;
  /** Lecturas fallidas seguidas: una sola (red lenta) no cuenta como desconexión. */
  private readFailures = 0;

  // Capturas
  private watchSnapshots = false;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private snapshotting = false;

  // Envío de estado
  private lastSentKey = "";
  private lastSentAt = 0;
  private pendingLogs: LogEntry[] = [];
  private coalesced = new Map<string, { timer: NodeJS.Timeout; entry: LogEntry }>();

  constructor(cfg: BridgeConfig) {
    if (!cfg.serverUrl) throw new Error("Falta SERVER_URL");
    const agentMode = !!(cfg.agentId && cfg.agentSecret);
    if (!agentMode && !cfg.bridgeToken) throw new Error("Falta BRIDGE_TOKEN");
    const eventId = (cfg.eventId ?? "").trim().toLowerCase() || defaultEventId();
    if (!/^[a-z0-9-]{1,64}$/.test(eventId)) throw new Error(`EVENT_ID inválido: "${eventId}" (solo a-z, 0-9 y -)`);
    this.eventId = eventId;
    this.eventName = (cfg.eventName ?? "").trim().slice(0, 80) || eventId;
    this.serverUrl = cfg.serverUrl.trim().replace(/\/+$/, "").replace(/^http(s?):\/\//i, "ws$1://");
    this.token = agentMode ? "" : cfg.bridgeToken ?? "";
    this.agentId = agentMode ? cfg.agentId ?? "" : "";
    this.agentSecret = agentMode ? cfg.agentSecret ?? "" : "";
    this.pollMs = Math.max(100, cfg.pollMs ?? 1000);
    this.snapshotMs = Math.max(100, cfg.snapshotMs ?? 3000);
    this.reconnectMinMs = Math.max(10, cfg.reconnectMinMs ?? 1000);
    this.backoffMs = this.reconnectMinMs;
    this.minAutomationSeconds = cfg.minAutomationSeconds ?? 10;
    this.print = cfg.logger ?? ((line) => console.log(line));

    this.api = createResolumeApi(cfg.resolumeUrl ?? "http://127.0.0.1:8080", cfg.resolumeTimeoutMs ?? 15000);
    this.store = new AutomationStore(resolve(cfg.dataDir ?? "./data"), cfg.minAutomationSeconds ?? 10, (t) => this.log("warn", "puente", t));
    this.screens = new ScreenStore(resolve(cfg.dataDir ?? "./data"), (t) => this.log("warn", "puente", t));
    this.resolumeDocs = cfg.resolumeDocs || undefined;
    this.runner = new AutomationRunner({
      api: this.api,
      log: (level, by, text) => this.log(level, by, text),
      changed: () => this.publish(),
      getAutomation: (id) => this.store.get(id),
      compRatio: () => this.compRatio(),
      deckSettleMs: cfg.deckSettleMs ?? 1500,
      retryMs: cfg.retryMs ?? 5000,
    });
  }

  async start(): Promise<void> {
    await this.store.load();
    await this.screens.load();
    this.console(`Puente "${this.eventName}" (${this.eventId}) → servidor ${this.serverUrl}`);
    await this.poll();
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.runner.stop();
    for (const t of [this.pollTimer, this.snapshotTimer, this.reconnectTimer, this.deadTimer]) if (t) clearTimeout(t);
    for (const [key] of this.coalesced) this.flushCoalesced(key);
    await this.polling?.catch(() => undefined);
    await this.store.flush();
    await this.screens.flush();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          ws.terminate();
          done();
        }, 1000);
        ws.once("close", () => {
          clearTimeout(timer);
          done();
        });
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, "puente detenido");
      });
    }
  }

  // ---------------------------------------------------------------- Registro

  private console(text: string): void {
    this.print(`[${new Date().toLocaleTimeString()}] ${this.redact(text)}`);
  }

  private redact(text: string): string {
    for (const secret of [this.token, this.agentSecret]) if (secret) text = text.split(secret).join("***");
    return text;
  }

  status(): BridgeStatus {
    return {
      serverConnected: this.ws?.readyState === WebSocket.OPEN,
      serverRejected: this.rejected,
      serverError: this.lastConnectError,
      resolumeOnline: this.resolumeOnline === true,
      resolume: this.product,
      automation: this.runner.state?.automationName ?? null,
    };
  }

  private log(level: LogEntry["level"], by: string, text: string): void {
    const entry: LogEntry = { at: Date.now(), level, by, text: this.redact(text) };
    this.console(`${level === "info" ? "" : level === "warn" ? "AVISO " : "ERROR "}${by}: ${entry.text}`);
    if (!this.send({ type: "log", entry })) {
      this.pendingLogs.push(entry);
      if (this.pendingLogs.length > MAX_PENDING_LOGS) this.pendingLogs.shift();
    }
  }

  /** Para sliders (opacidad, master, BPM): un solo registro con el último valor. */
  private logCoalesced(key: string, by: string, text: string): void {
    const prev = this.coalesced.get(key);
    if (prev) clearTimeout(prev.timer);
    const entry: LogEntry = { at: Date.now(), level: "info", by, text };
    const timer = setTimeout(() => this.flushCoalesced(key), LOG_COALESCE_MS);
    this.coalesced.set(key, { timer, entry });
  }

  private flushCoalesced(key: string): void {
    const item = this.coalesced.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    this.coalesced.delete(key);
    this.log(item.entry.level, item.entry.by, item.entry.text);
  }

  // ---------------------------------------------------------------- Servidor

  private send(msg: BridgeToServer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = bridgeWsUrl(this.serverUrl, {
      eventId: this.eventId, eventName: this.eventName, bridgeToken: this.token, agentId: this.agentId, agentSecret: this.agentSecret,
    });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
    } catch (e) {
      this.console(`SERVER_URL inválida: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      opened = true;
      this.backoffMs = this.reconnectMinMs;
      this.lastConnectError = "";
      this.rejected = false;
      this.console("Conectado al servidor");
      this.armDead(ws);
      this.send({ type: "hello", eventId: this.eventId, name: this.eventName, bridgeVersion: BRIDGE_VERSION });
      for (const entry of this.pendingLogs.splice(0)) this.send({ type: "log", entry });
      this.publish(true);
    });
    ws.on("ping", () => this.armDead(ws));
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.armDead(ws);
      this.onMessage(String(data));
    });
    ws.on("error", (e) => {
      // Sin este listener, ws lanza la excepción y tumba el proceso.
      const status = /Unexpected server response: (\d+)/.exec(e.message)?.[1];
      this.rejected = status === "401" || status === "403";
      this.lastConnectError = this.rejected
        ? (this.agentSecret
          ? `el servidor rechazó este PC (${status}); puede que lo hayan desvinculado desde la web`
          : `el servidor rechazó el token (${status}); revisa BRIDGE_TOKEN`)
        : this.redact(e.message || String(e));
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.deadTimer) clearTimeout(this.deadTimer);
      this.setWatch(false);
      if (this.stopped) return;
      if (opened) this.console(`Desconectado del servidor (código ${code}). Reconecto...`);
      else this.console(`No pude conectar al servidor${this.lastConnectError ? ` (${this.lastConnectError})` : ""}. Reintento en ${Math.round(this.backoffMs / 1000)} s`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Si no llega nada (ni ping) en un buen rato, la conexión está muerta aunque el sistema no lo sepa. */
  private armDead(ws: WebSocket): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      if (this.ws === ws) {
        this.console("El servidor dejó de responder; reconecto");
        ws.terminate();
      }
    }, DEAD_MS);
  }

  private onMessage(text: string): void {
    let msg: ServerToBridge;
    try {
      msg = JSON.parse(text) as ServerToBridge;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "watch") {
      this.setWatch(msg.snapshots === true);
    } else if (msg.type === "command" && typeof msg.requestId === "string") {
      void this.handleCommand(msg.requestId, msg.command, msg.by);
    }
  }

  private async handleCommand(requestId: string, command: Command, by: unknown): Promise<void> {
    const who = (typeof by === "string" ? by.trim().slice(0, 40) : "") || "panel";
    try {
      const data = await this.execute(command, who);
      this.send({ type: "result", requestId, ok: true, ...(data !== undefined ? { data } : {}) });
    } catch (e) {
      const error = this.redact((e as Error).message || "Error desconocido");
      if (!(e instanceof BadCommand) && command?.action !== "getThumbnail") {
        this.log("warn", who, `Falló ${command?.action ?? "una orden"}: ${error}`);
      }
      this.send({ type: "result", requestId, ok: false, error });
    }
  }

  // ---------------------------------------------------------------- Estado

  private state(): EventState {
    return {
      resolumeOnline: this.resolumeOnline === true,
      resolume: this.product,
      composition: this.composition,
      nowPlaying: this.nowPlaying,
      automations: this.store.list(),
      runner: this.runner.state ? structuredClone(this.runner.state) : null,
      screens: this.screens.list(),
      updatedAt: Date.now(),
    };
  }

  /** Manda `state` si cambió algo (sin contar updatedAt), o si pasaron 15 s del último. */
  private publish(force = false): void {
    const state = this.state();
    const key = JSON.stringify({ ...state, updatedAt: 0 });
    const now = Date.now();
    if (!force && key === this.lastSentKey && now - this.lastSentAt < HEARTBEAT_MS) return;
    if (this.send({ type: "state", state })) {
      this.lastSentKey = key;
      this.lastSentAt = now;
    }
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  /** Lee la composición, actualiza el estado y programa la siguiente lectura. */
  private poll(): Promise<void> {
    if (this.polling) {
      this.pollAgain = true;
      return this.polling;
    }
    this.polling = this.readResolume()
      .finally(() => {
        this.polling = null;
        this.publish();
        if (this.pollAgain) {
          this.pollAgain = false;
          this.schedulePoll(0);
        } else {
          this.schedulePoll(this.pollMs);
        }
      });
    return this.polling;
  }

  private async readResolume(): Promise<void> {
    try {
      const raw = (await this.api.call("GET", "/composition")) as RComposition;
      if (!raw || typeof raw !== "object") throw new Error("Resolume devolvió una composición vacía");
      const { composition, nowPlaying } = mapComposition(raw);
      if (!this.product) {
        // Una vez por conexión con Resolume.
        this.product = mapProduct(((await this.api.call("GET", "/product").catch(() => null)) ?? {}) as RProduct);
      }
      if (this.resolumeOnline !== true) this.log("info", "puente", `Resolume conectado (${this.product.product} ${this.product.version})`);
      this.resolumeOnline = true;
      this.readFailures = 0;
      this.raw = raw;
      this.composition = composition;
      this.nowPlaying = nowPlaying;
    } catch (e) {
      // Con el último estado bueno, un fallo aislado se ignora.
      if (++this.readFailures < 2 && this.resolumeOnline === true) return;
      if (this.resolumeOnline !== false) this.log("warn", "puente", `Sin conexión con Resolume: ${(e as Error).message}. Sigo intentando.`);
      this.resolumeOnline = false;
      this.product = null;
      this.raw = null;
      this.composition = null;
      this.nowPlaying = [];
      this.monitorId = null;
    }
  }

  /** Composición en crudo: la última leída o una nueva si no hay. */
  private async rawComposition(): Promise<RComposition> {
    if (this.raw) return this.raw;
    return (await this.api.call("GET", "/composition")) as RComposition;
  }

  private async compRatio(): Promise<number> {
    if (this.composition) return ratioOf(this.composition.width, this.composition.height);
    const raw = await this.rawComposition();
    return ratioOf(Number(raw.video?.width?.value), Number(raw.video?.height?.value));
  }

  // ---------------------------------------------------------------- Capturas

  private setWatch(on: boolean): void {
    if (on === this.watchSnapshots) return;
    this.watchSnapshots = on;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    if (on) void this.snapshot();
  }

  private async snapshot(): Promise<void> {
    if (!this.watchSnapshots || this.stopped || this.snapshotting) return;
    this.snapshotting = true;
    try {
      if (this.resolumeOnline) this.send({ type: "snapshot", ...(await this.captureSnapshot()) });
    } catch {
      // Una captura fallida no es grave: se reintenta en la siguiente vuelta.
    } finally {
      this.snapshotting = false;
      if (this.watchSnapshots && !this.stopped) {
        this.snapshotTimer = setTimeout(() => void this.snapshot(), this.snapshotMs);
      }
    }
  }

  /** Una captura de la salida (monitor "Composition"). */
  private async captureSnapshot(): Promise<{ mime: string; data: string; at: number }> {
    if (this.monitorId === null) {
      const monitors = (await this.api.call("GET", "/composition/monitors").catch(() => null)) as { id?: number; name?: string }[] | null;
      this.monitorId = (Array.isArray(monitors) ? monitors.find((m) => m.name === "Composition")?.id : undefined) ?? 1;
    }
    const img = await this.api.binary(`/composition/monitors/${this.monitorId}/snapshot.jpg`);
    // Se pidió .jpg: cualquier tipo raro que declare Resolume se trata como JPEG.
    const mime = img.mime === "image/png" || img.mime === "image/webp" ? img.mime : "image/jpeg";
    return { mime, data: img.data.toString("base64"), at: Date.now() };
  }

  // ---------------------------------------------------------------- Órdenes

  private where(clipId: number): string {
    for (const l of this.composition?.layers ?? []) {
      const c = l.clips.find((x) => x.id === clipId);
      if (c) return ` (capa ${l.index}, col ${c.column})`;
    }
    return "";
  }

  private async execute(cmd: Command, by: string): Promise<unknown> {
    if (!cmd || typeof cmd !== "object" || typeof cmd.action !== "string") throw new BadCommand("Orden inválida");
    const api = this.api;

    switch (cmd.action) {
      case "triggerClip": {
        const id = posInt(cmd.clipId, "clipId");
        const clip = (await api.call("GET", `/composition/clips/by-id/${id}`)) as RClip | null;
        if (!clip) throw new Error("No encontré ese clip");
        if (clipStateOf(clip.connected?.value) === "empty") throw new BadCommand("Esa celda está vacía");
        let fitted: string | null = null;
        if (isFileClip(clip)) {
          try {
            fitted = await fitClip(api, clip, await this.compRatio());
          } catch (e) {
            this.log("warn", by, `No pude ajustar "${clipName(clip)}" a la pantalla: ${(e as Error).message}`);
          }
        }
        await api.call("POST", `/composition/clips/by-id/${id}/connect`);
        this.log("info", by, `Lanzó ${clipName(clip)}${this.where(id)}${fitted ? ` [ajustado: ${fitted}]` : ""}`);
        this.schedulePoll(0);
        return undefined;
      }
      case "triggerColumn": {
        const n = posInt(cmd.column, "column");
        await api.call("POST", `/composition/columns/${n}/connect`);
        const name = this.composition?.columns[n - 1]?.name;
        this.log("info", by, `Lanzó la columna ${n}${name && name !== String(n) ? ` (${name})` : ""}`);
        this.schedulePoll(0);
        return undefined;
      }
      case "clearLayer": {
        const n = posInt(cmd.layer, "layer");
        await api.call("POST", `/composition/layers/${n}/clear`);
        const name = this.composition?.layers[n - 1]?.name;
        this.log("info", by, `Apagó la capa ${n}${name ? ` (${name})` : ""}`);
        this.schedulePoll(0);
        return undefined;
      }
      case "clearAll": {
        await api.call("POST", "/composition/disconnect-all");
        this.log("info", by, "Apagó todo");
        this.schedulePoll(0);
        return undefined;
      }
      case "setLayerOpacity": {
        const n = posInt(cmd.layer, "layer");
        const value = clamp(finite(cmd.value, "value"), 0, 1);
        const id = (await this.rawComposition()).layers?.[n - 1]?.video?.opacity?.id;
        if (id === undefined) throw new BadCommand(`No existe la capa ${n}`);
        await api.call("PUT", `/parameter/by-id/${id}`, { value });
        this.logCoalesced(`opacity:${n}:${by}`, by, `Opacidad capa ${n}: ${Math.round(value * 100)}%`);
        this.schedulePoll(0);
        return undefined;
      }
      case "setMaster": {
        const value = clamp(finite(cmd.value, "value"), 0, 1);
        const id = (await this.rawComposition()).master?.id;
        if (id === undefined) throw new Error("No encontré el master de la composición");
        await api.call("PUT", `/parameter/by-id/${id}`, { value });
        this.logCoalesced(`master:${by}`, by, `Master: ${Math.round(value * 100)}%`);
        this.schedulePoll(0);
        return undefined;
      }
      case "setBpm": {
        const tempo = (await this.rawComposition()).tempocontroller?.tempo;
        if (tempo?.id === undefined) throw new Error("No encontré el tempo de la composición");
        const bpm = Math.round(clamp(finite(cmd.bpm, "bpm"), tempo.min ?? 20, tempo.max ?? 500) * 100) / 100;
        await api.call("PUT", `/parameter/by-id/${tempo.id}`, { value: bpm });
        this.logCoalesced(`bpm:${by}`, by, `BPM: ${bpm}`);
        this.schedulePoll(0);
        return undefined;
      }
      case "selectDeck": {
        const n = posInt(cmd.deckIndex, "deckIndex");
        const decks = ((await api.call("GET", "/composition")) as RComposition).decks ?? [];
        if (n > decks.length) throw new BadCommand(`No existe la pestaña ${n}`);
        const name = String(decks[n - 1].name?.value ?? n);
        if (decks[n - 1].selected?.value !== true) await selectDeckAndWait(api, n, 0);
        this.log("info", by, `Abrió la pestaña "${name}"`);
        this.schedulePoll(0);
        return undefined;
      }
      case "getThumbnail": {
        const id = posInt(cmd.clipId, "clipId");
        const img = await api.binary(`/composition/clips/by-id/${id}/thumbnail`);
        return { mime: img.mime === "application/octet-stream" ? "image/png" : img.mime, data: img.data.toString("base64") };
      }
      case "getSnapshot":
        return await this.captureSnapshot();
      case "saveScreenLayout": {
        const l = parseScreenLayout({ ...(cmd.layout ?? {}), updatedAt: Date.now() });
        if (typeof l === "string") throw new BadCommand(l);
        const isNew = !this.screens.get(l.id);
        await this.screens.save(l);
        this.log("info", by, `${isNew ? "Creó" : "Editó"} el diseño de pantalla "${l.name}"`);
        this.publish();
        return { id: l.id };
      }
      case "deleteScreenLayout": {
        const l = await this.screens.remove(String(cmd.id ?? ""));
        if (!l) throw new BadCommand("No existe ese diseño de pantalla");
        this.log("info", by, `Borró el diseño de pantalla "${l.name}"`);
        this.publish();
        return undefined;
      }
      case "applyScreenLayout": {
        const l = this.screens.get(String(cmd.id ?? ""));
        if (!l) throw new BadCommand("No existe ese diseño de pantalla");
        const target = cmd.target === "preferences" ? "preferences" : "preset";
        // Resolume reescribe AdvancedOutput.xml al cerrarse: reemplazarlo con Resolume abierto no sirve.
        if (target === "preferences" && this.resolumeOnline === true) {
          throw new BadCommand("Cierra Resolume antes de reemplazar la Salida Avanzada, o guárdala como preset.");
        }
        const name = String(cmd.presetName ?? "").trim() || l.name;
        const r = await writeAdvancedOutput(l, name, target, this.resolumeDocs);
        this.log("info", by, target === "preset"
          ? `Generó el preset de Salida Avanzada "${name}" (${r.slices} slices)`
          : `Reemplazó la Salida Avanzada con "${l.name}" (${r.slices} slices)`);
        return r;
      }
      case "readAdvancedOutput":
        return await readAdvancedOutput(this.resolumeDocs);
      case "saveAutomation": {
        const a = parseAutomation({ ...(cmd.automation ?? {}), updatedAt: Date.now() }, this.minAutomationSeconds);
        if (typeof a === "string") throw new BadCommand(a);
        const isNew = !this.store.get(a.id);
        await this.store.save(a);
        this.log("info", by, `${isNew ? "Creó" : "Editó"} la automatización "${a.name}"`);
        this.publish();
        return { id: a.id };
      }
      case "deleteAutomation": {
        const id = String(cmd.id ?? "");
        const a = this.store.get(id);
        if (!a) throw new BadCommand("No existe esa automatización");
        if (this.runner.runningId === id) {
          this.runner.stop();
          this.log("info", by, `Detuvo la automatización "${a.name}" para borrarla`);
        }
        await this.store.remove(id);
        this.log("info", by, `Borró la automatización "${a.name}"`);
        this.publish();
        return undefined;
      }
      case "startAutomation": {
        const a = this.store.get(String(cmd.id ?? ""));
        if (!a) throw new BadCommand("No existe esa automatización");
        const previous = this.runner.state;
        if (previous && previous.automationId !== a.id) this.log("info", by, `Detuvo la automatización "${previous.automationName}"`);
        await this.runner.start(a);
        this.log("info", by, `Inició la automatización "${a.name}"`);
        return undefined;
      }
      case "stopAutomation": {
        const current = this.runner.state;
        if (!current || !this.runner.stop()) throw new BadCommand("No hay ninguna automatización en curso");
        this.log("info", by, `Detuvo la automatización "${current.automationName}" (el clip actual sigue sonando)`);
        return undefined;
      }
      case "skipAutomation": {
        const current = this.runner.state;
        if (!current || !this.runner.skip()) throw new BadCommand("No hay ninguna automatización en curso");
        this.log("info", by, `Saltó${current.current ? ` "${current.current.name}"` : ""} al siguiente clip`);
        return undefined;
      }
      default:
        throw new BadCommand(`Orden desconocida: ${String((cmd as { action: unknown }).action)}`);
    }
  }
}

function posInt(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new BadCommand(`${field} inválido`);
  return n;
}

function finite(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) throw new BadCommand(`${field} inválido`);
  return n;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
