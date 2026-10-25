// Autenticación: comparación en tiempo constante, tokens de sesión firmados y límite de intentos.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  const { name, role, exp } = data as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (role !== "admin" && role !== "viewer") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now) return null;
  return { name, role, exp };
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
