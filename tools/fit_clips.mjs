// Ajusta todos los clips de video/imagen para que cuadren en la pantalla de la composición.
// - Proporción cercana a la de la composición → Fill (llena la pantalla, sin bordes).
// - Proporción muy distinta (vertical, cuadrada, panorámica) → Fit (se ve completa, con bordes).
// - Escala del Transform del clip distinta de 100% → 100%.
// No toca fuentes generadas ni efectos (Video Router, Slice Outline, etc.). Recorre todas las pestañas
// y al final deja abierta la que estaba. Con --dry-run solo muestra lo que cambiaría.
// --layers=1,3 limita las capas (por defecto todas).
// --current ajusta solo la pestaña abierta, sin cambiar de pestaña. Ojo: Resolume descarta estos
// ajustes hechos por la API al cambiar de pestaña; el autopiloto los vuelve a aplicar antes de lanzar cada clip.
const API = `${(process.env.RESOLUME_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "")}/api/v1`;
const DRY = process.argv.includes("--dry-run");
const layersArg = process.argv.find((a) => a.startsWith("--layers="));
const ONLY = layersArg ? new Set(layersArg.slice(9).split(",").map(Number)) : null;
const CURRENT = process.argv.includes("--current");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body) {
  const res = await fetch(API + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const comp = () => call("GET", "/composition");
async function selectDeck(i) {
  await call("POST", `/composition/decks/${i + 1}/select`);
  for (let k = 0; k < 40 && !(await comp()).decks[i].selected.value; k++) await sleep(250);
  await sleep(1500);
}

let c = await comp();
const W = c.video.width.value, H = c.video.height.value, target = W / H;
const original = c.decks.findIndex((d) => d.selected.value);
console.log(`Composición ${W}x${H}${DRY ? "  [DRY RUN]" : ""}`);

let changed = 0;
for (let d = 0; d < c.decks.length; d++) {
  if (CURRENT && d !== original) continue;
  if (!CURRENT) await selectDeck(d);
  const cur = await comp();
  console.log(`\n== ${cur.decks[d].name.value}`);
  for (const [li, layer] of cur.layers.entries()) {
    if (ONLY && !ONLY.has(li + 1)) continue;
    for (const [ci, clip] of layer.clips.entries()) {
      const v = clip.video;
      if (clip.connected.value === "Empty" || !v?.fileinfo?.width) continue;
      const ratio = v.fileinfo.width / v.fileinfo.height;
      const want = Math.abs(ratio / target - 1) <= 0.1 ? "Fill" : "Fit";
      const tr = (v.effects ?? []).find((e) => e.name === "Transform");
      const scale = tr?.params?.Scale;
      const fixes = [];
      if (v.resize?.value !== want) fixes.push(`${v.resize?.value} → ${want}`);
      if (scale && Math.abs(scale.value - 100) > 0.01) fixes.push(`escala ${Math.round(scale.value)}% → 100%`);
      if (!fixes.length) continue;
      const tag = want === "Fit" ? `  (formato ${v.fileinfo.width}x${v.fileinfo.height}, se ve completo con bordes)` : "";
      console.log(`  capa ${li + 1} col ${String(ci + 1).padStart(2)} ${clip.name.value}: ${fixes.join(", ")}${tag}`);
      changed++;
      if (DRY) continue;
      // El resize solo se aplica cambiando el parámetro por id (un PUT al clip lo ignora).
      if (v.resize?.value !== want) await call("PUT", `/parameter/by-id/${v.resize.id}`, JSON.stringify({ value: want }));
      if (scale && Math.abs(scale.value - 100) > 0.01) await call("PUT", `/parameter/by-id/${scale.id}`, JSON.stringify({ value: 100 }));
    }
  }
}
if (!CURRENT) await selectDeck(original);
console.log(`\n${DRY ? "Cambiarían" : "Ajustados"} ${changed} clips. Pestaña abierta: ${(await comp()).decks[original].name.value}`);
