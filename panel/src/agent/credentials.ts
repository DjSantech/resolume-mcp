// Código de vinculación, credenciales del agente (agente.json) y llamada a POST /api/agent/pair.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Credentials {
  serverUrl: string;
  agentId: string;
  agentSecret: string;
  orgName: string;
  pcName: string;
}

const CODE_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** "abc-123", " ABC 123 " → "ABC123". null si no es un código válido. */
export function normalizePairingCode(input: string): string | null {
  const code = String(input ?? "").toUpperCase().replace(/[\s\-_.]+/g, "");
  return CODE_ALPHABET.test(code) ? code : null;
}

/** "mi-panel.com/app" → "https://mi-panel.com". null si no es http(s). */
export function normalizeServerUrl(input: string): string | null {
  let s = String(input ?? "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function cleanPcName(input: string, fallback: string): string {
  const clean = (v: string) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60);
  return clean(input) || clean(fallback) || "PC";
}

function isCredentials(v: unknown): v is Credentials {
  const c = v as Credentials;
  return !!c && typeof c === "object" && typeof c.serverUrl === "string" && !!normalizeServerUrl(c.serverUrl)
    && typeof c.agentId === "string" && !!c.agentId && typeof c.agentSecret === "string" && !!c.agentSecret
    && typeof c.orgName === "string" && typeof c.pcName === "string";
}

export async function loadCredentials(file: string): Promise<Credentials | null> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isCredentials(data) ? data : null;
  } catch {
    return null;
  }
}

/** Escritura atómica: archivo temporal + rename. */
export async function saveCredentials(file: string, c: Credentials): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const data: Credentials = { serverUrl: c.serverUrl, agentId: c.agentId, agentSecret: c.agentSecret, orgName: c.orgName, pcName: c.pcName };
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export async function deleteCredentials(file: string): Promise<void> {
  await unlink(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

export class PairError extends Error {}

/** Llama a POST <server>/api/agent/pair. Los errores llevan mensaje en español para mostrar. */
export async function pairWithServer(serverUrl: string, code: string, pcName: string, agentVersion: string, timeoutMs = 90_000): Promise<Credentials> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/agent/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, pcName, agentVersion }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new PairError(`No pude conectar con el servidor (${serverUrl}). Revisa internet o la dirección en "Avanzado".`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = typeof body?.error === "string" && body.error ? body.error : `El servidor respondió ${res.status}`;
    throw new PairError(msg);
  }
  const c = { serverUrl, agentId: body?.agentId, agentSecret: body?.agentSecret, orgName: body?.orgName ?? "", pcName: body?.pcName ?? pcName };
  if (!isCredentials(c)) throw new PairError("Respuesta inválida del servidor");
  return c;
}
