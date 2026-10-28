// Arranque del servidor desde variables de entorno.
// Modo cuentas si hay DATABASE_URL o ACCOUNTS_STORE=memory; si no, modo códigos (ADMIN_CODE + BRIDGE_TOKEN).
import { startServer } from "./server.js";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const env = process.env;
const val = (name: string) => env[name]?.trim() ?? "";

const databaseUrl = val("DATABASE_URL");
const accountsStore = val("ACCOUNTS_STORE");
if (accountsStore && accountsStore !== "memory") fail(`ACCOUNTS_STORE inválido: "${accountsStore}" (solo "memory").`);
const accountsMode = !!databaseUrl || accountsStore === "memory";

const adminCode = val("ADMIN_CODE");
const bridgeToken = val("BRIDGE_TOKEN");
const viewerCode = val("VIEWER_CODE");
if (!accountsMode) {
  const missing = [!adminCode && "ADMIN_CODE", !bridgeToken && "BRIDGE_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    fail(
      `faltan variables de entorno obligatorias: ${missing.join(", ")}.\n` +
        "  ADMIN_CODE   = código de acceso con control total\n" +
        "  BRIDGE_TOKEN = secreto compartido con los puentes (largo y aleatorio)\n" +
        "  (o DATABASE_URL para el modo cuentas)",
    );
  }
  if (bridgeToken.length < 16) console.warn("Aviso: BRIDGE_TOKEN es corto; usa al menos 16 caracteres aleatorios.");
  if (viewerCode && viewerCode === adminCode) fail("VIEWER_CODE no puede ser igual a ADMIN_CODE.");
}

const port = Number(env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`PORT inválido: "${env.PORT}"`);

// En Render hay un proxy delante: la IP real del cliente viene en X-Forwarded-For.
const trustProxy = env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : env.RENDER ? 1 : 0;
if (!Number.isInteger(trustProxy) || trustProxy < 0) fail(`TRUST_PROXY inválido: "${env.TRUST_PROXY}"`);

if (!env.SESSION_SECRET) console.warn("Aviso: SESSION_SECRET vacío; las sesiones se pierden al reiniciar.");
if (accountsStore === "memory" && !databaseUrl) console.warn("Aviso: ACCOUNTS_STORE=memory; las cuentas se pierden al reiniciar.");

try {
  const server = await startServer({
    port,
    host: env.HOST || undefined,
    adminCode: adminCode || undefined,
    viewerCode,
    bridgeToken: bridgeToken || undefined,
    sessionSecret: env.SESSION_SECRET,
    staticDir: env.STATIC_DIR || undefined,
    trustProxy,
    databaseUrl: databaseUrl || undefined,
    accountsStore: accountsStore === "memory" ? "memory" : undefined,
    brandName: val("BRAND_NAME") || undefined,
    contactWhatsapp: val("CONTACT_WHATSAPP"),
    superadminEmails: val("SUPERADMIN_EMAILS").split(",").map((s) => s.trim()).filter(Boolean),
    agentVersion: val("AGENT_VERSION") || undefined,
    agentDownloadUrl: val("AGENT_DOWNLOAD_URL") || undefined,
    agentSha256: val("AGENT_SHA256") || undefined,
    publicUrl: val("PUBLIC_URL") || undefined,
  });
  const mode = accountsMode ? "modo cuentas" : viewerCode ? "modo códigos, con observadores" : "modo códigos";
  console.log(`Panel escuchando en el puerto ${server.port} (${mode})`);

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
