// Arranque con Windows: valor en HKCU\...\Run (con reg.exe, sin ventana).

import { execFile } from "node:child_process";
import { BRAND_NAME } from "./brand.js";

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** Nombre del valor. VM_AUTOSTART_NAME solo para pruebas (para no tocar el real). */
export function autostartName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VM_AUTOSTART_NAME ?? "").trim() || BRAND_NAME;
}

/** El .exe se construye sin consola (subsistema GUI): basta lanzarlo con --background. */
export function autostartCommand(exe: string): string {
  return `"${exe}" --background`;
}

function reg(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

/** Comando registrado, o null si no hay. */
export async function readAutostart(name = autostartName()): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const r = await reg(["query", RUN_KEY, "/v", name]);
  if (r.code !== 0) return null;
  const m = /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(r.stdout);
  return m ? m[1].trim() : null;
}

export async function enableAutostart(exe: string, name = autostartName()): Promise<void> {
  if (process.platform !== "win32") throw new Error("Solo en Windows");
  const r = await reg(["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", autostartCommand(exe), "/f"]);
  if (r.code !== 0) throw new Error("No pude registrar el inicio con Windows");
}

export async function disableAutostart(name = autostartName()): Promise<void> {
  if (process.platform !== "win32") return;
  if ((await readAutostart(name)) === null) return;
  const r = await reg(["delete", RUN_KEY, "/v", name, "/f"]);
  if (r.code !== 0) throw new Error("No pude quitar el inicio con Windows");
}
