// Corre una automatización: recorre clips de una capa, cada uno entre minSeconds y maxSeconds, y vuelve a empezar.
// Una a la vez por puente. Los clips se lanzan por id: si alguien cambia de pestaña a mano, se siguen lanzando los suyos.

import type { Automation, LogEntry, RunnerState } from "../shared/protocol.js";
import { fitClip } from "./fit.js";
import {
  clipLengthS, clipName, clipStateOf, isFileClip, selectDeckAndWait,
  type RClip, type RComposition, type ResolumeApi,
} from "./resolume.js";

/** Repeticiones enteras si caben en el rango; si no, un corte al azar dentro del rango. */
export function planDuration(lengthS: number, min: number, max: number): { seconds: number; how: string } {
  if (lengthS > 0) {
    const minLoops = Math.ceil(min / lengthS), maxLoops = Math.floor(max / lengthS);
    if (minLoops <= maxLoops) {
      const loops = minLoops + Math.floor(Math.random() * (maxLoops - minLoops + 1));
      return { seconds: loops * lengthS, how: loops === 1 ? "1 pasada completa" : `${loops} repeticiones` };
    }
  }
  return { seconds: min + Math.random() * (max - min), how: lengthS > max ? "clip largo, se corta" : "se corta dentro del rango" };
}

