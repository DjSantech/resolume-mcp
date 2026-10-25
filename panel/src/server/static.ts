// Archivos estáticos de la web: sin listar carpetas y sin salir de STATIC_DIR.
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("No encontrado");
}

/**
 * Resuelve la ruta pedida a un archivo dentro de root, o null.
 * root debe ser una ruta real (sin enlaces simbólicos).
 */
async function resolveFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  // Archivos ocultos (.env, .git…) nunca se sirven.
  if (decoded.split("/").some((seg) => seg.startsWith("."))) return null;
  let target = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  if (!isInside(root, target)) return null;
  try {
    let st = await stat(target);
    if (st.isDirectory()) {
      target = path.join(target, "index.html");
      st = await stat(target);
    }
    if (!st.isFile()) return null;
    // Evita salir por enlaces simbólicos.
    const real = await realpath(target);
    if (!isInside(root, real)) return null;
    return real;
  } catch {
    return null;
  }
}

export function createStaticHandler(staticDir: string) {
  let rootPromise: Promise<string> | null = null;
  const getRoot = () => (rootPromise ??= realpath(path.resolve(staticDir)).catch(() => path.resolve(staticDir)));

  return async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Método no permitido");
      return;
    }
    const root = await getRoot();
    const file = await resolveFile(root, pathname);
    if (!file) return notFound(res);

    let st;
    try {
      st = await stat(file);
    } catch {
      return notFound(res);
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string | number> = {
      "Content-Type": mimeFor(file),
      // Sin hash en los nombres: siempre revalidar para no quedar con una versión vieja.
      "Cache-Control": "no-cache",
      ETag: etag,
      "Last-Modified": st.mtime.toUTCString(),
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}
