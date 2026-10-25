// Ingreso por HTTP y conexión WebSocket con reconexión automática y órdenes con requestId.

import { uuid } from "./util.js";

/** POST /api/login → {token, role, name}. Lanza Error con mensaje para mostrar. */
export async function login(name, code) {
  let res;
  try {
    res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code }),
      cache: "no-store",
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor. Revisa la red.");
  }
  if (res.status === 401) throw new Error("Código incorrecto.");
  if (res.status === 429) throw new Error("Demasiados intentos fallidos. Espera unos minutos y vuelve a intentar.");
  if (!res.ok) throw new Error(`El servidor respondió con un error (${res.status}).`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data.token !== "string" || (data.role !== "admin" && data.role !== "viewer")) {
    throw new Error("Respuesta inesperada del servidor.");
  }
  return { token: data.token, role: data.role, name: String(data.name || name) };
}

/** Lee el vencimiento del token (sin verificar la firma, solo para no intentar con uno vencido). */
export function tokenExpired(token) {
  try {
    const b64 = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (typeof json.exp !== "number") return false;
    const expMs = json.exp < 1e12 ? json.exp * 1000 : json.exp;
    return expMs <= Date.now();
  } catch {
    return false;
  }
}

/** Códigos de cierre que indican sesión rechazada. */
const AUTH_CLOSE = new Set([1008, 4001, 4003, 4401, 4403]);

export class Connection {
  /**
   * @param {{ token: string, onMessage: (msg: any) => void, onStatus: (s: string) => void, onOpen: () => void, onAuthFail: () => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.failsBeforeOpen = 0;
    this.timer = null;
    /** @type {Map<string, {resolve: Function, timer: any}>} */
    this.pending = new Map();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.failPending("Sesión cerrada");
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close(1000);
      } catch {
        /* nada */
      }
    }
    this.ws = null;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.stopped) return;
    if (tokenExpired(this.opts.token)) return this.opts.onAuthFail();
    this.opts.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/client?token=${encodeURIComponent(this.opts.token)}`);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.failsBeforeOpen = 0;
      this.opts.onStatus("open");
      this.opts.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type === "result" && this.pending.has(msg.requestId)) {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending("Se perdió la conexión");
      if (this.stopped) return;
      if (AUTH_CLOSE.has(ev.code)) return this.opts.onAuthFail();
      if (!opened) {
        this.failsBeforeOpen++;
        // El navegador no deja ver el 401 del handshake: si el servidor responde
        // /healthz pero el WS se rechaza dos veces seguidas, la sesión no sirve.
        if (this.failsBeforeOpen >= 2) {
          this.checkHealth().then((up) => {
            if (this.stopped) return;
            if (up) this.opts.onAuthFail();
            else this.retry();
          });
          return;
        }
      }
      this.retry();
    };
  }

  async checkHealth() {
    try {
      const r = await fetch("/healthz", { cache: "no-store" });
      return r.ok;
    } catch {
      return false;
    }
  }

  retry() {
    if (this.stopped) return;
    this.attempt++;
    this.opts.onStatus("reconnecting");
    const delay = Math.min(10000, 800 * 2 ** Math.min(this.attempt - 1, 4)) + Math.random() * 400;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** Reintenta ya (p. ej. al volver la página a primer plano). */
  nudge() {
    if (this.stopped || this.ws) return;
    clearTimeout(this.timer);
    this.connect();
  }

  send(obj) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /**
   * Manda una orden y espera su result.
   * @returns {Promise<{ok:boolean, error?:string, data?:any}>}
   */
  command(eventId, command, timeoutMs = 20000) {
    const requestId = uuid();
    return new Promise((resolve) => {
      if (!this.isOpen) return resolve({ ok: false, error: "Sin conexión con el servidor" });
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "Sin respuesta (tiempo agotado)" });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.send({ type: "command", requestId, eventId, command });
    });
  }

  failPending(error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    }
    this.pending.clear();
  }
}
