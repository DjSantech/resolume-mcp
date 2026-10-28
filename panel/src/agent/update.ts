// Auto-actualización: comparar versiones, decidir, descargar con SHA-256 y reemplazar el .exe.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface UpdateInfo { version: string; downloadUrl: string; sha256: string }

function parse(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? "" };
}

/** -1 si a < b, 0 si iguales, 1 si a > b. Una versión inválida vale menos que cualquiera válida. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 1.0.0 > 1.0.0-beta
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true }) < 0 ? -1 : 1;
}

export type UpdateDecision =
  | { action: "none"; reason: string }
  | { action: "wait"; reason: string; info: UpdateInfo }
  | { action: "install"; info: UpdateInfo };

export function decideUpdate(o: { current: string; info: Partial<UpdateInfo> | null; packaged: boolean; automationRunning: boolean }): UpdateDecision {
  const v = o.info?.version ?? "";
  if (!v) return { action: "none", reason: "No hay versión publicada" };
  if (compareVersions(v, o.current) <= 0) return { action: "none", reason: "Al día" };
  const sha = String(o.info?.sha256 ?? "").toLowerCase();
  if (!o.info?.downloadUrl || !/^[0-9a-f]{64}$/.test(sha)) return { action: "none", reason: `Versión ${v} publicada sin descarga válida` };
  if (!o.packaged) return { action: "none", reason: `Hay versión ${v} (en desarrollo no se actualiza)` };
  const info = { version: v, downloadUrl: o.info.downloadUrl, sha256: sha };
  if (o.automationRunning) return { action: "wait", reason: `Versión ${v} lista: se instala cuando termine la automatización`, info };
  return { action: "install", info };
}

/** https, o http solo hacia este mismo PC (pruebas). Resuelve rutas relativas contra el servidor. */
export function resolveDownloadUrl(serverUrl: string, url: string): string | null {
  try {
    const u = new URL(url, serverUrl);
    if (u.protocol === "https:") return u.href;
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.href;
    return null;
  } catch {
    return null;
  }
}

export async function fetchUpdateInfo(serverUrl: string): Promise<Partial<UpdateInfo>> {
  const res = await fetch(`${serverUrl}/api/agent/version`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
  const b = (await res.json()) as Record<string, unknown> | null;
  const s = (k: string) => (typeof b?.[k] === "string" ? (b[k] as string) : "");
  return { version: s("version"), downloadUrl: s("downloadUrl"), sha256: s("sha256") };
}

/** Descarga a `dir`, verifica el SHA-256 y devuelve la ruta del .exe nuevo. */
export async function downloadUpdate(url: string, sha256: string, dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const final = join(dir, `agente-${version.replace(/[^0-9A-Za-z.-]/g, "")}.exe`);
  const part = `${final}.part`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`la descarga falló (${res.status})`);
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let size = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > 400 * 1024 * 1024) throw new Error("descarga demasiado grande");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((ok, ko) => out.end((e?: Error | null) => (e ? ko(e) : ok())));
  } catch (e) {
    out.destroy();
    await unlink(part).catch(() => undefined);
    throw e;
  }
  if (hash.digest("hex") !== sha256.toLowerCase()) {
    await unlink(part).catch(() => undefined);
    throw new Error("el SHA-256 de la descarga no coincide; se descartó");
  }
  await unlink(final).catch(() => undefined);
  await rename(part, final);
  return final;
}

/** Cambia el .exe en uso por el nuevo (el viejo queda como .old). Devuelve cómo deshacerlo. */
export async function swapExecutable(newExe: string, exe: string): Promise<() => Promise<void>> {
  const old = `${exe}.old`;
  await unlink(old).catch(() => undefined);
  await rename(exe, old); // Windows permite renombrar un .exe en ejecución
  try {
    await rename(newExe, exe).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== "EXDEV") throw e;
      await copyFile(newExe, exe);
      await unlink(newExe).catch(() => undefined);
    });
  } catch (e) {
    await rename(old, exe).catch(() => undefined);
    throw e;
  }
  return async () => {
    await unlink(exe).catch(() => undefined);
    await rename(old, exe);
  };
}

/** Borra el .old de una actualización anterior (reintenta: el proceso viejo puede estar saliendo). */
export async function cleanupOld(exe: string, tries = 15): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await unlink(`${exe}.old`);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
