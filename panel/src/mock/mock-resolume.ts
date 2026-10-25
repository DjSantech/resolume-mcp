#!/usr/bin/env node
// Simulador del Webserver de Resolume Arena (solo la parte de la API que usa el puente).
// Guarda estado (clip conectado por capa, valores de parámetros, pestaña abierta) para poder ver el efecto de las órdenes.
// Uso: npm run mock            → escucha en el puerto 8090 (o MOCK_PORT)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { buildFixture, CLIP_STATES, type ClipJson, type Fixture, type Param } from "./fixtures/composition.js";
import { colorFor, gradientPng, solidJpeg } from "./fixtures/images.js";

export interface MockOptions {
  port?: number;
  host?: string;
  /** Cuánto tarda en cambiar de pestaña tras `decks/{n}/select` (el real tarda ~1 s). */
  deckSwitchMs?: number;
}

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface MockResolume {
  port: number;
  url: string;
  close(): Promise<void>;
  fixture: Fixture;
  /** Peticiones recibidas, en orden. */
  requests: MockRequest[];
  clearRequests(): void;
  /** Id del clip conectado en la capa (1 = primera), o null. */
  connectedClip(layer: number): number | null;
  /** Pestaña abierta (1 = primera). */
  selectedDeck(): number;
  param(id: number): Param | undefined;
  clip(id: number): ClipJson | undefined;
  /** Busca un clip por nombre en cualquier pestaña. */
  clipByName(name: string): { clip: ClipJson; deck: number; layer: number; column: number } | undefined;
}

const SNAPSHOT = solidJpeg(128, 72, 48);

