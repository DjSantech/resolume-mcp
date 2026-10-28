// Entrada del agente (.exe). Página local en 127.0.0.1:7377, que también es el candado de instancia única.
// Argumentos: --background (no abrir el navegador si ya está vinculado), --after-update (esperar el puerto).
// Sin await de primer nivel: el bundle del .exe es CommonJS.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { UI_PORT } from "./brand.js";
import { Agent } from "./agent.js";
import { createLocalServer, listenLocal, newToken } from "./local-server.js";
import { createLogger } from "./log.js";
import { agentDir, isPackaged, logFile } from "./paths.js";

const URL_LOCAL = `http://127.0.0.1:${UI_PORT}`;

function openBrowser(url: string): void {
  if (process.env.VM_NO_BROWSER === "1") return; // pruebas
  try {
    const p = process.platform === "win32"
      ? spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    p.on("error", () => undefined);
    p.unref();
  } catch { /* sin navegador */ }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const background = args.includes("--background");
  const afterUpdate = args.includes("--after-update");
  const packaged = isPackaged();
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  const log = createLogger(logFile(dir), { echo: !packaged });

  process.on("uncaughtException", (e) => log(`Error inesperado: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) => log(`Promesa rechazada: ${(e as Error)?.stack ?? e}`));

  const agent = new Agent({
    dir, log, packaged,
    exePath: process.execPath,
    resolumeUrl: (process.env.VM_RESOLUME_URL ?? "").trim() || undefined,
    beforeRestart: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  });
  const server = createLocalServer(agent, newToken());
  try {
    await listenLocal(server, UI_PORT, afterUpdate ? 30_000 : 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      log("Ya hay un agente corriendo: abro su página");
      if (!background) openBrowser(URL_LOCAL);
      process.exit(0);
    }
    throw e;
  }
  log(`Página local en ${URL_LOCAL}`);
  await agent.start();
  if (!background || !agent.paired) openBrowser(URL_LOCAL);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    log("Agente detenido");
    void agent.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  try { createLogger(logFile(agentDir()))(`No pude arrancar: ${(e as Error)?.stack ?? e}`); } catch { /* nada */ }
  process.exit(1);
});
