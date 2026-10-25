// Órdenes al evento abierto y miniaturas compartidas entre pestañas.

import { S } from "./store.js";
import { toast } from "./ui.js";
import { Thumbs } from "./thumbs.js";

/** @type {import("./conn.js").Connection | null} */
let conn = null;

export function setConnection(c) {
  conn = c;
}

export function getConnection() {
  return conn;
}

/**
 * Manda una orden al evento abierto. Si falla, muestra un aviso (salvo quiet).
 * @returns {Promise<{ok:boolean, error?:string, data?:any}>}
 */
export async function cmd(command, { quiet = false } = {}) {
  if (!conn || !S.eventId) return { ok: false, error: "Sin conexión" };
  const r = await conn.command(S.eventId, command);
  if (!r.ok && !quiet) toast(r.error || "La orden falló", "error", 5000);
  return r;
}

export const thumbs = new Thumbs((clipId) => cmd({ action: "getThumbnail", clipId }, { quiet: true }));
