#!/usr/bin/env node
// Puente del panel: lee la configuración del entorno y arranca. Ctrl+C lo detiene (el clip actual sigue sonando).
// Variables: RESOLUME_URL, SERVER_URL, BRIDGE_TOKEN, EVENT_ID, EVENT_NAME, DATA_DIR, POLL_MS, SNAPSHOT_MS

import { startBridge } from "./bridge.js";

const env = (name: string) => (process.env[name] ?? "").trim();
const ms = (name: string, fallback: number) => {
  const n = Number(env(name));
  return env(name) && Number.isFinite(n) && n > 0 ? n : fallback;
};

const serverUrl = env("SERVER_URL");
const bridgeToken = env("BRIDGE_TOKEN");
const missing = [!serverUrl && "SERVER_URL", !bridgeToken && "BRIDGE_TOKEN"].filter(Boolean);
if (missing.length) {
  console.error(`Falta ${missing.join(" y ")}. Ejemplo:\n  SERVER_URL=wss://mi-panel.onrender.com BRIDGE_TOKEN=... npm run bridge`);
  process.exit(1);
}

try {
  const bridge = await startBridge({
    resolumeUrl: env("RESOLUME_URL") || "http://127.0.0.1:8080",
    serverUrl,
    bridgeToken,
    eventId: env("EVENT_ID") || undefined,
    eventName: env("EVENT_NAME") || undefined,
    dataDir: env("DATA_DIR") || "./data",
    pollMs: ms("POLL_MS", 1000),
    snapshotMs: ms("SNAPSHOT_MS", 3000),
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\nPuente detenido. El clip actual sigue sonando.");
    bridge.stop().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (e) {
  console.error(`No pude arrancar el puente: ${(e as Error).message}`);
  process.exit(1);
}
