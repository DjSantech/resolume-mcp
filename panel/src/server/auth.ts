// Autenticación: comparación en tiempo constante, tokens de sesión firmados y límite de intentos.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Role } from "../shared/protocol.js";

/** Clave aleatoria del proceso para comparar secretos vía HMAC (mismo largo siempre). */
const COMPARE_KEY = randomBytes(32);

/** Compara dos secretos en tiempo constante, sin filtrar su largo. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHmac("sha256", COMPARE_KEY).update(a, "utf8").digest();
  const db = createHmac("sha256", COMPARE_KEY).update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 40;

export interface Session {
  name: string;
  role: Role;
  /** Vencimiento en ms desde epoch. */
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/** Token = base64url(JSON{name, role, exp}) + "." + HMAC-SHA256(payload, secret) en base64url. */
export function createToken(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Devuelve la sesión si el token es auténtico y no venció; si no, null. */
export function verifyToken(token: string, secret: string, now = Date.now()): Session | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secret), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { name, role, exp, uid } = data as Record<string, unknown>;
  // Un token del modo cuentas nunca sirve en el modo códigos.
  if (uid !== undefined) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (role !== "admin" && role !== "viewer") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now) return null;
  return { name, role, exp };
}

// ---------------------------------------------------------------- Modo cuentas

export const ACCOUNT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AccountRole = "owner" | "operator" | "viewer";

export interface AccountSession {
  uid: string;
  oid: string;
  role: AccountRole;
  /** token_version del usuario al emitir el token. */
  tv: number;
  name: string;
  exp: number;
}

export function createAccountToken(s: AccountSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAccountToken(token: string, secret: string, now = Date.now()): AccountSession | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secret), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { uid, oid, role, tv, name, exp } = data as Record<string, unknown>;
  if (typeof uid !== "string" || typeof oid !== "string" || typeof name !== "string") return null;
  if (role !== "owner" && role !== "operator" && role !== "viewer") return null;
  if (!Number.isSafeInteger(tv)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now) return null;
  return { uid, oid, role, tv: tv as number, name, exp };
}

// Contraseñas: scrypt con sal aleatoria. Formato "scrypt$N$r$p$sal$hash" (base64url).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Hash de relleno: se verifica contra él cuando el correo no existe, para no filtrar nada por el tiempo. */
let dummyHash: Promise<string> | null = null;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const h = stored ?? (await (dummyHash ??= hashPassword(randomBytes(16).toString("hex"))));
  const parts = h.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) || N > 1 << 20) return false;
  const expected = Buffer.from(parts[5]!, "base64url");
  if (expected.length < 16 || expected.length > 128) return false;
  const key = await scryptAsync(password, Buffer.from(parts[4]!, "base64url"), N, r, p, expected.length);
  return timingSafeEqual(key, expected) && stored !== null;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Limpia el nombre visible: sin caracteres de control, espacios colapsados, máx. 40. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** Límite de intentos fallidos por IP en una ventana fija. */
export class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  /** ms hasta poder reintentar, o 0 si la IP puede intentar. */
  blockedFor(ip: string, now = Date.now()): number {
    const a = this.attempts.get(ip);
    if (!a) return 0;
    if (a.resetAt <= now) {
      this.attempts.delete(ip);
      return 0;
    }
    return a.count >= this.maxFailures ? a.resetAt - now : 0;
  }

  fail(ip: string, now = Date.now()): void {
    const a = this.attempts.get(ip);
    if (!a || a.resetAt <= now) this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
    else a.count++;
  }

  prune(now = Date.now()): void {
    for (const [ip, a] of this.attempts) if (a.resetAt <= now) this.attempts.delete(ip);
  }
}
