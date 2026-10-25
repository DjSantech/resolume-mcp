// Arma las pestañas del show. Nunca conecta (lanza) clips y no toca casillas que estén al aire.
//   node tools/setup_decks.mjs fiesta    → agrega visuales de fiesta a la capa 1 de "Fiesta Santech"
//   node tools/setup_decks.mjs protocol  → crea "Protocol Santech" con 15 visuales dorados/blancos en la capa 1
// Al terminar vuelve a la pestaña Fiesta Santech.
const API = `${(process.env.RESOLUME_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "")}/api/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, type = "application/json") {
  const res = await fetch(API + p, { method, headers: body !== undefined ? { "Content-Type": type } : undefined, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${await res.text().catch(() => "")}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const comp = () => call("GET", "/composition");
// Rutas relativas al disco D: del PC que corre Resolume.
const uri = (p) => "file:///D:/" + p.split("/").map(encodeURIComponent).join("/");

async function loadInto(layer, col, path) {
  const c = await comp();
  const clip = c.layers[layer - 1].clips[col - 1];
  if (clip.connected.value === "Connected") throw new Error(`capa ${layer} col ${col} está al aire, no la toco`);
  await call("POST", `/composition/clips/by-id/${clip.id}/open`, uri(path), "text/plain");
  await sleep(300);
  const after = await call("GET", `/composition/clips/by-id/${clip.id}`);
  console.log(`  capa ${layer} col ${String(col).padStart(2)} ← ${path}  (${after.name.value})`);
}
async function ensureColumns(n) {
  while ((await comp()).columns.length < n) await call("POST", "/composition/columns/add");
}
async function selectDeck(name) {
  const c = await comp();
  const i = c.decks.findIndex((d) => d.name.value === name);
  if (i < 0) throw new Error(`no existe la pestaña ${name}`);
  if (!c.decks[i].selected.value) await call("POST", `/composition/decks/${i + 1}/select`);
  // Resolume tarda un momento en cargar la pestaña.
  for (let k = 0; k < 40 && !(await comp()).decks[i].selected.value; k++) await sleep(250);
  await sleep(1500);
}

const FIESTA_COL4 = "RENDERIZADOS/14.mov";
const FIESTA_NEW = [
  "RENDERIZADOS/48.mov", "RENDERIZADOS/60.mov", "RENDERIZADOS/18.mov", "VISUALESMP4/8.mp4", "VISUALESMP4/7.mp4",
  "RENDERIZADOS/91.mov", "RENDERIZADOS/99.mov", "RENDERIZADOS/151.mov", "RENDERIZADOS/146.mov", "RENDERIZADOS/50.mov",
];
const PROTOCOL_LIST = [
  "RENDERIZADOS/69.mov",
  "VISUALESMP4/204923-925628367_small.mp4",
  "RENDERIZADOS/37.mov",
  "RENDERIZADOS/152.mov",
  "RENDERIZADOS/36.mov",
  "VISUALESMP4/1.mp4",
  "RENDERIZADOS/156.mov",
  "RENDERIZADOS/95.mov",
  "RENDERIZADOS/08golden-lines-2021-09-04-00-07-12-utc.mov",
  "RENDERIZADOS/105.mov",
  "VISUALESMP4/18943-297535727_medium.mp4",
  "RENDERIZADOS/57.mov",
  "RENDERIZADOS/75.mov",
  "RENDERIZADOS/166.mov",
  "VISUALESMP4/36.mp4",
];

const step = process.argv[2];
if (step === "fiesta") {
  await selectDeck("Fiesta Santech");
  console.log("Fiesta Santech, capa 1:");
  await loadInto(1, 4, FIESTA_COL4);
  let col = 12;
  for (const p of FIESTA_NEW) {
    await ensureColumns(col);
    let c = await comp();
    while (c.layers[0].clips[col - 1].connected.value !== "Empty") { col++; await ensureColumns(col); c = await comp(); }
    await loadInto(1, col, p);
    col++;
  }
} else if (step === "protocol") {
  let c = await comp();
  if (!c.decks.some((d) => d.name.value === "Protocol Santech")) {
    await call("POST", "/composition/decks/add");
    await sleep(800);
    c = await comp();
    await call("PUT", `/composition/decks/${c.decks.length}`, JSON.stringify({ name: { value: "Protocol Santech" } }));
    console.log(`Pestaña nueva #${c.decks.length} "Protocol Santech"`);
  }
  await selectDeck("Protocol Santech");
  await ensureColumns(PROTOCOL_LIST.length);
  for (const [i, p] of PROTOCOL_LIST.entries()) await loadInto(1, i + 1, p);
  await selectDeck("Fiesta Santech");
  console.log("Volví a Fiesta Santech.");
} else {
  console.error("Uso: node tools/setup_decks.mjs fiesta|protocol");
  process.exit(1);
}
const c = await comp();
console.log("Pestañas:", c.decks.map((d) => d.name.value + (d.selected.value ? " (abierta)" : "")).join(", "));
c.layers.forEach((l, li) => l.clips.forEach((cl, ci) => { if (cl.connected.value === "Connected") console.log(`  al aire: capa ${li + 1} col ${ci + 1} ${cl.name.value}`); }));
