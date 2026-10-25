// Automatizaciones guardadas en DATA_DIR/automations.json, con escritura atómica (archivo temporal + rename).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Automation, AutomationClip } from "../shared/protocol.js";

const FILE = "automations.json";
const MAX_SECONDS = 24 * 3600;

/** Valida lo que manda la web (o lo leído del disco). Devuelve la automatización limpia o un mensaje de error. */
export function parseAutomation(input: unknown, minSeconds: number): Automation | string {
  if (!input || typeof input !== "object") return "Automatización inválida";
  const a = input as Record<string, unknown>;

  let id = typeof a.id === "string" ? a.id.trim() : "";
  if (!id) id = randomUUID();
  if (!/^[\w-]{1,64}$/.test(id)) return "Id de automatización inválido";

  const name = typeof a.name === "string" ? a.name.trim().slice(0, 80) : "";
  if (!name) return "Falta el nombre";

  const deckName = typeof a.deckName === "string" ? a.deckName.trim().slice(0, 80) : "";

  const layer = Number(a.layer);
  if (!Number.isInteger(layer) || layer < 1 || layer > 999) return "Capa inválida";

  if (a.clips !== undefined && !Array.isArray(a.clips)) return "Lista de clips inválida";
  const clips: AutomationClip[] = [];
  for (const c of (a.clips as unknown[] | undefined) ?? []) {
    const o = (c ?? {}) as Record<string, unknown>;
    const clipId = Number(o.clipId), column = Number(o.column);
    if (!Number.isSafeInteger(clipId) || clipId <= 0) return "Clip inválido en la lista";
    clips.push({
      clipId,
      column: Number.isInteger(column) && column > 0 ? column : 0,
      name: typeof o.name === "string" ? o.name.slice(0, 120) : "",
    });
  }
  if (clips.length > 1000) return "Demasiados clips";

  const min = Number(a.minSeconds), max = Number(a.maxSeconds);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "Mínimo y máximo deben ser números";
  if (min < minSeconds) return `El mínimo debe ser de al menos ${minSeconds} s`;
  if (max < min) return "El máximo debe ser mayor o igual al mínimo";
  if (max > MAX_SECONDS) return "El máximo no puede pasar de 24 h";

  const order = a.order === "shuffle" ? "shuffle" : "sequential";
  const fit = a.fit === undefined ? true : a.fit === true;
  const updatedAt = Number.isFinite(Number(a.updatedAt)) ? Number(a.updatedAt) : Date.now();

  return { id, name, deckName, layer, clips, minSeconds: min, maxSeconds: max, order, fit, updatedAt };
}

export class AutomationStore {
  private items: Automation[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly dir: string, private readonly minSeconds: number, private readonly warn: (text: string) => void) {
    this.path = join(dir, FILE);
  }

  /** Lee el archivo. Si no existe empieza vacío; si está dañado lo aparta y empieza vacío. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      const bad = `${this.path}.danado-${Date.now()}`;
      await rename(this.path, bad).catch(() => undefined);
      this.warn(`automations.json estaba dañado; lo aparté como ${bad} y empiezo sin automatizaciones`);
      return;
    }
    const list = Array.isArray(data) ? data : (data as { automations?: unknown })?.automations;
    for (const raw of Array.isArray(list) ? list : []) {
      const a = parseAutomation(raw, this.minSeconds);
      if (typeof a === "string") this.warn(`Ignoré una automatización guardada inválida: ${a}`);
      else if (!this.items.some((x) => x.id === a.id)) this.items.push(a);
    }
  }

  list(): Automation[] {
    return this.items.map((a) => ({ ...a, clips: a.clips.map((c) => ({ ...c })) }));
  }

  get(id: string): Automation | undefined {
    return this.items.find((a) => a.id === id);
  }

  async save(a: Automation): Promise<void> {
    const i = this.items.findIndex((x) => x.id === a.id);
    if (i >= 0) this.items[i] = a;
    else this.items.push(a);
    await this.persist();
  }

  async remove(id: string): Promise<Automation | undefined> {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [removed] = this.items.splice(i, 1);
    await this.persist();
    return removed;
  }

  /** Espera a que terminen las escrituras pendientes. */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  // Las escrituras se encadenan para que nunca se pisen.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, automations: this.items }, null, 2);
    const run = this.writing.catch(() => undefined).then(() => this.writeAtomic(snapshot));
    this.writing = run;
    return run;
  }

  private async writeAtomic(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, text, "utf8");
    // En Windows el rename puede fallar un momento si un antivirus/OneDrive tiene el archivo abierto.
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, this.path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
          await unlink(tmp).catch(() => undefined);
          throw new Error(`No pude guardar automations.json (${code ?? (e as Error).message})`);
        }
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }
}
