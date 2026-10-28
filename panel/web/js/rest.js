// API REST del modo cuentas: JSON con "Authorization: Bearer", avisos de error y sesión vencida.

import { toast } from "./ui.js";

let token = null;
let onUnauthorized = null;

/** Token de sesión para las llamadas siguientes (null = sin sesión). */
export function setRestToken(t) {
  token = t || null;
}

/** Qué hacer cuando el servidor responde 401 con sesión (volver al ingreso). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class RestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const FALLBACK = {
  400: "Revisa los datos.",
  401: "Tu sesión venció. Ingresa de nuevo.",
  403: "No tienes permiso para esto.",
  404: "No se encontró.",
  409: "Ya existe.",
  410: "Ya venció.",
  429: "Demasiados intentos. Espera unos minutos.",
};

/**
 * Llama a la API. Lanza RestError con el mensaje del servidor ({error}).
 * opts.quiet: no mostrar aviso. opts.auth: false para no mandar el token.
 */
export async function rest(method, path, body, { quiet = false, auth = true } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    const err = new RestError("No se pudo conectar con el servidor. Revisa la red.", 0);
    if (!quiet) toast(err.message, "error", 5000);
    throw err;
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return data;
  const message = (data && typeof data.error === "string" && data.error) || FALLBACK[res.status] || `El servidor respondió con un error (${res.status}).`;
  const err = new RestError(message, res.status);
  if (res.status === 401 && auth && token && onUnauthorized) {
    onUnauthorized(message);
    throw err;
  }
  if (!quiet) toast(message, "error", 5000);
  throw err;
}

export const get = (path, opts) => rest("GET", path, undefined, opts);
export const post = (path, body = {}, opts) => rest("POST", path, body, opts);
export const patch = (path, body = {}, opts) => rest("PATCH", path, body, opts);
export const del = (path, opts) => rest("DELETE", path, undefined, opts);

// ---------------------------------------------------------------- Configuración pública

/** @typedef {{ mode: "accounts"|"codes", brand: string, contactWhatsapp: string, agent: {version:string, downloadUrl:string} | null }} PublicConfig */

/**
 * GET /api/config. Un servidor viejo (sin esta ruta) o sin red se trata como modo códigos.
 * @returns {Promise<PublicConfig>}
 */
export async function loadConfig() {
  const base = { mode: "codes", brand: "", contactWhatsapp: "", agent: null };
  try {
    const res = await fetch("/api/config", { cache: "no-store", headers: { Accept: "application/json" } });
    if (!res.ok) return base;
    const c = await res.json();
    return {
      mode: c?.mode === "accounts" ? "accounts" : "codes",
      brand: typeof c?.brand === "string" ? c.brand.trim() : "",
      contactWhatsapp: typeof c?.contactWhatsapp === "string" ? c.contactWhatsapp.replace(/\D/g, "") : "",
      agent: c?.agent && typeof c.agent === "object" ? { version: String(c.agent.version || ""), downloadUrl: String(c.agent.downloadUrl || "") } : null,
    };
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------- Formato del modo cuentas

/** 200000 → "$200.000" (pesos colombianos, sin decimales). */
export function cop(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Fecha que llega como milisegundos, segundos o texto ISO → ms (o null). */
export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "27 oct 2026". */
export function shortDate(v) {
  const ms = toMs(v);
  if (ms == null) return "—";
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export const ROLE_LABEL = { owner: "Dueño", operator: "Operador", viewer: "Observador" };
export const ROLE_HELP = {
  owner: "Todo: equipo, plan y PCs",
  operator: "Controla eventos y vincula PCs",
  viewer: "Solo mira, no controla",
};

/** Enlace de WhatsApp: con número (soporte) o sin él (compartir con cualquiera). */
export function waLink(number, text) {
  const n = String(number || "").replace(/\D/g, "");
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

/** "ABC123" / "abc-123" → "ABC-123". */
export function prettyCode(code) {
  const c = String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}
