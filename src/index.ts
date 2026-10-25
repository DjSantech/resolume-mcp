#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// URL de la Webserver de Resolume (Preferences → Webserver). Se cambia sin recompilar.
const RESOLUME_URL = (process.env.RESOLUME_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const API = `${RESOLUME_URL}/api/v1`;
const TIMEOUT_MS = 5000;

async function resolume(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resolume respondió ${res.status} ${res.statusText} en ${method} ${path}${text ? `: ${text}` : ""}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg} (RESOLUME_URL=${RESOLUME_URL})` }], isError: true };
}

// Los índices empiezan en 1, igual que en la interfaz de Arena.
const index = z.number().int().min(1);
const unit = z.number().min(0).max(1);

const server = new McpServer({ name: "resolume", version: "1.0.0" });

server.tool(
  "trigger_clip",
  "Lanza (conecta) un clip de Resolume Arena. Índices desde 1.",
  { layer: index.describe("Número de capa (1 = la de abajo)"), column: index.describe("Número de columna/clip") },
  async ({ layer, column }) => {
    try {
      await resolume("POST", `/composition/layers/${layer}/clips/${column}/connect`);
      return ok(`Clip lanzado: capa ${layer}, columna ${column}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "select_column",
  "Lanza una columna entera (todos los clips de esa columna).",
  { column: index.describe("Número de columna") },
  async ({ column }) => {
    try {
      await resolume("POST", `/composition/columns/${column}/connect`);
      return ok(`Columna ${column} lanzada.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "set_layer_opacity",
  "Cambia la opacidad de una capa (0 a 1).",
  { layer: index.describe("Número de capa"), value: unit.describe("Opacidad entre 0 y 1") },
  async ({ layer, value }) => {
    try {
      await resolume("PUT", `/composition/layers/${layer}`, { video: { opacity: { value } } });
      return ok(`Opacidad de la capa ${layer} = ${value}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "set_master_opacity",
  "Cambia la opacidad general (master) de la composición (0 a 1).",
  { value: unit.describe("Opacidad entre 0 y 1") },
  async ({ value }) => {
    try {
      await resolume("PUT", `/composition`, { master: { value } });
      return ok(`Master de la composición = ${value}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "set_bpm",
  "Cambia el tempo (BPM) de la composición.",
  { bpm: z.number().min(20).max(500).describe("Tempo en BPM") },
  async ({ bpm }) => {
    try {
      await resolume("PUT", `/composition`, { tempocontroller: { tempo: { value: bpm } } });
      return ok(`Tempo = ${bpm} BPM.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "clear_all",
  "Apaga (desconecta) todos los clips de la composición.",
  {},
  async () => {
    try {
      await resolume("POST", `/composition/disconnect-all`);
      return ok("Todos los clips desconectados.");
    } catch (e) {
      return fail(e);
    }
  }
);

type Param = { value?: unknown } | undefined;
type Clip = { name?: Param; connected?: Param };
type Layer = { name?: Param; clips?: Clip[] };
type Column = { name?: Param };
type Composition = {
  name?: Param;
  layers?: Layer[];
  columns?: Column[];
  master?: Param;
  tempocontroller?: { tempo?: Param };
};

const val = (p: Param) => (p && p.value !== undefined ? String(p.value) : "");
// Resolume usa "#" en los nombres por defecto ("Capa #", "AV 00#") para indicar el índice.
const label = (p: Param, i: number) => val(p).replace(/#/g, String(i));

server.tool(
  "get_composition_summary",
  "Lista capas, columnas y clips cargados en Resolume, con su estado. Úsalo primero para saber qué hay.",
  {},
  async () => {
    try {
      const comp = (await resolume("GET", `/composition`)) as Composition;
      const lines: string[] = [];
      lines.push(`Composición: ${val(comp.name) || "(sin nombre)"}`);
      if (comp.tempocontroller?.tempo) lines.push(`Tempo: ${val(comp.tempocontroller.tempo)} BPM`);
      if (comp.master) lines.push(`Master: ${val(comp.master)}`);

      const columns = comp.columns ?? [];
      if (columns.length) {
        lines.push(`Columnas (${columns.length}): ` + columns.map((c, i) => `${i + 1}=${label(c.name, i + 1) || "?"}`).join(", "));
      }

      const layers = comp.layers ?? [];
      lines.push(`Capas (${layers.length}):`);
      layers.forEach((layer, li) => {
        lines.push(`- Capa ${li + 1}: ${label(layer.name, li + 1) || "(sin nombre)"}`);
        (layer.clips ?? []).forEach((clip, ci) => {
          const state = val(clip.connected);
          if (state === "Empty") return;
          const name = val(clip.name) || "(sin nombre)";
          lines.push(`    · Columna ${ci + 1}: ${name}${state ? ` [${state}]` : ""}`);
        });
      });
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout lo usa el protocolo MCP; los logs van a stderr.
console.error(`resolume-mcp listo, apuntando a ${API}`);
