// Construye el agente como un solo .exe (Node SEA): node scripts/build-agent.mjs (tras `npm run build`).
// Variables: VM_SERVER_URL (servidor de fábrica), VM_CONSOLE=1 (deja la ventana de consola, para depurar).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-agente");
const work = join(out, "work");
const entry = join(root, "dist", "agent", "main.js");
if (!existsSync(entry)) {
  console.error("Falta dist/agent/main.js: corre antes `npm run build`.");
  process.exit(1);
}
const { EXE_NAME, DEFAULT_SERVER_URL } = await import(pathToFileURL(join(root, "dist", "agent", "brand.js")).href);
const { AGENT_VERSION } = await import(pathToFileURL(join(root, "dist", "agent", "version.js")).href);
const serverUrl = (process.env.VM_SERVER_URL ?? "").trim() || DEFAULT_SERVER_URL;

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. Un solo archivo CommonJS con ws incluido.
const bundle = join(work, "agente.cjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["bufferutil", "utf-8-validate"],
  define: { __VM_SERVER_URL__: JSON.stringify(serverUrl) },
  legalComments: "none",
  logLevel: "warning",
});

// 2. Blob SEA.
const blob = join(work, "sea-prep.blob");
const seaConfig = join(work, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Copia de node.exe + blob inyectado. (La firma de node.exe queda inválida; sin signtool no se quita: Windows la ignora.)
const exe = join(out, EXE_NAME);
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
const postject = join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", "--overwrite"], { stdio: "inherit" });

// 4. Sin ventana de consola: subsistema PE de CONSOLE (3) a WINDOWS_GUI (2). Los mensajes van a agente.log.
if (process.env.VM_CONSOLE !== "1") {
  const buf = readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("PE inválido");
  const subsystem = pe + 24 + 68; // cabecera opcional + offset de Subsystem (igual en PE32 y PE32+)
  if (buf.readUInt16LE(subsystem) !== 3) throw new Error(`Subsistema inesperado: ${buf.readUInt16LE(subsystem)}`);
  buf.writeUInt16LE(2, subsystem);
  writeFileSync(exe, buf);
}

// 5. Hash y version.json para publicar.
const sha256 = createHash("sha256").update(readFileSync(exe)).digest("hex");
writeFileSync(`${exe}.sha256`, `${sha256}  ${EXE_NAME}\n`);
writeFileSync(join(out, "version.json"), JSON.stringify({ version: AGENT_VERSION, sha256 }, null, 2) + "\n");
rmSync(work, { recursive: true, force: true });

const mb = (statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\n${exe}\n  versión ${AGENT_VERSION} · servidor ${serverUrl} · ${mb} MB\n  SHA-256 ${sha256}`);
