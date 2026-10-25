// Pruebas del puente contra el simulador de Resolume y un servidor WebSocket mínimo dentro de la prueba.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { planDuration } from "../bridge/automation.js";
import { startBridge, type Bridge, type BridgeConfig } from "../bridge/bridge.js";
import { wantedResize } from "../bridge/fit.js";
import { mapComposition, type RClip, type RComposition } from "../bridge/resolume.js";
import { startMockResolume, type MockResolume } from "../mock/mock-resolume.js";
import type { BridgeToServer, Command, EventState, LogEntry } from "../shared/protocol.js";

const TOKEN = "token-secreto-de-prueba-123";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Servidor de mentira

class FakeServer {
  readonly messages: BridgeToServer[] = [];
  readonly urls: URL[] = [];
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private seq = 0;

  private constructor(private readonly wss: WebSocketServer, readonly port: number) {
    wss.on("connection", (ws, req) => {
      this.urls.push(new URL(req.url ?? "/", "http://x"));
      this.socket = ws;
      ws.on("message", (data) => {
        this.messages.push(JSON.parse(String(data)) as BridgeToServer);
        for (const l of this.listeners) l();
      });
    });
  }

  static async start(port = 0): Promise<FakeServer> {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    return new FakeServer(wss, (wss.address() as { port: number }).port);
  }

