// Página local del agente (solo 127.0.0.1). Protegida contra CSRF y DNS rebinding:
// Host debe ser 127.0.0.1/localhost:<puerto>, /api/* exige el token aleatorio del proceso (en la página)
// en la cabecera X-VM-Token, y los POST exigen JSON y un Origin propio (si viene).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { renderPage } from "./ui.js";

export interface AgentApi {
  status(): unknown;
  pair(body: Record<string, unknown>): Promise<unknown>;
  unpair(): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;
}

/** Error con código HTTP y mensaje para mostrar. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** null si la petición se acepta; si no, el motivo del rechazo. */
export function checkRequest(
  req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> },
  port: number, token: string,
): { status: number; error: string } | null {
  const h = (k: string) => { const v = req.headers[k]; return Array.isArray(v) ? v[0] ?? "" : v ?? ""; };
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(h("host").toLowerCase())) return { status: 403, error: "Host no permitido" };
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";
  if (path.startsWith("/api/")) {
    if (!sameToken(h("x-vm-token"), token)) return { status: 403, error: "Token inválido" };
  }
  if (method !== "GET" && method !== "HEAD") {
    const origin = h("origin");
    if (origin && !hosts.map((x) => `http://${x}`).includes(origin.toLowerCase())) return { status: 403, error: "Origen no permitido" };
    const site = h("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return { status: 403, error: "Origen no permitido" };
    if (!h("content-type").toLowerCase().startsWith("application/json")) return { status: 415, error: "Se espera JSON" };
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, "Petición demasiado grande");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createLocalServer(agent: AgentApi, token: string): Server {
  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : "Error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    const bad = checkRequest(req, port, token);
    if (bad) return send(res, bad.status, { error: bad.error });
    const path = (req.url ?? "/").split("?")[0];
    const key = `${req.method} ${path}`;
    switch (key) {
      case "GET /": {
        const nonce = randomBytes(16).toString("base64");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(renderPage(token, nonce));
        return;
      }
      case "GET /api/estado":
        return send(res, 200, agent.status());
      case "POST /api/vincular":
        return send(res, 200, await agent.pair(await readJson(req)));
      case "POST /api/desvincular":
        await readJson(req);
        await agent.unpair();
        return send(res, 200, { ok: true });
      case "POST /api/inicio-windows": {
        const body = await readJson(req);
        await agent.setAutostart(body.enabled === true);
        return send(res, 200, { ok: true });
      }
      default:
        if (req.method === "GET" && path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
        return send(res, 404, { error: "No encontrado" });
    }
  }

  return server;
}

/** Escucha en 127.0.0.1:port. Con retryMs reintenta mientras el puerto esté ocupado (tras actualizar). */
export async function listenLocal(server: Server, port: number, retryMs = 0): Promise<void> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      await new Promise<void>((ok, ko) => {
        const onErr = (e: Error) => { server.off("listening", onOk); ko(e); };
        const onOk = () => { server.off("error", onErr); ok(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
