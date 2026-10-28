// Servidor HTTP + WebSocket: sirve la web, autentica y releva mensajes entre la web y los puentes.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { existsSync } from "node:fs";
import path from "node:path";
import { createAccounts, type Accounts } from "./accounts.js";
import { LoginLimiter, TOKEN_TTL_MS, cleanName, createToken, safeEqual, verifyToken, type Session } from "./auth.js";
import { clientIp, readBody, sendJson } from "./http.js";
import { CLOSE_BAD_SESSION, Hub, type ClientSession, type LogFn } from "./hub.js";
import { PLANS } from "./plans.js";
import { createStaticHandler } from "./static.js";
import { MemoryStore } from "./store/memory.js";
import { PgStore } from "./store/pg.js";
import type { Store } from "./store/store.js";
import { isEventId } from "./validate.js";

export interface ServerConfig {
  /** Puerto HTTP. 0 = uno libre al azar. */
  port: number;
  /** Interfaz donde escuchar. Por defecto todas. */
  host?: string;
  /** Modo códigos: obligatorio. */
  adminCode?: string;
  /** Vacío = no hay observadores. */
  viewerCode?: string;
  /** Modo códigos: obligatorio. */
  bridgeToken?: string;
  /** Modo cuentas con Postgres. */
  databaseUrl?: string;
  /** "memory" = modo cuentas sin base de datos (pruebas/desarrollo). */
  accountsStore?: "memory";
  /** Store ya creado (pruebas). Activa el modo cuentas. */
  store?: Store;
  brandName?: string;
  contactWhatsapp?: string;
  superadminEmails?: string[];
  agentVersion?: string;
  agentDownloadUrl?: string;
  agentSha256?: string;
  /** URL pública para enlaces de invitación. Vacío = derivada de la petición. */
  publicUrl?: string;
  /** Vacío = aleatorio al arrancar (las sesiones no sobreviven reinicios). */
  sessionSecret?: string;
  /** Carpeta de la web. Por defecto `<paquete>/web`. */
  staticDir?: string;
  /** Cuántos proxies confiables hay delante (para leer la IP real de X-Forwarded-For). 0 = ninguno. */
  trustProxy?: number;
  /** Espera máxima de respuesta del puente a una orden. */
  commandTimeoutMs?: number;
  /** Intervalo de ping/pong de WebSocket. */
  pingIntervalMs?: number;
  /** Mínimo entre dos envíos de `events`. */
  eventsThrottleMs?: number;
  /** Tiempo tras el que se borra un evento desconectado. */
  offlineTtlMs?: number;
  /** Registro de actividad. Por defecto la consola. */
  log?: LogFn;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const BRIDGE_MAX_PAYLOAD = 4 * 1024 * 1024; // capturas en base64
const CLIENT_MAX_PAYLOAD = 64 * 1024;
const LOGIN_MAX_BODY = 4 * 1024;

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../web", import.meta.url));

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const defaultLog: LogFn = (level, text) => {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  if (level === "info") console.log(line);
  else console.error(line);
};

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const accountsMode = !!(config.store || config.databaseUrl || config.accountsStore === "memory");
  if (!accountsMode) {
    if (!config.adminCode) throw new Error("Falta ADMIN_CODE: el código de administrador es obligatorio.");
    if (!config.bridgeToken) throw new Error("Falta BRIDGE_TOKEN: el secreto de los puentes es obligatorio.");
  }

  const adminCode = config.adminCode ?? "";
  const viewerCode = config.viewerCode ?? "";
  const bridgeToken = config.bridgeToken ?? "";
  const sessionSecret = config.sessionSecret || randomBytes(32).toString("hex");
  const trustProxy = Math.max(0, Math.floor(config.trustProxy ?? 0));
  const log = config.log ?? defaultLog;
  const brand = config.brandName?.trim() || "VisualMaping";
  const staticDir = config.staticDir || DEFAULT_STATIC_DIR;

  let accounts: Accounts | null = null;
  const hub = new Hub({
    commandTimeoutMs: config.commandTimeoutMs ?? 15_000,
    eventsThrottleMs: config.eventsThrottleMs ?? 1_000,
    offlineTtlMs: config.offlineTtlMs ?? 24 * 60 * 60 * 1000,
    log,
    onHello: (id, v) => accounts?.onHello(id, v),
    onBridgeClose: (id) => accounts?.onBridgeClose(id),
  });

