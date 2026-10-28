// Registro del agente en agente.log (rota a ~1 MB). Nunca escribe secretos: se tachan los registrados.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  (line: string): void;
  addSecret(secret: string): void;
}

export function createLogger(file: string, opts: { echo?: boolean; maxBytes?: number } = {}): Logger {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const secrets = new Set<string>();
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* se reintenta al escribir */ }
  const log = ((line: string) => {
    let text = String(line);
    for (const s of secrets) text = text.split(s).join("***");
    const out = `${new Date().toISOString()} ${text}\n`;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) renameSync(file, `${file}.1`);
    } catch { /* sin rotar */ }
    try { appendFileSync(file, out); } catch { /* sin disco: no tumbar el agente */ }
    if (opts.echo) process.stdout.write(out);
  }) as Logger;
  log.addSecret = (s) => { if (s && s.length >= 6) secrets.add(s); };
  return log;
}
