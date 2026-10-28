// Carpetas del agente: %APPDATA%\VisualMaping (o ~/.visualmaping fuera de Windows).

import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND_NAME } from "./brand.js";

export function agentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const appData = (env.APPDATA ?? "").trim();
  return appData ? join(appData, BRAND_NAME) : join(home, `.${BRAND_NAME.toLowerCase()}`);
}

export const credentialsFile = (dir: string) => join(dir, "agente.json");
export const logFile = (dir: string) => join(dir, "agente.log");
export const bridgeDataDir = (dir: string) => join(dir, "data");
export const updateDir = (dir: string) => join(dir, "update");

/** true si corre como .exe empaquetado (Node SEA). */
export function isPackaged(): boolean {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sea = get?.("node:sea") as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true;
  } catch {
    return false;
  }
}