  /** Primer mensaje desde `from` que cumpla `pred`; espera si aún no llegó. */
  waitFor<T extends BridgeToServer>(pred: (m: BridgeToServer) => m is T, timeoutMs?: number, from?: number): Promise<T>;
  waitFor(pred: (m: BridgeToServer) => boolean, timeoutMs?: number, from?: number): Promise<BridgeToServer>;
  waitFor(pred: (m: BridgeToServer) => boolean, timeoutMs = 3000, from = 0): Promise<BridgeToServer> {
    return new Promise((resolve, reject) => {
      let i = from;
      const check = () => {
        for (; i < this.messages.length; i++) {
          if (pred(this.messages[i])) {
            done();
            resolve(this.messages[i]);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error("tiempo agotado esperando un mensaje del puente"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Espera un `state` (posterior a `from`) que cumpla `pred`. */
  async waitState(pred: (s: EventState) => boolean, timeoutMs = 3000, from = 0): Promise<EventState> {
    const m = await this.waitFor((x) => x.type === "state" && pred(x.state), timeoutMs, from);
    return (m as Extract<BridgeToServer, { type: "state" }>).state;
  }

  lastState(): EventState | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type === "state") return m.state;
    }
    return undefined;
  }

  logs(): LogEntry[] {
    return this.messages.flatMap((m) => (m.type === "log" ? [m.entry] : []));
  }

  sendRaw(msg: unknown): void {
    assert.ok(this.socket, "el puente no está conectado");
    this.socket.send(JSON.stringify(msg));
  }

  async command(command: Command, by = "Prueba", timeoutMs = 5000): Promise<Extract<BridgeToServer, { type: "result" }>> {
    const requestId = `r${++this.seq}`;
    const from = this.messages.length;
    this.sendRaw({ type: "command", requestId, command, by });
    const m = await this.waitFor((x) => x.type === "result" && x.requestId === requestId, timeoutMs, from);
    return m as Extract<BridgeToServer, { type: "result" }>;
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function config(over: Partial<BridgeConfig> & { serverUrl: string }, logs: string[]): BridgeConfig {
  return {
    bridgeToken: TOKEN,
    eventId: "prueba",
    eventName: "Evento de prueba",
    pollMs: 100,
    snapshotMs: 100,
    minAutomationSeconds: 0.1,
    deckSettleMs: 0,
    retryMs: 100,
    reconnectMinMs: 50,
    logger: (line) => logs.push(line),
    ...over,
  };
}

const idOf = (mock: MockResolume, name: string) => {
  const found = mock.clipByName(name);
  assert.ok(found, `no existe el clip ${name} en el simulador`);
  return found.clip.id;
};

// ---------------------------------------------------------------- Unidades

describe("conversión y cálculos", () => {
  test("mapea el JSON de Resolume a EventState", async () => {
    const mock = await startMockResolume({ port: 0 });
    try {
      const raw = (await (await fetch(`${mock.url}/api/v1/composition`)).json()) as RComposition;
      const { composition: c, nowPlaying } = mapComposition(raw);
      assert.equal(c.name, "Evento Demo");
      assert.equal(c.bpm, 128);
      assert.equal(c.master, 1);
      assert.deepEqual([c.width, c.height], [1920, 1080]);
      assert.deepEqual(c.decks.map((d) => [d.index, d.name, d.selected]), [[1, "Fiesta", true], [2, "Protocolo", false]]);
      assert.deepEqual(c.columns.map((x) => x.name), ["Columna 1", "Columna 2", "Columna 3", "Columna 4"]);
      assert.deepEqual(c.layers.map((l) => l.name), ["Capa 1", "Capa 2", "Capa 3"]);
      assert.equal(c.layers[0].opacity, 1);
      assert.equal(c.layers[0].bypassed, false);

      const [tunnel, gold, portrait, empty] = c.layers[0].clips;
      assert.equal(tunnel.name, "Tunnel Neon");
      assert.equal(tunnel.column, 1);
      assert.equal(tunnel.state, "disconnected");
      assert.equal(tunnel.isFile, true);
      assert.ok(Math.abs((tunnel.durationS ?? 0) - 20.053) < 0.001);
      assert.equal(gold.durationS, 40.08);
      assert.equal(portrait.isFile, true);
      assert.equal(empty.state, "empty");
      assert.equal(empty.durationS, undefined);
      const router = c.layers[1].clips[0];
      assert.equal(router.name, "Video Router");
      assert.equal(router.isFile, false);
      assert.deepEqual(nowPlaying, []);

      // Estados de clip y nowPlaying.
      await fetch(`${mock.url}/api/v1/composition/clips/by-id/${gold.id}/connect`, { method: "POST" });
      const raw2 = (await (await fetch(`${mock.url}/api/v1/composition`)).json()) as RComposition;
      const mapped = mapComposition(raw2);
      assert.equal(mapped.composition.layers[0].clips[1].state, "connected");
      assert.deepEqual(mapped.nowPlaying, [{ layer: 1, layerName: "Capa 1", column: 2, clipId: gold.id, name: "Gold Particles" }]);
      const states = { layers: [{ clips: ["Empty", "Disconnected", "Previewing", "Connected", "Connected & previewing"].map((v, i) => ({ id: i + 1, connected: { value: v } })) }] };
      assert.deepEqual(mapComposition(states).composition.layers[0].clips.map((x) => x.state), ["empty", "disconnected", "previewing", "connected", "connected"]);
    } finally {
      await mock.close();
    }
  });

  test("planDuration: repeticiones enteras si caben, si no un corte dentro del rango", () => {
    for (let i = 0; i < 50; i++) {
      const p = planDuration(10, 25, 35);
      assert.equal(p.seconds, 30);
      assert.equal(p.how, "3 repeticiones");
      const once = planDuration(120, 100, 150);
      assert.deepEqual(once, { seconds: 120, how: "1 pasada completa" });
      const long = planDuration(20, 0.2, 0.4);
      assert.ok(long.seconds >= 0.2 && long.seconds <= 0.4);
      assert.equal(long.how, "clip largo, se corta");
      const none = planDuration(0, 5, 6);
      assert.ok(none.seconds >= 5 && none.seconds <= 6);
      assert.equal(none.how, "se corta dentro del rango");
      const multi = planDuration(0.1, 0.2, 0.4);
      assert.ok([0.2, 0.3, 0.4].some((v) => Math.abs(v - multi.seconds) < 1e-9), `obtuve ${multi.seconds}`);
    }
  });

  test("ajuste: Fill si la proporción está a ±10 %, Fit si no, nada si no es archivo", () => {
    const clip = (w?: number, h?: number): RClip => ({ video: { fileinfo: w ? { width: w, height: h } : null } });
    const ratio = 16 / 9;
    assert.equal(wantedResize(clip(960, 540), ratio), "Fill");
    assert.equal(wantedResize(clip(1920, 1080), ratio), "Fill");
    assert.equal(wantedResize(clip(1080, 1920), ratio), "Fit");
    assert.equal(wantedResize(clip(1024, 768), ratio), "Fit");
    assert.equal(wantedResize(clip(), ratio), null);
  });
});

// ---------------------------------------------------------------- Puente completo

describe("puente con simulador", () => {
  let mock: MockResolume;
  let server: FakeServer;
  let bridge: Bridge;
  let dataDir: string;
  const logs: string[] = [];

  before(async () => {
    mock = await startMockResolume({ port: 0, deckSwitchMs: 150 });
    server = await FakeServer.start();
    dataDir = await mkdtemp(join(tmpdir(), "puente-"));
    bridge = await startBridge(config({ serverUrl: `ws://127.0.0.1:${server.port}`, resolumeUrl: mock.url, dataDir }, logs));
    await server.waitFor((m) => m.type === "hello");
  });

  after(async () => {
    await bridge?.stop();
    await server?.close();
    await mock?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("se presenta y manda el estado de Resolume", async () => {
    const url = server.urls[0];
    assert.equal(url.pathname, "/ws/bridge");
    assert.equal(url.searchParams.get("event"), "prueba");
    assert.equal(url.searchParams.get("name"), "Evento de prueba");
    assert.equal(url.searchParams.get("token"), TOKEN);
    const hello = server.messages.find((m) => m.type === "hello");
    assert.deepEqual(hello && { ...hello, bridgeVersion: "" }, { type: "hello", eventId: "prueba", name: "Evento de prueba", bridgeVersion: "" });

    const state = await server.waitState((s) => s.resolumeOnline);
    assert.deepEqual(state.resolume, { product: "Arena", version: "7.28.1" });
    assert.equal(state.composition?.layers.length, 3);
    assert.deepEqual(state.automations, []);
    assert.equal(state.runner, null);
  });

  test("triggerClip ajusta Fill/Fit y escala 100 antes de conectar", async () => {
    const tunnel = mock.clipByName("Tunnel Neon")!.clip;
    assert.equal(tunnel.video!.resize.value, "Original");
    const scale = tunnel.video!.effects[0].params.Scale;
    assert.equal(scale.value, 50);

    mock.clearRequests();
    const r = await server.command({ action: "triggerClip", clipId: tunnel.id });
    assert.equal(r.ok, true, r.error);
    assert.equal(tunnel.video!.resize.value, "Fill");
    assert.equal(scale.value, 100);
    assert.equal(mock.connectedClip(1), tunnel.id);
    const writes = mock.requests.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path}`);
    assert.deepEqual(writes, [
      `PUT /api/v1/parameter/by-id/${tunnel.video!.resize.id}`,
      `PUT /api/v1/parameter/by-id/${scale.id}`,
      `POST /api/v1/composition/clips/by-id/${tunnel.id}/connect`,
    ]);

    const portrait = mock.clipByName("Flores Vertical")!.clip;
    assert.equal((await server.command({ action: "triggerClip", clipId: portrait.id })).ok, true);
    assert.equal(portrait.video!.resize.value, "Fit");
    assert.equal(mock.connectedClip(1), portrait.id);

    // Video Router: no es archivo, no se toca su resize.
    const router = mock.clipByName("Video Router")!.clip;
    mock.clearRequests();
    assert.equal((await server.command({ action: "triggerClip", clipId: router.id })).ok, true);
    assert.equal(mock.requests.filter((q) => q.method === "PUT").length, 0);
    assert.equal(mock.connectedClip(2), router.id);

    const st = await server.waitState((s) => s.nowPlaying.some((n) => n.clipId === router.id));
    assert.ok(st.nowPlaying.some((n) => n.clipId === portrait.id && n.layer === 1 && n.column === 3));
    assert.ok(server.logs().some((l) => l.by === "Prueba" && l.text.includes("Flores Vertical")));
  });

  test("triggerClip sobre una celda vacía o inexistente devuelve error", async () => {
    const empty = mock.fixture.deckClips[0][0][3];
    const r = await server.command({ action: "triggerClip", clipId: empty.id });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /vacía/);
    const r2 = await server.command({ action: "triggerClip", clipId: 999 });
    assert.equal(r2.ok, false);
  });

  test("setBpm, setMaster y setLayerOpacity escriben el parámetro correcto", async () => {
    const comp = mock.fixture.composition;
    mock.clearRequests();
    assert.equal((await server.command({ action: "setBpm", bpm: 132.5 })).ok, true);
    assert.equal((await server.command({ action: "setMaster", value: 0.4 })).ok, true);
    assert.equal((await server.command({ action: "setLayerOpacity", layer: 2, value: 0.25 })).ok, true);
    assert.equal(comp.tempocontroller.tempo.value, 132.5);
    assert.equal(comp.master.value, 0.4);
    assert.equal(comp.layers[1].video.opacity.value, 0.25);
    assert.deepEqual(
      mock.requests.filter((q) => q.method === "PUT").map((q) => [q.path, q.body]),
      [
        [`/api/v1/parameter/by-id/${comp.tempocontroller.tempo.id}`, { value: 132.5 }],
        [`/api/v1/parameter/by-id/${comp.master.id}`, { value: 0.4 }],
        [`/api/v1/parameter/by-id/${comp.layers[1].video.opacity.id}`, { value: 0.25 }],
      ],
    );
    // Valores fuera de rango se recortan; capa inexistente da error.
    assert.equal((await server.command({ action: "setMaster", value: 7 })).ok, true);
    assert.equal(comp.master.value, 1);
    assert.equal((await server.command({ action: "setLayerOpacity", layer: 9, value: 0.5 })).ok, false);
    // El estado que se manda refleja los tres cambios.
    await server.waitState((s) => s.composition?.bpm === 132.5 && s.composition.layers[1].opacity === 0.25 && s.composition.master === 1);
  });

  test("triggerColumn, clearLayer y clearAll", async () => {
    assert.equal((await server.command({ action: "triggerColumn", column: 1 })).ok, true);
    assert.equal(mock.connectedClip(1), idOf(mock, "Tunnel Neon"));
    assert.equal(mock.connectedClip(2), idOf(mock, "Video Router"));
    assert.equal((await server.command({ action: "clearLayer", layer: 2 })).ok, true);
    assert.equal(mock.connectedClip(2), null);
    assert.equal((await server.command({ action: "clearAll" })).ok, true);
    assert.equal(mock.connectedClip(1), null);
  });

  test("getThumbnail devuelve un PNG en base64", async () => {
    const r = await server.command({ action: "getThumbnail", clipId: idOf(mock, "Gold Particles") });
    assert.equal(r.ok, true);
    const data = r.data as { mime: string; data: string };
    assert.equal(data.mime, "image/png");
    assert.ok(data.data.startsWith("iVBORw0KGgo"));
  });

  test("manda capturas solo mientras alguien mira", async () => {
    const from = server.messages.length;
    server.sendRaw({ type: "watch", snapshots: true });
    const snap = await server.waitFor((m) => m.type === "snapshot", 2000, from);
    assert.equal(snap.type === "snapshot" && snap.mime, "image/jpeg");
    assert.ok(snap.type === "snapshot" && snap.data.startsWith("/9j/"));
    assert.ok(mock.requests.some((q) => q.path === "/api/v1/composition/monitors/1/snapshot.jpg"));
    server.sendRaw({ type: "watch", snapshots: false });
    await sleep(250);
    const count = server.messages.filter((m) => m.type === "snapshot").length;
    await sleep(350);
    assert.equal(server.messages.filter((m) => m.type === "snapshot").length, count);
  });

  test("selectDeck espera a que Resolume abra la pestaña", async () => {
    const t0 = Date.now();
    const r = await server.command({ action: "selectDeck", deckIndex: 2 });
    assert.equal(r.ok, true, r.error);
    assert.ok(Date.now() - t0 >= 150, "debió esperar el cambio de pestaña");
    assert.equal(mock.selectedDeck(), 2);
    const st = await server.waitState((s) => s.composition?.decks[1].selected === true);
    assert.equal(st.composition?.layers[0].clips[0].name, "Cortina Azul");
    assert.equal((await server.command({ action: "selectDeck", deckIndex: 5 })).ok, false);
    assert.equal((await server.command({ action: "selectDeck", deckIndex: 1 })).ok, true);
    assert.equal(mock.selectedDeck(), 1);
  });

  test("órdenes inválidas devuelven error sin tumbar el puente", async () => {
    assert.equal((await server.command({ action: "nada" } as unknown as Command)).ok, false);
    assert.equal((await server.command({ action: "setBpm", bpm: "rápido" } as unknown as Command)).ok, false);
    assert.equal((await server.command({ action: "stopAutomation" })).ok, false);
    assert.equal((await server.command({ action: "skipAutomation" })).ok, false);
    assert.equal((await server.command({ action: "startAutomation", id: "no-existe" })).ok, false);
    server.sendRaw("esto no es una orden");
    assert.equal((await server.command({ action: "clearAll" })).ok, true);
  });

  let savedId = "";

  test("saveAutomation valida y persiste en DATA_DIR", async () => {
    const bad = await server.command({
      action: "saveAutomation",
      automation: { id: "", name: "Mala", deckName: "", layer: 1, clips: [], minSeconds: 5, maxSeconds: 1, order: "sequential", fit: true },
    });
    assert.equal(bad.ok, false);

    const tunnel = idOf(mock, "Tunnel Neon"), gold = idOf(mock, "Gold Particles");
    const r = await server.command({
      action: "saveAutomation",
      automation: {
        id: "",
        name: "Ronda rápida",
        deckName: "",
        layer: 1,
        clips: [{ clipId: tunnel, column: 1, name: "Tunnel Neon" }, { clipId: gold, column: 2, name: "Gold Particles" }],
        minSeconds: 0.2,
        maxSeconds: 0.4,
        order: "sequential",
        fit: true,
      },
    });
    assert.equal(r.ok, true, r.error);
    savedId = (r.data as { id: string }).id;
    assert.ok(savedId);
    const st = await server.waitState((s) => s.automations.some((a) => a.id === savedId));
    assert.equal(st.automations[0].name, "Ronda rápida");
    const file = JSON.parse(await readFile(join(dataDir, "automations.json"), "utf8")) as { automations: { id: string }[] };
    assert.deepEqual(file.automations.map((a) => a.id), [savedId]);
  });

  test("la automatización elige tiempos dentro del rango y avanza", async () => {
    const tunnel = idOf(mock, "Tunnel Neon"), gold = idOf(mock, "Gold Particles");
    mock.fixture.deckClips[0][0][0].video!.resize.value = "Original";
    const from = server.messages.length;
    assert.equal((await server.command({ action: "startAutomation", id: savedId })).ok, true);

    const first = await server.waitState((s) => s.runner?.current?.clipId === tunnel, 2000, from);
    const cur = first.runner!.current!;
    const span = cur.until - cur.startedAt;
    assert.ok(span >= 200 && span <= 400, `duración ${span} ms fuera de 0.2-0.4 s`);
    assert.equal(cur.how, "clip largo, se corta");
    assert.equal(first.runner!.next?.clipId, gold);
    assert.equal(first.runner!.automationName, "Ronda rápida");

    const second = await server.waitState((s) => s.runner?.current?.clipId === gold, 2000, from);
    const span2 = second.runner!.current!.until - second.runner!.current!.startedAt;
    assert.ok(span2 >= 200 && span2 <= 400);
    assert.equal(mock.connectedClip(1), gold);
    // Se ajustó antes de lanzar.
    assert.equal(mock.fixture.deckClips[0][0][0].video!.resize.value, "Fill");

    await server.waitState((s) => (s.runner?.loops ?? 0) >= 1, 2000, from);
    assert.ok(server.logs().some((l) => l.by === "automatización" && /Col 1: Tunnel Neon/.test(l.text)));

    const beforeStop = server.messages.length;
    assert.equal((await server.command({ action: "stopAutomation" })).ok, true);
    await server.waitState((s) => s.runner === null, 2000, beforeStop);
  });

  test("skipAutomation pasa al siguiente y stopAutomation deja el clip sonando", async () => {
    const tunnel = idOf(mock, "Tunnel Neon"), gold = idOf(mock, "Gold Particles");
    const r = await server.command({
      action: "saveAutomation",
      automation: {
        id: "larga",
        name: "Larga",
        deckName: "",
        layer: 1,
        clips: [{ clipId: tunnel, column: 1, name: "Tunnel Neon" }, { clipId: gold, column: 2, name: "Gold Particles" }],
        minSeconds: 5,
        maxSeconds: 6,
        order: "sequential",
        fit: false,
      },
    });
    assert.equal(r.ok, true, r.error);
    const from = server.messages.length;
    assert.equal((await server.command({ action: "startAutomation", id: "larga" })).ok, true);
    await server.waitState((s) => s.runner?.current?.clipId === tunnel, 2000, from);

    const t0 = Date.now();
    assert.equal((await server.command({ action: "skipAutomation" })).ok, true);
    await server.waitState((s) => s.runner?.current?.clipId === gold, 1000, from);
    assert.ok(Date.now() - t0 < 1000, "el salto debió ser inmediato");
    assert.equal(mock.connectedClip(1), gold);

    const beforeStop = server.messages.length;
    assert.equal((await server.command({ action: "stopAutomation" })).ok, true);
    await server.waitState((s) => s.runner === null, 2000, beforeStop);
    await sleep(300);
    assert.equal(mock.connectedClip(1), gold, "el clip actual debe seguir sonando");
  });

  test("sin clips elegidos recorre la capa de la pestaña indicada, barajando sin repetir", async () => {
    const r = await server.command({
      action: "saveAutomation",
      automation: { id: "proto", name: "Protocolo", deckName: "protocolo", layer: 1, clips: [], minSeconds: 0.1, maxSeconds: 0.15, order: "shuffle", fit: true },
    });
    assert.equal(r.ok, true, r.error);
    const from = server.messages.length;
    assert.equal((await server.command({ action: "startAutomation", id: "proto" })).ok, true);
    assert.equal(mock.selectedDeck(), 2, "debió abrir la pestaña Protocolo");

    const launched: string[] = [];
    const deadline = Date.now() + 4000;
    while (launched.length < 6 && Date.now() < deadline) {
      await sleep(50);
      launched.splice(0, launched.length, ...server.messages.slice(from)
        .flatMap((m) => (m.type === "log" && m.entry.by === "automatización" && m.entry.text.startsWith("Col") ? [m.entry.text] : [])));
    }
    assert.ok(launched.length >= 6, `solo se lanzaron ${launched.length}`);
    const names = launched.map((t) => /^Col \d+: (.+?) →/.exec(t)?.[1]);
    for (const n of names) assert.ok(n === "Cortina Azul" || n === "Brillo Suave", `clip inesperado: ${n}`);
    for (let i = 1; i < names.length; i++) assert.notEqual(names[i], names[i - 1], "repitió el mismo clip seguido");

    assert.equal((await server.command({ action: "stopAutomation" })).ok, true);
    assert.equal((await server.command({ action: "selectDeck", deckIndex: 1 })).ok, true);
  });

  test("deleteAutomation la borra del archivo", async () => {
    assert.equal((await server.command({ action: "deleteAutomation", id: "proto" })).ok, true);
    assert.equal((await server.command({ action: "deleteAutomation", id: "proto" })).ok, false);
    const file = JSON.parse(await readFile(join(dataDir, "automations.json"), "utf8")) as { automations: { id: string }[] };
    assert.deepEqual(file.automations.map((a) => a.id).sort(), [savedId, "larga"].sort());
  });

  test("nunca imprime el token", () => {
    assert.ok(logs.length > 0);
    for (const line of logs) assert.ok(!line.includes(TOKEN), `el token apareció en: ${line}`);
    for (const l of server.logs()) assert.ok(!l.text.includes(TOKEN));
  });
});

// ---------------------------------------------------------------- Persistencia y fallas

test("las automatizaciones guardadas sobreviven a un reinicio del puente", async () => {
  const mock = await startMockResolume({ port: 0 });
  const server = await FakeServer.start();
  const dataDir = await mkdtemp(join(tmpdir(), "puente-"));
  const logs: string[] = [];
  const cfg = config({ serverUrl: `ws://127.0.0.1:${server.port}`, resolumeUrl: mock.url, dataDir }, logs);
  try {
    let bridge = await startBridge(cfg);
    await server.waitFor((m) => m.type === "hello");
    const r = await server.command({
      action: "saveAutomation",
      automation: { id: "fiesta-1", name: "Fiesta", deckName: "Fiesta", layer: 1, clips: [], minSeconds: 120, maxSeconds: 180, order: "shuffle", fit: true },
    });
    assert.equal(r.ok, true, r.error);
    await bridge.stop();

    const from = server.messages.length;
    bridge = await startBridge(cfg);
    const st = await server.waitState((s) => s.automations.length > 0, 3000, from);
    assert.equal(st.automations[0].id, "fiesta-1");
    assert.equal(st.automations[0].order, "shuffle");
    assert.equal(st.runner, null, "no retoma la automatización tras reiniciar");
    await bridge.stop();
  } finally {
    await server.close();
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sin Resolume informa resolumeOnline=false y las órdenes fallan con error", async () => {
  const server = await FakeServer.start();
  const dataDir = await mkdtemp(join(tmpdir(), "puente-"));
  const logs: string[] = [];
  const bridge = await startBridge(config({ serverUrl: `ws://127.0.0.1:${server.port}`, resolumeUrl: `http://127.0.0.1:${await freePort()}`, dataDir }, logs));
  try {
    const st = await server.waitState(() => true);
    assert.equal(st.resolumeOnline, false);
    assert.equal(st.composition, null);
    assert.equal(st.resolume, null);
    const r = await server.command({ action: "triggerClip", clipId: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Resolume/);
    assert.ok(server.logs().some((l) => l.level === "warn" && /Sin conexión con Resolume/.test(l.text)));
  } finally {
    await bridge.stop();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sin servidor no se cae y reconecta cuando aparece", async () => {
  const mock = await startMockResolume({ port: 0 });
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "puente-"));
  const logs: string[] = [];
  const bridge = await startBridge(config({ serverUrl: `ws://127.0.0.1:${port}`, resolumeUrl: mock.url, dataDir }, logs));
  let server: FakeServer | null = null;
  try {
    await sleep(400);
    assert.ok(logs.some((l) => l.includes("No pude conectar al servidor")));
    server = await FakeServer.start(port);
    await server.waitFor((m) => m.type === "hello", 5000);
    const st = await server.waitState((s) => s.resolumeOnline, 3000);
    assert.equal(st.composition?.name, "Evento Demo");

    // Se corta el servidor y vuelve: el puente reconecta solo.
    await server.close();
    await sleep(200);
    server = await FakeServer.start(port);
    await server.waitFor((m) => m.type === "hello", 5000);
    for (const line of logs) assert.ok(!line.includes(TOKEN));
  } finally {
    await bridge.stop();
    await server?.close();
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
