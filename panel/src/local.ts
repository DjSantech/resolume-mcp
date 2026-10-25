#!/usr/bin/env node
// Modo local: servidor + puente en un solo proceso, para usar el panel por el Wi-Fi/hotspot del evento sin internet.
// Variables: ADMIN_CODE (obligatorio), VIEWER_CODE, RESOLUME_URL, PORT, EVENT_ID, EVENT_NAME, DATA_DIR, SESSION_SECRET,
// RESOLUME_TIMEOUT_MS, RESOLUME_DOCS

import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { startBridge } from "./bridge/bridge.js";
import { startServer } from "./server/server.js";

const env = (name: string) => (process.env[name] ?? "").trim();

const adminCode = env("ADMIN_CODE");
if (!adminCode) {
  console.error("Falta ADMIN_CODE (el código para entrar al panel). Ejemplo:\n  ADMIN_CODE=1234 npm run local");
  process.exit(1);
}
const port = Number(env("PORT")) || 3000;
// El puente y el servidor están en el mismo proceso: el secreto entre ellos no sale de aquí.
const bridgeToken = randomBytes(24).toString("hex");

try {
  const server = await startServer({
    port,
    adminCode,
    viewerCode: env("VIEWER_CODE"),
    bridgeToken,
    sessionSecret: env("SESSION_SECRET") || undefined,
  });
  const bridge = await startBridge({
    resolumeUrl: env("RESOLUME_URL") || "http://127.0.0.1:8080",
    serverUrl: `ws://127.0.0.1:${server.port}`,
    bridgeToken,
    eventId: env("EVENT_ID") || undefined,
    eventName: env("EVENT_NAME") || undefined,
    dataDir: env("DATA_DIR") || "./data",
    resolumeTimeoutMs: Number(env("RESOLUME_TIMEOUT_MS")) || undefined,
    resolumeDocs: env("RESOLUME_DOCS") || undefined,
  });

  // Direcciones para abrir desde el celular conectado a la misma red.
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i!.address);
  console.log(`\nPanel listo. Ábrelo en el celular (misma red):`);
  for (const ip of ips) console.log(`  http://${ip}:${server.port}`);
  console.log(`  (en este PC: http://localhost:${server.port})\nCtrl+C para detener. Las automatizaciones se detienen con el panel; el clip actual sigue sonando.\n`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\nPanel detenido. El clip actual sigue sonando.");
    Promise.allSettled([bridge.stop(), server.close()]).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (e) {
  console.error(`No pude arrancar el panel: ${(e as Error).message}`);
  process.exit(1);
}
