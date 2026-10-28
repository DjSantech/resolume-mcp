// Utilidades HTTP compartidas: JSON, cuerpo con límite, IP real y URL pública.
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
    ...extra,
  });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (!done) resolve(null);
      done = true;
    });
  });
}

/** IP del cliente. Con proxies confiables, la toma de X-Forwarded-For contando desde la derecha. */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const direct = req.socket.remoteAddress ?? "desconocida";
  if (trustProxy <= 0) return direct;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return direct;
  const hops = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length === 0) return direct;
  return hops[Math.max(0, hops.length - trustProxy)] ?? direct;
}

const HOST_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-fA-F:.]+\](:\d{1,5})?$/;

function firstHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() ?? "";
}

/** URL pública: la configurada, o la de la petición (con proxy confiable, X-Forwarded-Proto/Host). */
export function publicUrlFor(req: IncomingMessage, configured: string | undefined, trustProxy: number): string {
  if (configured) return configured.replace(/\/+$/, "");
  let proto = "http";
  let host = firstHeader(req, "host");
  if (trustProxy > 0) {
    const fp = firstHeader(req, "x-forwarded-proto").toLowerCase();
    if (fp === "https" || fp === "http") proto = fp;
    const fh = firstHeader(req, "x-forwarded-host");
    if (fh) host = fh;
  }
  if (!HOST_RE.test(host)) host = "localhost";
  return `${proto}://${host}`;
}
