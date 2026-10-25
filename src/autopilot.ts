#!/usr/bin/env node
// Autopiloto: recorre los clips de una capa, cada uno entre MIN y MAX segundos, y vuelve a empezar.
// Uso: node dist/autopilot.js            → corre de verdad
//      node dist/autopilot.js --dry-run  → solo muestra el plan, no lanza nada
// Ctrl+C lo detiene y deja sonando el clip actual.

import { fitClip } from "./fit.js";

const RESOLUME_URL = (process.env.RESOLUME_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const API = `${RESOLUME_URL}/api/v1`;
const LAYER = Number(process.env.LAYER ?? 1);
// Pestaña (deck) de Resolume. Vacío = la que esté abierta.
const DECK = (process.env.DECK ?? "").trim();
const MIN_S = Number(process.env.MIN_SECONDS ?? 120);
const MAX_S = Number(process.env.MAX_SECONDS ?? 180);
const DRY_RUN = process.argv.includes("--dry-run");
// FIT=off desactiva el ajuste de tamaño antes de lanzar cada clip.
const FIT = (process.env.FIT ?? "on").toLowerCase() !== "off";
const RETRY_MS = 5000;

type Param = { value?: unknown; max?: number } | undefined;
type Clip = { id?: number; name?: Param; connected?: Param; transport?: { position?: Param } };
type Layer = { clips?: Clip[] };
type Deck = { name?: Param; selected?: Param };

async function resolume(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Resolume respondió ${res.status} en ${method} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const fmt = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const now = () => new Date().toLocaleTimeString();

type Slot = { id: number; column: number; name: string; lengthS: number };

// Devuelve true si la pestaña DECK es la que está abierta. La primera vez la abre.
let deckOpened = false;
async function ensureDeck(): Promise<boolean> {
  if (!DECK) return true;
  const comp = (await resolume("GET", `/composition`)) as { decks?: Deck[] };
  const decks = comp.decks ?? [];
  const index = decks.findIndex((d) => String(d.name?.value ?? "").toLowerCase() === DECK.toLowerCase());
  if (index < 0) throw new Error(`no existe la pestaña "${DECK}" (hay: ${decks.map((d) => d.name?.value).join(", ")})`);
  if (decks[index].selected?.value) return true;
  if (deckOpened) return false;
  await resolume("POST", `/composition/decks/${index + 1}/select`);
  // Resolume tarda un momento en cargar la pestaña; antes de eso devuelve los clips de la anterior.
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const c = (await resolume("GET", `/composition`)) as { decks?: Deck[] };
    if (c.decks?.[index]?.selected?.value) break;
  }
  await sleep(1500);
  console.log(`[${now()}] Abrí la pestaña "${DECK}".`);
  deckOpened = true;
  return true;
}

// Columnas con clip cargado en la capa (se relee en cada vuelta por si cambias clips).
// Si alguien cambió a otra pestaña, se siguen usando los clips leídos antes: se lanzan por id.
let cached: Slot[] = [];
async function loadSlots(): Promise<Slot[]> {
  if (!(await ensureDeck())) return cached;
  const layer = (await resolume("GET", `/composition/layers/${LAYER}`)) as Layer;
  const slots: Slot[] = [];
  (layer.clips ?? []).forEach((clip, i) => {
    if (clip.connected?.value === "Empty" || clip.id === undefined) return;
    // position.max es la duración efectiva del clip en ms (ya incluye cambios de velocidad).
    const lengthS = (clip.transport?.position?.max ?? 0) / 1000;
    slots.push({ id: clip.id, column: i + 1, name: String(clip.name?.value ?? "(sin nombre)"), lengthS });
  });
  cached = slots;
  return slots;
}

// Cuánto tiempo dejar el clip: repeticiones completas si caben en el rango; si no, un corte al azar dentro del rango.
function planDuration(lengthS: number): { seconds: number; how: string } {
  if (lengthS > 0) {
    const minLoops = Math.ceil(MIN_S / lengthS);
    const maxLoops = Math.floor(MAX_S / lengthS);
    if (minLoops <= maxLoops) {
      const loops = minLoops + Math.floor(Math.random() * (maxLoops - minLoops + 1));
      return { seconds: loops * lengthS, how: loops === 1 ? "1 pasada completa" : `${loops} repeticiones` };
    }
  }
  return { seconds: rand(MIN_S, MAX_S), how: lengthS > MAX_S ? "clip largo, se corta" : "no encaja exacto, se corta" };
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`\n[${now()}] Autopiloto detenido. El clip actual sigue sonando.`);
  process.exit(0);
});

async function main() {
  console.log(`Autopiloto capa ${LAYER}${DECK ? `, pestaña "${DECK}"` : ""} → ${API}  (cada clip ${fmt(MIN_S)}–${fmt(MAX_S)})${DRY_RUN ? "  [DRY RUN]" : ""}`);

  if (DRY_RUN) {
    if (DECK) console.log(`  (el plan necesita leer la pestaña "${DECK}"; si no está abierta, la abre)`);
    const slots = await loadSlots();
    for (const s of slots) {
      const p = planDuration(s.lengthS);
      console.log(`  Col ${String(s.column).padStart(2)}  ${s.name.padEnd(40)} dura ${fmt(s.lengthS)} → ${fmt(p.seconds)} (${p.how})`);
    }
    const total = slots.reduce((acc, s) => acc + planDuration(s.lengthS).seconds, 0);
    console.log(`Vuelta completa aprox: ${fmt(total)} (${slots.length} clips). Los tiempos cambian un poco cada vuelta.`);
    return;
  }

  for (;;) {
    let slots: Slot[];
    try {
      slots = await loadSlots();
    } catch (e) {
      console.error(`[${now()}] No pude leer Resolume (${(e as Error).message}). Reintento en ${RETRY_MS / 1000}s...`);
      await sleep(RETRY_MS);
      continue;
    }
    if (!slots.length) {
      console.error(`[${now()}] La capa ${LAYER} no tiene clips. Reintento en ${RETRY_MS / 1000}s...`);
      await sleep(RETRY_MS);
      continue;
    }

    for (const s of slots) {
      const p = planDuration(s.lengthS);
      try {
        const fitted = FIT ? await fitClip(resolume, s.id).catch(() => null) : null;
        await resolume("POST", `/composition/clips/by-id/${s.id}/connect`);
        console.log(`[${now()}] Col ${s.column}: ${s.name} → ${fmt(p.seconds)} (${p.how})${fitted ? ` [ajustado: ${fitted}]` : ""}`);
      } catch (e) {
        console.error(`[${now()}] Falló lanzar col ${s.column} (${(e as Error).message}). Paso al siguiente.`);
        await sleep(RETRY_MS);
        continue;
      }
      await sleep(p.seconds * 1000);
    }
    console.log(`[${now()}] Vuelta completa, empiezo de nuevo.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
