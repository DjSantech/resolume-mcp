// Pruebas del servidor: login, sesiones, relevo de órdenes, suscripciones, capturas y estáticos.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { EventState, LogEntry } from "../shared/protocol.js";
import { createToken, verifyToken } from "../server/auth.js";
import { startServer, type RunningServer, type ServerConfig } from "../server/server.js";

const ADMIN = "admin-codigo-123";
const VIEWER = "solo-mirar-456";
const BRIDGE = "token-del-puente-0123456789";
const SECRET = "secreto-de-sesion-para-pruebas";

type Msg = Record<string, any>;

/** Cliente WebSocket de prueba con cola de mensajes. */
class Peer {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Msg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static connect(url: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const peer = new Peer(ws);
      ws.once("open", () => resolve(peer));
      ws.once("error", reject);
    });
  }

  /** Espera el próximo mensaje que cumpla pred (incluye los ya recibidos). */
  next(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
    const i = this.messages.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (m: Msg) => {
          clearTimeout(t);
          resolve(m);
        },
      };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("Tiempo agotado esperando un mensaje"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  type(t: string, timeoutMs?: number): Promise<Msg> {
    return this.next((m) => m.type === t, timeoutMs);
  }

  /** Comprueba que no llegue ningún mensaje que cumpla pred durante ms. */
  async none(pred: (m: Msg) => boolean, ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.messages.find(pred), undefined);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  close(): Promise<unknown> {
    this.ws.close();
    return this.closed;
  }
}

function sampleState(over: Partial<EventState> = {}): EventState {
  return {
    resolumeOnline: true,
    resolume: { product: "Arena", version: "7.20.0" },
    composition: null,
    nowPlaying: [{ layer: 1, layerName: "Fondo", column: 2, clipId: 111, name: "Olas" }],
    automations: [],
    runner: null,
    updatedAt: Date.now(),
    ...over,
  };
}