export async function startMockResolume(opts: MockOptions = {}): Promise<MockResolume> {
  const fixture = buildFixture();
  const comp = fixture.composition;
  const deckSwitchMs = opts.deckSwitchMs ?? 1000;
  const requests: MockRequest[] = [];

  // Índices: parámetros por id y clips por id (con su ubicación).
  const params = new Map<number, Param>();
  const clips = new Map<number, { clip: ClipJson; deck: number; layer: number; column: number }>();
  const indexParams = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(indexParams);
    const o = node as Record<string, unknown>;
    if (typeof o.valuetype === "string" && typeof o.id === "number") params.set(o.id, o as unknown as Param);
    for (const v of Object.values(o)) indexParams(v);
  };
  indexParams(comp);
  fixture.deckClips.forEach((layers, d) =>
    layers.forEach((row, l) =>
      row.forEach((clip, c) => {
        indexParams(clip);
        clips.set(clip.id, { clip, deck: d + 1, layer: l + 1, column: c + 1 });
      }),
    ),
  );

  // Resolume descarta los cambios de resize/escala hechos por la API al cambiar de pestaña: se imita.
  const volatile = new Map<Param, unknown>();
  for (const { clip } of clips.values()) {
    if (!clip.video) continue;
    volatile.set(clip.video.resize, clip.video.resize.value);
    const scale = clip.video.effects.find((e) => e.name === "Transform")?.params.Scale;
    if (scale) volatile.set(scale, scale.value);
  }

  let deck = 1;
  const active = new Map<number, number>(); // capa → id del clip conectado
  const timers = new Set<NodeJS.Timeout>();

  const refreshStates = () => {
    for (const { clip, layer } of clips.values()) {
      const empty = clip.video === null && clip.transport === null;
      const value = empty ? "Empty" : active.get(layer) === clip.id ? "Connected" : "Disconnected";
      clip.connected.value = value;
      clip.connected.index = CLIP_STATES.indexOf(value);
    }
    comp.decks.forEach((d, i) => (d.selected.value = i + 1 === deck));
  };

  const isEmpty = (clip: ClipJson) => clip.video === null && clip.transport === null;

  const compositionJson = () => {
    refreshStates();
    const clipsOfDeck = fixture.deckClips[deck - 1];
    return { ...comp, layers: comp.layers.map((l, i) => ({ ...l, clips: clipsOfDeck[i] ?? [] })) };
  };

  const setParam = (p: Param, value: unknown): string | null => {
    switch (p.valuetype) {
      case "ParamRange":
      case "ParamNumber": {
        const n = Number(value);
        if (!Number.isFinite(n)) return "valor no numérico";
        p.value = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n));
        return null;
      }
      case "ParamChoice": {
        const i = p.options?.indexOf(String(value)) ?? -1;
        if (i < 0) return "opción inválida";
        p.value = p.options![i];
        p.index = i;
        return null;
      }
      case "ParamBoolean":
        if (typeof value !== "boolean") return "se esperaba booleano";
        p.value = value;
        return null;
      case "ParamString":
        p.value = String(value);
        return null;
      default:
        return "parámetro de solo lectura";
    }
  };

  const send = (res: ServerResponse, status: number, body?: unknown, type = "application/json") => {
    if (body === undefined) {
      res.writeHead(status).end();
    } else if (Buffer.isBuffer(body)) {
      res.writeHead(status, { "Content-Type": type, "Content-Length": body.length }).end(body);
    } else {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" }).end(text);
    }
  };
  const notFound = (res: ServerResponse) => send(res, 404, { error: "Not found" });

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://mock").pathname.replace(/\/+$/, "");
    const text = await readBody(req);
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    requests.push({ method, path, body });

    const p = path.startsWith("/api/v1") ? path.slice("/api/v1".length) : null;
    if (p === null) return notFound(res);
    let m: RegExpMatchArray | null;

    if (method === "GET" && p === "/product") return send(res, 200, fixture.product);
    if (method === "GET" && p === "/composition") return send(res, 200, compositionJson());
    if (method === "GET" && p === "/composition/monitors") return send(res, 200, fixture.monitors);
    if (method === "GET" && (m = p.match(/^\/composition\/monitors\/(\d+)\/snapshot\.jpg$/))) {
      if (!fixture.monitors.some((mon) => mon.id === Number(m![1]))) return notFound(res);
      return send(res, 200, SNAPSHOT, "image/jpeg");
    }
    if (method === "POST" && p === "/composition/disconnect-all") {
      active.clear();
      return send(res, 204);
    }
    if (method === "POST" && (m = p.match(/^\/composition\/columns\/(\d+)\/connect$/))) {
      const col = Number(m[1]);
      if (col < 1 || col > comp.columns.length) return notFound(res);
      fixture.deckClips[deck - 1].forEach((row, l) => {
        const clip = row[col - 1];
        if (!clip || isEmpty(clip)) active.delete(l + 1);
        else active.set(l + 1, clip.id);
      });
      return send(res, 204);
    }
    if (method === "POST" && (m = p.match(/^\/composition\/layers\/(\d+)\/clear$/))) {
      const layer = Number(m[1]);
      if (layer < 1 || layer > comp.layers.length) return notFound(res);
      active.delete(layer);
      return send(res, 204);
    }
    if (method === "POST" && (m = p.match(/^\/composition\/decks\/(\d+)\/select$/))) {
      const n = Number(m[1]);
      if (n < 1 || n > comp.decks.length) return notFound(res);
      const t = setTimeout(() => {
        timers.delete(t);
        if (n !== deck) for (const [param, value] of volatile) setParam(param, value);
        deck = n;
      }, deckSwitchMs);
      timers.add(t);
      return send(res, 204);
    }
    if ((m = p.match(/^\/composition\/clips\/by-id\/(\d+)(\/connect|\/thumbnail)?$/))) {
      const entry = clips.get(Number(m[1]));
      if (!entry) return notFound(res);
      if (method === "GET" && !m[2]) {
        refreshStates();
        return send(res, 200, entry.clip);
      }
      if (method === "POST" && m[2] === "/connect") {
        // Sin cuerpo = clic corto. Un clip vacío no hace nada.
        if (body !== false && !isEmpty(entry.clip)) active.set(entry.layer, entry.clip.id);
        return send(res, 204);
      }
      if (method === "GET" && m[2] === "/thumbnail") {
        return send(res, 200, gradientPng(64, 36, isEmpty(entry.clip) ? [40, 40, 40] : colorFor(entry.clip.id)), "image/png");
      }
    }
    if ((m = p.match(/^\/parameter\/by-id\/(\d+)$/))) {
      const param = params.get(Number(m[1]));
      if (!param) return notFound(res);
      if (method === "GET") {
        refreshStates();
        return send(res, 200, param);
      }
      if (method === "PUT") {
        const value = body && typeof body === "object" ? (body as { value?: unknown }).value : undefined;
        const error = setParam(param, value);
        return error ? send(res, 400, { error }) : send(res, 204);
      }
    }
    return notFound(res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8090, opts.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port ?? 8090;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    fixture,
    requests,
    clearRequests: () => void requests.splice(0),
    connectedClip: (layer) => active.get(layer) ?? null,
    selectedDeck: () => deck,
    param: (id) => params.get(id),
    clip: (id) => clips.get(id)?.clip,
    clipByName: (name) => [...clips.values()].find((e) => e.clip.name.value === name),
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// Ejecución directa: npm run mock
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT ?? 8090);
  startMockResolume({ port, host: process.env.MOCK_HOST ?? "127.0.0.1" }).then(
    (mock) => {
      console.log(`Simulador de Resolume en ${mock.url}  (usa RESOLUME_URL=${mock.url} en el puente)`);
      process.on("SIGINT", () => void mock.close().then(() => process.exit(0)));
    },
    (e: unknown) => {
      console.error(`No pude abrir el simulador en el puerto ${port}: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