/** m:ss (o h:mm:ss); con décimas si es menos de 10 s. */
export function fmtDuration(s: number): string {
  if (s < 10) return `${s.toFixed(1)} s`;
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

interface Item {
  clipId: number;
  column: number;
  name: string;
}

export interface RunnerDeps {
  api: ResolumeApi;
  log(level: LogEntry["level"], by: string, text: string): void;
  /** Avisar que cambió `state` (para mandar el estado al servidor). */
  changed(): void;
  /** Automatización vigente por id (las ediciones se aplican al siguiente clip). */
  getAutomation(id: string): Automation | undefined;
  /** Proporción ancho/alto de la composición. */
  compRatio(): Promise<number>;
  /** Espera tras abrir una pestaña (Resolume tarda en cargarla). */
  deckSettleMs: number;
  /** Espera antes de reintentar cuando Resolume falla o la capa está vacía. */
  retryMs: number;
}

interface Run {
  automationId: string;
  stopped: boolean;
  wake: (() => void) | null;
  state: RunnerState;
  cached: Item[];
  lastWarn: { text: string; at: number } | null;
}

const BY = "automatización";

export class AutomationRunner {
  private run: Run | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  get state(): RunnerState | null {
    return this.run ? this.run.state : null;
  }

  get runningId(): string | null {
    return this.run?.automationId ?? null;
  }

  /**
   * Arranca `a` (detiene la que hubiera). Resuelve cuando la pestaña está abierta y el recorrido empezó;
   * falla si la pestaña no existe o Resolume no responde.
   */
  async start(a: Automation): Promise<void> {
    this.stop();
    const run: Run = {
      automationId: a.id,
      stopped: false,
      wake: null,
      state: { automationId: a.id, automationName: a.name, startedAt: Date.now(), current: null, next: null, loops: 0 },
      cached: [],
      lastWarn: null,
    };
    this.run = run;
    this.deps.changed();
    try {
      if (a.deckName) await this.ensureDeck(a.deckName, true);
    } catch (e) {
      if (this.run === run) {
        this.run = null;
        this.deps.changed();
      }
      throw e;
    }
    if (run.stopped) return;
    void this.loop(run).catch((e: unknown) => {
      this.deps.log("error", BY, `La automatización "${a.name}" se detuvo por un error: ${(e as Error).message}`);
      if (this.run === run) {
        this.run = null;
        this.deps.changed();
      }
    });
  }

  /** Detiene la automatización en curso; el clip actual sigue sonando. false si no había ninguna. */
  stop(): boolean {
    const run = this.run;
    if (!run) return false;
    run.stopped = true;
    run.wake?.();
    this.run = null;
    this.deps.changed();
    return true;
  }

  /** Corta la espera del clip actual y pasa al siguiente. false si no hay automatización en curso. */
  skip(): boolean {
    if (!this.run) return false;
    this.run.wake?.();
    return true;
  }

  // ------------------------------------------------------------------------------------------

  private wait(run: Run, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (run.wake === done) run.wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      run.wake = done;
    });
  }

  /** Avisos sin repetir el mismo texto seguido (por ejemplo con Resolume caído). */
  private warn(run: Run, text: string): void {
    const now = Date.now();
    if (run.lastWarn && run.lastWarn.text === text && now - run.lastWarn.at < 60_000) return;
    run.lastWarn = { text, at: now };
    this.deps.log("warn", BY, text);
  }

  /** true si la pestaña `name` está abierta (con `open`, la abre si no lo está). */
  private async ensureDeck(name: string, open: boolean, comp?: RComposition): Promise<boolean> {
    comp ??= (await this.deps.api.call("GET", "/composition")) as RComposition;
    const decks = comp.decks ?? [];
    const target = name.trim().toLowerCase();
    const index = decks.findIndex((d) => String(d.name?.value ?? "").trim().toLowerCase() === target);
    if (index < 0) {
      throw new Error(`No existe la pestaña "${name}" (hay: ${decks.map((d) => String(d.name?.value ?? "")).join(", ") || "ninguna"})`);
    }
    if (decks[index].selected?.value === true) return true;
    if (!open) return false;
    await selectDeckAndWait(this.deps.api, index + 1, this.deps.deckSettleMs);
    this.deps.log("info", BY, `Abrí la pestaña "${String(decks[index].name?.value ?? name)}"`);
    return true;
  }

  /** Lista de clips de esta vuelta. */
  private async items(run: Run, a: Automation): Promise<Item[]> {
    if (a.clips.length) return a.clips.map((c) => ({ clipId: c.clipId, column: c.column, name: c.name || `clip ${c.clipId}` }));
    // Todos los clips cargados en la capa, releídos en cada vuelta.
    const comp = (await this.deps.api.call("GET", "/composition")) as RComposition;
    // Si alguien cambió de pestaña a mano, se siguen usando los clips leídos antes.
    if (a.deckName && !(await this.ensureDeck(a.deckName, false, comp))) return run.cached;
    const layer = comp.layers?.[a.layer - 1];
    if (!layer) throw new Error(`No existe la capa ${a.layer}`);
    const list: Item[] = [];
    (layer.clips ?? []).forEach((c, i) => {
      if (c.id === undefined || clipStateOf(c.connected?.value) === "empty") return;
      list.push({ clipId: c.id, column: i + 1, name: clipName(c) });
    });
    run.cached = list;
    return list;
  }

  private shuffle(items: Item[], lastId: number | null): Item[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    // Sin repetir el último de la vuelta anterior.
    if (out.length > 1 && out[0].clipId === lastId) {
      const j = 1 + Math.floor(Math.random() * (out.length - 1));
      [out[0], out[j]] = [out[j], out[0]];
    }
    return out;
  }

  private async loop(run: Run): Promise<void> {
    const { api } = this.deps;
    let lastId: number | null = null;

    while (!run.stopped) {
      let a = this.deps.getAutomation(run.automationId);
      if (!a) {
        this.deps.log("info", BY, "La automatización ya no existe; me detengo");
        if (this.run === run) this.stop();
        return;
      }

      let items: Item[];
      try {
        items = await this.items(run, a);
      } catch (e) {
        this.warn(run, `No pude leer la capa ${a.layer} (${(e as Error).message}). Reintento.`);
        await this.wait(run, this.deps.retryMs);
        continue;
      }
      if (run.stopped) return;
      if (!items.length) {
        this.warn(run, `La capa ${a.layer} no tiene clips. Reintento.`);
        await this.wait(run, this.deps.retryMs);
        continue;
      }
      if (a.order === "shuffle") items = this.shuffle(items, lastId);

      let launched = 0;
      for (let i = 0; i < items.length && !run.stopped; i++) {
        const item = items[i];
        a = this.deps.getAutomation(run.automationId) ?? a;

        let clip: RClip;
        try {
          clip = (await api.call("GET", `/composition/clips/by-id/${item.clipId}`)) as RClip;
        } catch (e) {
          this.warn(run, `No pude leer "${item.name}" (col ${item.column}): ${(e as Error).message}. Lo salto.`);
          continue;
        }
        if (!clip || clipStateOf(clip.connected?.value) === "empty") {
          this.warn(run, `La celda de "${item.name}" (col ${item.column}) está vacía. La salto.`);
          continue;
        }
        const name = clipName(clip);
        const plan = planDuration(clipLengthS(clip) ?? 0, a.minSeconds, a.maxSeconds);

        let fitted: string | null = null;
        if (a.fit && isFileClip(clip)) {
          try {
            fitted = await fitClip(api, clip, await this.deps.compRatio());
          } catch (e) {
            this.warn(run, `No pude ajustar "${name}" a la pantalla: ${(e as Error).message}`);
          }
        }
        if (run.stopped) return;
        try {
          await api.call("POST", `/composition/clips/by-id/${item.clipId}/connect`);
        } catch (e) {
          this.warn(run, `Falló lanzar "${name}" (col ${item.column}): ${(e as Error).message}. Paso al siguiente.`);
          await this.wait(run, this.deps.retryMs);
          continue;
        }
        if (run.stopped) return;

        launched++;
        lastId = item.clipId;
        run.lastWarn = null;
        const now = Date.now();
        const following = items[i + 1] ?? (a.order === "sequential" ? items[0] : null);
        run.state.current = { clipId: item.clipId, column: item.column, name, startedAt: now, until: now + plan.seconds * 1000, how: plan.how };
        run.state.next = following ? { clipId: following.clipId, column: following.column, name: following.name } : null;
        this.deps.changed();
        this.deps.log("info", BY, `Col ${item.column}: ${name} → ${fmtDuration(plan.seconds)} (${plan.how})${fitted ? ` [ajustado: ${fitted}]` : ""}`);

        await this.wait(run, plan.seconds * 1000);
      }
      if (run.stopped) return;
      if (launched) {
        run.state.loops++;
        this.deps.changed();
      } else {
        // Ningún clip se pudo lanzar en toda la vuelta: no girar en seco.
        await this.wait(run, this.deps.retryMs);
      }
    }
  }
}