describe("servidor", () => {
  let srv: RunningServer;
  let base: string;
  let wsBase: string;
  let webDir: string;
  let tmp: string;

  async function start(extra: Partial<ServerConfig> = {}): Promise<RunningServer> {
    return startServer({
      port: 0,
      host: "127.0.0.1",
      adminCode: ADMIN,
      viewerCode: VIEWER,
      bridgeToken: BRIDGE,
      sessionSecret: SECRET,
      staticDir: webDir,
      commandTimeoutMs: 300,
      eventsThrottleMs: 20,
      log: () => {},
      ...extra,
    });
  }

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "panel-test-"));
    webDir = path.join(tmp, "web");
    await mkdir(path.join(webDir, "sub"), { recursive: true });
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>Panel</title>");
    await writeFile(path.join(webDir, "app.js"), "export {};");
    await writeFile(path.join(webDir, "styles.css"), "body{}");
    await writeFile(path.join(webDir, "manifest.webmanifest"), "{}");
    await writeFile(path.join(webDir, "icon.svg"), "<svg/>");
    await writeFile(path.join(webDir, ".env"), "SECRETO=1");
    await writeFile(path.join(tmp, "secreto.txt"), "no debería verse");
    srv = await start();
    base = `http://127.0.0.1:${srv.port}`;
    wsBase = `ws://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    await srv.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function login(name: string, code: string, ip?: string) {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}) },
      body: JSON.stringify({ name, code }),
    });
    return { status: res.status, body: (await res.json()) as Msg };
  }

  async function client(code = ADMIN, name = "Santiago"): Promise<Peer> {
    const { body } = await login(name, code);
    const peer = await Peer.connect(`${wsBase}/ws/client?token=${encodeURIComponent(body.token)}`);
    const welcome = await peer.type("welcome");
    assert.equal(welcome.name, name);
    return peer;
  }

  async function bridge(event: string, name = "Evento de prueba"): Promise<Peer> {
    const q = new URLSearchParams({ event, name, token: BRIDGE });
    const peer = await Peer.connect(`${wsBase}/ws/bridge?${q}`);
    await peer.type("watch");
    return peer;
  }

  /** GET crudo, sin normalizar la ruta (fetch quitaría los "..") */
  function rawGet(p: string): Promise<{ status: number; headers: Record<string, any>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: p, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  // ------------------------------------------------------------ HTTP

  test("/healthz responde ok", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  test("sirve estáticos con MIME y cabeceras de seguridad", async () => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.equal(root.headers.get("referrer-policy"), "no-referrer");
    assert.match(root.headers.get("content-security-policy") ?? "", /connect-src 'self' ws: wss:/);
    assert.match(await root.text(), /Panel/);

    const types: Record<string, RegExp> = {
      "/app.js": /^text\/javascript/,
      "/styles.css": /^text\/css/,
      "/manifest.webmanifest": /^application\/manifest\+json/,
      "/icon.svg": /^image\/svg\+xml/,
    };
    for (const [p, re] of Object.entries(types)) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type") ?? "", re, p);
      await res.arrayBuffer();
    }
    const missing = await fetch(`${base}/no-existe.js`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });

  test("bloquea salir de la carpeta y archivos ocultos", async () => {
    for (const p of ["/../secreto.txt", "/%2e%2e/secreto.txt", "/sub/..%2f..%2fsecreto.txt", "/..%5csecreto.txt", "/.env", "/sub/"]) {
      const res = await rawGet(p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(res.body, /no debería verse|SECRETO/, p);
    }
  });

  // ------------------------------------------------------------ Login

  test("login correcto para admin y observador; incorrecto da 401", async () => {
    const a = await login("  Santiago  ", ADMIN, "10.0.0.1");
    assert.equal(a.status, 200);
    assert.equal(a.body.role, "admin");
    assert.equal(a.body.name, "Santiago");
    assert.ok(verifyToken(a.body.token, SECRET));

    const v = await login("Jefe", VIEWER, "10.0.0.1");
    assert.equal(v.status, 200);
    assert.equal(v.body.role, "viewer");

    const long = await login("x".repeat(100), ADMIN, "10.0.0.1");
    assert.equal(long.body.name.length, 40);

    const bad = await login("Santiago", "malo", "10.0.0.1");
    assert.equal(bad.status, 401);
    assert.equal(bad.body.token, undefined);
  });

  test("10 intentos fallidos por IP dan 429 (detrás de proxy)", async () => {
    const s = await start({ trustProxy: 1 });
    try {
      const url = `http://127.0.0.1:${s.port}/api/login`;
      const tryLogin = (code: string, ip: string) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": `1.1.1.1, ${ip}` },
          body: JSON.stringify({ name: "Atacante", code }),
        }).then(async (r) => (await r.arrayBuffer(), r.status));
      for (let i = 0; i < 10; i++) assert.equal(await tryLogin("malo", "203.0.113.5"), 401);
      assert.equal(await tryLogin("malo", "203.0.113.5"), 429);
      // Bloqueado incluso con el código correcto.
      assert.equal(await tryLogin(ADMIN, "203.0.113.5"), 429);
      // Otra IP sigue pudiendo entrar.
      assert.equal(await tryLogin(ADMIN, "203.0.113.6"), 200);
    } finally {
      await s.close();
    }
  });

  test("token vencido o alterado se rechaza con 4001", async () => {
    const expired = createToken({ name: "Viejo", role: "admin", exp: Date.now() - 1000 }, SECRET);
    const p1 = await Peer.connect(`${wsBase}/ws/client?token=${encodeURIComponent(expired)}`);
    assert.equal((await p1.closed).code, 4001);

    const good = createToken({ name: "Santiago", role: "viewer", exp: Date.now() + 60_000 }, SECRET);
    const [payload, sig] = good.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ name: "Santiago", role: "admin", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    for (const t of [`${forgedPayload}.${sig}`, `${payload}.${sig!.slice(0, -2)}xx`, "basura", ""]) {
      const p = await Peer.connect(`${wsBase}/ws/client?token=${encodeURIComponent(t)}`);
      assert.equal((await p.closed).code, 4001, t);
    }
    const otherSecret = createToken({ name: "X", role: "admin", exp: Date.now() + 60_000 }, "otro");
    assert.equal(verifyToken(otherSecret, SECRET), null);
  });

  test("puente con token o evento inválido se rechaza", async () => {
    await assert.rejects(Peer.connect(`${wsBase}/ws/bridge?event=boda&token=malo`), /401/);
    await assert.rejects(Peer.connect(`${wsBase}/ws/bridge?event=Boda%20Mal&token=${BRIDGE}`), /400/);
  });

  // ------------------------------------------------------------ Relevo

  test("orden de admin llega al puente y el resultado vuelve con su requestId", async () => {
    const b = await bridge("relevo");
    const c = await client();
    c.send({ type: "command", requestId: "web-1", eventId: "relevo", command: { action: "triggerClip", clipId: 42 } });
    const cmd = await b.type("command");
    assert.deepEqual(cmd.command, { action: "triggerClip", clipId: 42 });
    assert.equal(cmd.by, "Santiago");
    assert.notEqual(cmd.requestId, "web-1");
    b.send({ type: "result", requestId: cmd.requestId, ok: true, data: { hecho: 1 } });
    const res = await c.type("result");
    assert.deepEqual(res, { type: "result", requestId: "web-1", ok: true, data: { hecho: 1 } });
    // Un result con id desconocido no llega a nadie.
    b.send({ type: "result", requestId: "inventado", ok: true });
    await c.none((m) => m.type === "result");
    await Promise.all([b.close(), c.close()]);
  });

  test("observador no puede controlar pero sí pedir miniaturas", async () => {
    const b = await bridge("solo-ver");
    const v = await client(VIEWER, "Jefe");
    v.send({ type: "command", requestId: "v1", eventId: "solo-ver", command: { action: "clearAll" } });
    const denied = await v.type("result");
    assert.equal(denied.requestId, "v1");
    assert.equal(denied.ok, false);
    assert.match(denied.error, /lectura/);

    v.send({ type: "command", requestId: "v2", eventId: "solo-ver", command: { action: "getThumbnail", clipId: 7 } });
    const cmd = await b.type("command");
    assert.equal(cmd.command.action, "getThumbnail");
    assert.equal(cmd.by, "Jefe");
    b.send({ type: "result", requestId: cmd.requestId, ok: true, data: { mime: "image/png", data: "AAAA" } });
    const ok = await v.type("result");
    assert.equal(ok.requestId, "v2");
    assert.equal(ok.ok, true);
    await b.none((m) => m.type === "command" && m.command.action === "clearAll");
    await Promise.all([b.close(), v.close()]);
  });

  test("orden inválida o mensaje desconocido responde error", async () => {
    const c = await client();
    c.send({ type: "command", requestId: "x1", eventId: "relevo", command: { action: "formatearDisco" } });
    const r = await c.type("result");
    assert.equal(r.requestId, "x1");
    assert.equal(r.ok, false);
    c.send({ type: "hackear" });
    assert.equal((await c.type("error")).type, "error");
    c.ws.send("{no es json");
    assert.match((await c.type("error")).message, /JSON/);
    await c.close();
  });

  test("evento no conectado da error", async () => {
    const c = await client();
    c.send({ type: "command", requestId: "n1", eventId: "no-existe", command: { action: "clearAll" } });
    const r = await c.type("result");
    assert.equal(r.requestId, "n1");
    assert.equal(r.ok, false);
    assert.match(r.error, /no está conectado/);
    await c.close();
  });

  test("si el puente no responde, la orden vence", async () => {
    const b = await bridge("lento");
    const c = await client();
    c.send({ type: "command", requestId: "t1", eventId: "lento", command: { action: "setMaster", value: 0.5 } });
    const cmd = await b.type("command");
    const r = await c.type("result", 2000);
    assert.equal(r.requestId, "t1");
    assert.equal(r.ok, false);
    assert.match(r.error, /a tiempo/);
    // Una respuesta tardía se descarta.
    b.send({ type: "result", requestId: cmd.requestId, ok: true });
    await c.none((m) => m.type === "result");
    await Promise.all([b.close(), c.close()]);
  });

  test("si el puente se cae, las órdenes en curso fallan de inmediato", async () => {
    const b = await bridge("caida");
    const c = await client();
    c.send({ type: "command", requestId: "d1", eventId: "caida", command: { action: "clearLayer", layer: 1 } });
    await b.type("command");
    b.ws.terminate();
    const r = await c.type("result");
    assert.equal(r.requestId, "d1");
    assert.equal(r.ok, false);
    await c.close();
  });

  // ------------------------------------------------------------ Suscripción

  test("subscribe recibe último estado, captura y logs, y luego lo nuevo", async () => {
    const b = await bridge("sub-evento", "Boda");
    const state = sampleState();
    b.send({ type: "state", state });
    const entry: LogEntry = { at: Date.now(), level: "info", by: "Santiago", text: "Lanzó Olas" };
    b.send({ type: "log", entry });
    b.send({ type: "snapshot", mime: "image/jpeg", data: "QUJD", at: 123 });
    b.send({ type: "snapshot", mime: "text/html", data: "PHNjcmlwdD4=", at: 124 }); // se ignora

    const c = await client();
    // Espera a que el resumen refleje el estado.
    const evs = await c.next((m) => m.type === "events" && m.events.some((e: Msg) => e.eventId === "sub-evento" && e.resolumeOnline));
    const sum = evs.events.find((e: Msg) => e.eventId === "sub-evento");
    assert.equal(sum.online, true);
    assert.equal(sum.name, "Boda");
    assert.deepEqual(sum.nowPlaying, state.nowPlaying);

    c.send({ type: "subscribe", eventId: "sub-evento", snapshots: true });
    const st = await c.type("state");
    assert.equal(st.eventId, "sub-evento");
    assert.deepEqual(st.state, state);
    const snap = await c.type("snapshot");
    assert.equal(snap.data, "QUJD");
    assert.equal(snap.mime, "image/jpeg");
    const logs = await c.type("logs");
    assert.deepEqual(logs.entries, [entry]);

    b.send({ type: "log", entry: { ...entry, text: "Otro" } });
    assert.equal((await c.type("log")).entry.text, "Otro");
    b.send({ type: "state", state: sampleState({ nowPlaying: [] }) });
    assert.deepEqual((await c.type("state")).state.nowPlaying, []);

    // Sin snapshots ya no llegan capturas.
    c.send({ type: "subscribe", eventId: "sub-evento", snapshots: false });
    await c.type("logs");
    b.send({ type: "snapshot", mime: "image/jpeg", data: "WFla", at: 200 });
    await c.none((m) => m.type === "snapshot");
    await Promise.all([b.close(), c.close()]);
  });

  test("watch true/false al puente según haya quien mire capturas", async () => {
    const b = await bridge("mirar");
    const c1 = await client();
    const c2 = await client();

    c1.send({ type: "subscribe", eventId: "mirar", snapshots: true });
    assert.equal((await b.type("watch")).snapshots, true);
    c2.send({ type: "subscribe", eventId: "mirar", snapshots: true });
    await b.none((m) => m.type === "watch");

    c1.send({ type: "subscribe", eventId: null, snapshots: false });
    await b.none((m) => m.type === "watch");
    await c2.close();
    assert.equal((await b.type("watch")).snapshots, false);

    // Un puente nuevo recibe el estado actual de watch al conectarse.
    c1.send({ type: "subscribe", eventId: "mirar", snapshots: true });
    assert.equal((await b.type("watch")).snapshots, true);
    const b2 = await Peer.connect(`${wsBase}/ws/bridge?event=mirar&name=X&token=${BRIDGE}`);
    assert.equal((await b2.type("watch")).snapshots, true);
    await Promise.all([b2.close(), c1.close()]);
  });

  test("un puente nuevo con el mismo evento reemplaza al viejo", async () => {
    const c = await client();
    const old = await bridge("reemplazo");
    const fresh = await bridge("reemplazo");
    const closed = await old.closed;
    assert.equal(closed.code, 4000);

    c.send({ type: "command", requestId: "r1", eventId: "reemplazo", command: { action: "clearAll" } });
    const cmd = await fresh.type("command");
    fresh.send({ type: "result", requestId: cmd.requestId, ok: true });
    assert.equal((await c.type("result")).ok, true);

    // El evento sigue en línea tras cerrar el viejo; al cerrar el nuevo queda fuera de línea.
    await fresh.close();
    const evs = await c.next((m) => m.type === "events" && m.events.some((e: Msg) => e.eventId === "reemplazo" && !e.online));
    assert.ok(evs);
    await c.close();
  });
});
