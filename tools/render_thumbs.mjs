// Saca 4 miniaturas de cada render sin poder ver el disco del PC de Resolume:
// carga el archivo en una casilla vacía (sin conectarla), mueve la posición, pide la miniatura y al final vacía la casilla.
// Uso: node tools/render_thumbs.mjs <clipId de una casilla vacía> <lista.txt> <carpeta_salida> [carpeta en el PC de Resolume]
import fs from "node:fs";
import path from "node:path";

const API = `${(process.env.RESOLUME_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "")}/api/v1`;
const [clipId, listFile, outDir, remoteDir = "D:/RENDERIZADOS"] = process.argv.slice(2);
if (!clipId || !listFile || !outDir) {
  console.error("Uso: node tools/render_thumbs.mjs <clipId> <lista.txt> <carpeta_salida> [carpeta remota]");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const names = fs.readFileSync(listFile, "utf8").split(/\r?\n/).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, type = "application/json") {
  const res = await fetch(API + p, { method, headers: body ? { "Content-Type": type } : undefined, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  return res;
}

const before = await (await call("GET", `/composition/clips/by-id/${clipId}`)).json();
if (before.connected?.value !== "Empty") {
  console.error(`La casilla ${clipId} no está vacía (${before.name?.value}). Elige una vacía.`);
  process.exit(1);
}

try {
  for (const name of names) {
    try {
      await call("POST", `/composition/clips/by-id/${clipId}/open`, `file:///${remoteDir}/${encodeURIComponent(name)}`, "text/plain");
      await sleep(500);
      const clip = await (await call("GET", `/composition/clips/by-id/${clipId}`)).json();
      const pos = clip.transport.position;
      for (const [i, f] of [0.12, 0.38, 0.63, 0.88].entries()) {
        await call("PUT", `/parameter/by-id/${pos.id}`, JSON.stringify({ value: pos.max * f }));
        await call("POST", `/composition/clips/by-id/${clipId}/thumbnail/update`);
        await sleep(350);
        const png = Buffer.from(await (await call("GET", `/composition/clips/by-id/${clipId}/thumbnail`)).arrayBuffer());
        fs.writeFileSync(path.join(outDir, `${path.parse(name).name}__${i}.png`), png);
      }
      console.log("ok", name);
    } catch (e) {
      console.log("ERROR", name, e.message);
    }
  }
} finally {
  await call("POST", `/composition/clips/by-id/${clipId}/clear`).catch((e) => console.log("no pude vaciar la casilla:", e.message));
  console.log("casilla vaciada");
}
