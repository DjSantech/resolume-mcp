// Arranque del servidor desde variables de entorno.
import { startServer } from "./server.js";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const env = process.env;
const adminCode = env.ADMIN_CODE?.trim() ?? "";
const bridgeToken = env.BRIDGE_TOKEN?.trim() ?? "";
const missing = [!adminCode && "ADMIN_CODE", !bridgeToken && "BRIDGE_TOKEN"].filter(Boolean);
if (missing.length > 0) {
  fail(
    `faltan variables de entorno obligatorias: ${missing.join(", ")}.\n` +
      "  ADMIN_CODE   = código de acceso con control total\n" +
      "  BRIDGE_TOKEN = secreto compartido con los puentes (largo y aleatorio)",
  );
}

const port = Number(env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`PORT inválido: "${env.PORT}"`);

// En Render hay un proxy delante: la IP real del cliente viene en X-Forwarded-For.
const trustProxy = env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : env.RENDER ? 1 : 0;
if (!Number.isInteger(trustProxy) || trustProxy < 0) fail(`TRUST_PROXY inválido: "${env.TRUST_PROXY}"`);

const viewerCode = env.VIEWER_CODE?.trim() ?? "";
if (bridgeToken.length < 16) console.warn("Aviso: BRIDGE_TOKEN es corto; usa al menos 16 caracteres aleatorios.");
if (viewerCode && viewerCode === adminCode) fail("VIEWER_CODE no puede ser igual a ADMIN_CODE.");
if (!env.SESSION_SECRET) console.warn("Aviso: SESSION_SECRET vacío; las sesiones se pierden al reiniciar.");

try {
  const server = await startServer({
    port,
    host: env.HOST || undefined,
    adminCode,
    viewerCode,
    bridgeToken,
    sessionSecret: env.SESSION_SECRET,
    staticDir: env.STATIC_DIR || undefined,
    trustProxy,
  });
  console.log(`Panel escuchando en el puerto ${server.port}${viewerCode ? " (con observadores)" : ""}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} recibido, cerrando…`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") fail(`el puerto ${port} ya está en uso.`);
  fail(`no se pudo arrancar el servidor: ${err instanceof Error ? err.message : String(err)}`);
}