  let store: Store | null = null;
  if (accountsMode) {
    store = config.store ?? (config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore());
    try {
      await store.init();
    } catch (err) {
      await store.close().catch(() => {});
      throw new Error(`No se pudo preparar la base de datos: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (config.databaseUrl && !config.store) log("info", "Base de datos lista");
    accounts = createAccounts({
      store,
      hub,
      sessionSecret,
      trustProxy,
      superadminEmails: config.superadminEmails ?? [],
      publicUrl: config.publicUrl?.trim() || undefined,
      log,
    });
  }

  const publicConfig = () => ({
    mode: accountsMode ? "accounts" : "codes",
    brand,
    contactWhatsapp: (config.contactWhatsapp ?? "").replace(/\D/g, ""),
    agent: config.agentVersion ? { version: config.agentVersion, downloadUrl: config.agentDownloadUrl ?? "" } : null,
  });
  const agentVersionInfo = () => ({
    version: config.agentVersion ?? "",
    downloadUrl: config.agentDownloadUrl ?? "",
    sha256: config.agentSha256 ?? "",
  });
  const loginLimiter = new LoginLimiter(10, 10 * 60 * 1000);
  const bridgeLimiter = new LoginLimiter(20, 10 * 60 * 1000);
  const serveStatic = createStaticHandler(staticDir);

  /** Sesión válida, y si es observador, solo mientras haya código de observador configurado. */
  const checkSession = (token: string | null): Session | null => {
    const s = token ? verifyToken(token, sessionSecret) : null;
    if (!s) return null;
    if (s.role === "viewer" && !viewerCode) return null;
    return s;
  };

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Método no permitido" }, { Allow: "POST" });
    const ip = clientIp(req, trustProxy);
    const wait = loginLimiter.blockedFor(ip);
    if (wait > 0) {
      return sendJson(
        res,
        429,
        { error: "Demasiados intentos fallidos. Prueba de nuevo en unos minutos." },
        { "Retry-After": String(Math.ceil(wait / 1000)) },
      );
    }
    const text = await readBody(req, LOGIN_MAX_BODY);
    if (text === null) return sendJson(res, 413, { error: "Solicitud demasiado grande" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return sendJson(res, 400, { error: "JSON inválido" });
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, { error: "JSON inválido" });
    const { name: rawName, code } = body as Record<string, unknown>;
    const name = cleanName(rawName);
    if (!name) return sendJson(res, 400, { error: "Escribe tu nombre" });

    const given = typeof code === "string" && code.length <= 256 ? code : "";
    // Se comparan ambos siempre para no revelar nada por el tiempo de respuesta.
    const isAdmin = given !== "" && safeEqual(given, adminCode);
    const isViewer = given !== "" && viewerCode !== "" && safeEqual(given, viewerCode);
    const role = isAdmin ? "admin" : isViewer ? "viewer" : null;
    if (!role) {
      loginLimiter.fail(ip);
      return sendJson(res, 401, { error: "Código incorrecto" });
    }
    const token = createToken({ name, role, exp: Date.now() + TOKEN_TTL_MS }, sessionSecret);
    log("info", `Ingreso como ${role === "admin" ? "administrador" : "observador"}: ${name}`);
    sendJson(res, 200, { token, role, name });
  }

  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Solicitud inválida");
      return;
    }
    const pathname = url.pathname;
    const done = (p: Promise<void>) =>
      p.catch((err: unknown) => {
        log("error", `Error atendiendo ${req.method} ${pathname}: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "Error interno" });
        else res.destroy();
      });

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "ok");
      return;
    }
    const getOnly = (body: () => unknown) => {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Método no permitido" }, { Allow: "GET" });
      sendJson(res, 200, body());
    };
    if (pathname === "/api/config") return getOnly(publicConfig);
    if (pathname === "/api/plans") return getOnly(() => PLANS);
    if (pathname === "/api/agent/version") return getOnly(agentVersionInfo);
    if (accounts) {
      const acc = accounts;
      if (pathname.startsWith("/api/")) {
        return void done(
          acc.handle(req, res, pathname).then((handled) => {
            if (!handled) sendJson(res, 404, { error: "No encontrado" });
          }),
        );
      }
    } else if (pathname === "/api/login") return void done(handleLogin(req, res));
    if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
      return sendJson(res, 404, { error: "No encontrado" });
    }
    // La app vive en /app (y /app/...); en modo cuentas "/" es la portada si existe.
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      return void done(serveStatic(req, res, pathname === "/app" ? "/app/" : pathname, ["/index.html"]));
    }
    if (pathname === "/" && accountsMode && existsSync(path.join(staticDir, "landing.html"))) {
      return void done(serveStatic(req, res, "/landing.html", ["/index.html"]));
    }
    void done(serveStatic(req, res, pathname));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_PAYLOAD, perMessageDeflate: false });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_PAYLOAD, perMessageDeflate: false });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }

    const acceptClient = (session: ClientSession | null) =>
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        // Se acepta y se cierra con código propio para que la web sepa que debe volver al ingreso.
        if (!session) ws.close(CLOSE_BAD_SESSION, "Sesión inválida o vencida");
        else hub.addClient(ws, session);
      });

    if (url.pathname === "/ws/bridge" && accounts) {
      const acc = accounts;
      const ip = clientIp(req, trustProxy);
      if (bridgeLimiter.blockedFor(ip) > 0) return rejectUpgrade(socket, 429, "Too Many Requests");
      const q = url.searchParams;
      acc.bridgeAgent(q.get("agent") ?? "", q.get("secret") ?? "", q.get("version") ?? "").then(
        (agent) => {
          if (!agent) {
            bridgeLimiter.fail(ip);
            log("warn", `Agente rechazado: credenciales inválidas o PC desvinculado (${ip})`);
            return rejectUpgrade(socket, 401, "Unauthorized");
          }
          bridgeWss.handleUpgrade(req, socket, head, (ws) => hub.addBridge(ws, agent.id, agent.name, { orgId: agent.orgId }));
        },
        (err: unknown) => {
          log("error", `Error autenticando agente: ${err instanceof Error ? err.message : String(err)}`);
          rejectUpgrade(socket, 503, "Service Unavailable");
        },
      );
      return;
    }

    if (url.pathname === "/ws/client" && accounts) {
      accounts.clientSession(url.searchParams.get("token")).then(acceptClient, (err: unknown) => {
        log("error", `Error validando sesión: ${err instanceof Error ? err.message : String(err)}`);
        rejectUpgrade(socket, 503, "Service Unavailable");
      });
      return;
    }

    if (url.pathname === "/ws/bridge") {
      const ip = clientIp(req, trustProxy);
      if (bridgeLimiter.blockedFor(ip) > 0) return rejectUpgrade(socket, 429, "Too Many Requests");
      const token = url.searchParams.get("token") ?? "";
      if (!token || !safeEqual(token, bridgeToken)) {
        bridgeLimiter.fail(ip);
        log("warn", `Puente rechazado: token incorrecto (${ip})`);
        return rejectUpgrade(socket, 401, "Unauthorized");
      }
      const eventId = url.searchParams.get("event") ?? "";
      if (!isEventId(eventId)) return rejectUpgrade(socket, 400, "Bad Request");
      const name = url.searchParams.get("name") ?? "";
      bridgeWss.handleUpgrade(req, socket, head, (ws) => hub.addBridge(ws, eventId, name));
      return;
    }

    if (url.pathname === "/ws/client") {
      acceptClient(checkSession(url.searchParams.get("token")));
      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  });

  const pingTimer = setInterval(() => hub.heartbeat(), config.pingIntervalMs ?? 25_000);
  const pruneTimer = setInterval(
    () => {
      hub.prune();
      loginLimiter.prune();
      bridgeLimiter.prune();
      accounts?.prune();
    },
    10 * 60 * 1000,
  );
  pingTimer.unref();
  pruneTimer.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (err) => log("error", `Error del servidor: ${err.message}`));
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    port,
    close() {
      closing ??= (async () => {
        clearInterval(pingTimer);
        clearInterval(pruneTimer);
        hub.close();
        bridgeWss.close();
        clientWss.close();
        if (store && !config.store) await store.close().catch(() => {});
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
