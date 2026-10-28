// Pruebas del agente (.exe): código de vinculación, credenciales, versiones, decisión de actualización,
// seguridad de la página local y URL del puente en modo cuentas.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { bridgeWsUrl } from "../bridge/bridge.js";
import { autostartCommand } from "../agent/autostart.js";
import {
  cleanPcName, deleteCredentials, loadCredentials, normalizePairingCode, normalizeServerUrl, saveCredentials, type Credentials,
} from "../agent/credentials.js";
import { createLocalServer, listenLocal, type AgentApi } from "../agent/local-server.js";
import { createLogger } from "../agent/log.js";
import { agentDir } from "../agent/paths.js";
import { compareVersions, decideUpdate, resolveDownloadUrl } from "../agent/update.js";

describe("código de vinculación", () => {
  test("acepta mayúsculas/minúsculas, guion y espacios", () => {
    assert.equal(normalizePairingCode("abc-234"), "ABC234");
    assert.equal(normalizePairingCode(" K7P Q3X "), "K7PQ3X");
    assert.equal(normalizePairingCode("K7PQ3X"), "K7PQ3X");
  });
  test("rechaza longitud o caracteres ambiguos", () => {
    assert.equal(normalizePairingCode("ABC12"), null);
    assert.equal(normalizePairingCode("ABC-123"), null); // 1 no está en el alfabeto
    assert.equal(normalizePairingCode("ABCO23"), null); // O tampoco
    assert.equal(normalizePairingCode(""), null);
  });
  test("servidor y nombre del PC", () => {
    assert.equal(normalizeServerUrl("mi-panel.com/app"), "https://mi-panel.com");
    assert.equal(normalizeServerUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
    assert.equal(normalizeServerUrl("ftp://x"), null);
    assert.equal(normalizeServerUrl(""), null);
    assert.equal(cleanPcName("  Cabina\n VJ ", "host"), "Cabina VJ");
    assert.equal(cleanPcName("", "MI-PC"), "MI-PC");
  });
  test("carpeta de datos", () => {
    assert.equal(agentDir({ APPDATA: "C:\\X" }, "/home/u"), join("C:\\X", "VisualMaping"));
    assert.equal(agentDir({}, "/home/u"), join("/home/u", ".visualmaping"));
  });
});

describe("credenciales", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "vm-agente-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test("guardar, leer y borrar", async () => {
    const file = join(dir, "sub", "agente.json");
    const c: Credentials = { serverUrl: "https://x.com", agentId: "a1", agentSecret: "s3cr3t-largo", orgName: "Org", pcName: "PC" };
    assert.equal(await loadCredentials(file), null);
    await saveCredentials(file, { ...c, extra: 1 } as Credentials);
    assert.deepEqual(await loadCredentials(file), c);
    await deleteCredentials(file);
    await deleteCredentials(file); // dos veces no falla
    assert.equal(await loadCredentials(file), null);
  });
  test("archivo dañado o incompleto = sin vincular", async () => {
    const file = join(dir, "malo.json");
    await saveCredentials(file, { serverUrl: "https://x.com", agentId: "", agentSecret: "s", orgName: "", pcName: "" });
    assert.equal(await loadCredentials(file), null);
  });
  test("el registro tacha secretos y rota", async () => {
    const file = join(dir, "agente.log");
    const log = createLogger(file, { maxBytes: 200 });
    log.addSecret("supersecreto123");
    log("conectando con supersecreto123");
    assert.ok(!(await readFile(file, "utf8")).includes("supersecreto123"));
    for (let i = 0; i < 10; i++) log("x".repeat(50));
    assert.ok((await stat(`${file}.1`)).size > 0);
  });
});

describe("versiones y actualización", () => {
  test("compareVersions", () => {
    assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
    assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
    assert.equal(compareVersions("basura", "1.0.0"), -1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
  });

  const sha = "a".repeat(64);
  const base = { current: "1.0.0", packaged: true, automationRunning: false };
  test("decideUpdate", () => {
    assert.equal(decideUpdate({ ...base, info: null }).action, "none");
    assert.equal(decideUpdate({ ...base, info: { version: "" } }).action, "none");
    assert.equal(decideUpdate({ ...base, info: { version: "1.0.0", downloadUrl: "https://x/a.exe", sha256: sha } }).action, "none");
    assert.equal(decideUpdate({ ...base, info: { version: "1.1.0", downloadUrl: "", sha256: sha } }).action, "none");
    assert.equal(decideUpdate({ ...base, info: { version: "1.1.0", downloadUrl: "https://x/a.exe", sha256: "corto" } }).action, "none");
    assert.equal(decideUpdate({ ...base, packaged: false, info: { version: "1.1.0", downloadUrl: "https://x/a.exe", sha256: sha } }).action, "none");
    assert.equal(decideUpdate({ ...base, automationRunning: true, info: { version: "1.1.0", downloadUrl: "https://x/a.exe", sha256: sha } }).action, "wait");
    const d = decideUpdate({ ...base, info: { version: "1.1.0", downloadUrl: "https://x/a.exe", sha256: sha.toUpperCase() } });
    assert.equal(d.action, "install");
    assert.equal(d.action === "install" && d.info.sha256, sha);
  });
  test("solo descargas https (o http local)", () => {
    assert.equal(resolveDownloadUrl("https://s.com", "/descargas/a.exe"), "https://s.com/descargas/a.exe");
    assert.equal(resolveDownloadUrl("https://s.com", "http://evil.com/a.exe"), null);
    assert.equal(resolveDownloadUrl("http://127.0.0.1:3000", "http://127.0.0.1:3000/a.exe"), "http://127.0.0.1:3000/a.exe");
  });
  test("comando de inicio con Windows", () => {
    assert.equal(autostartCommand("C:\\Program Files\\VM\\a.exe"), "\"C:\\Program Files\\VM\\a.exe\" --background");
  });
});

describe("página local", () => {
  const TOKEN = "token-de-prueba-0123456789abcdef";
  const calls: string[] = [];
  const stub: AgentApi = {
    status: () => ({ paired: false }),
    pair: async (b) => { calls.push(`pair:${String(b.code)}`); return { ok: true }; },
    unpair: async () => { calls.push("unpair"); },
    setAutostart: async (on) => { calls.push(`auto:${on}`); },
  };
  const server = createLocalServer(stub, TOKEN);
  let port = 0;
  before(async () => { await listenLocal(server, 0); port = (server.address() as AddressInfo).port; });
  after(() => new Promise<void>((r) => server.close(() => r())));

  function req(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      r.on("error", reject);
      r.end(body);
    });
  }
  const json = { "content-type": "application/json" };

  test("la página lleva el token y no se puede enmarcar", async () => {
    const r = await req("GET", "/", {});
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(TOKEN));
  });
  test("Host ajeno (DNS rebinding) → 403", async () => {
    assert.equal((await req("GET", "/", { host: `evil.com:${port}` })).status, 403);
    assert.equal((await req("GET", "/api/estado", { host: "evil.com", "x-vm-token": TOKEN })).status, 403);
  });
  test("API sin token o con token malo → 403", async () => {
    assert.equal((await req("GET", "/api/estado", {})).status, 403);
    assert.equal((await req("POST", "/api/desvincular", { ...json, "x-vm-token": "otro" }, "{}")).status, 403);
    assert.equal((await req("GET", "/api/estado", { "x-vm-token": TOKEN })).status, 200);
  });
  test("POST desde otro origen o sin JSON → rechazado", async () => {
    const h = { "x-vm-token": TOKEN };
    assert.equal((await req("POST", "/api/desvincular", { ...h, ...json, origin: "https://evil.com" }, "{}")).status, 403);
    assert.equal((await req("POST", "/api/desvincular", { ...h, ...json, "sec-fetch-site": "cross-site" }, "{}")).status, 403);
    assert.equal((await req("POST", "/api/desvincular", { ...h, "content-type": "text/plain" }, "{}")).status, 415);
    assert.deepEqual(calls, []);
  });
  test("POST válido llega al agente", async () => {
    const h = { "x-vm-token": TOKEN, ...json, origin: `http://localhost:${port}` };
    assert.equal((await req("POST", "/api/vincular", h, JSON.stringify({ code: "abc-234" }))).status, 200);
    assert.equal((await req("POST", "/api/inicio-windows", h, JSON.stringify({ enabled: true }))).status, 200);
    assert.equal((await req("POST", "/api/desvincular", h, "{}")).status, 200);
    assert.deepEqual(calls, ["pair:abc-234", "auto:true", "unpair"]);
  });
});

describe("URL del puente", () => {
  test("modo agente usa agent y secret", () => {
    const u = new URL(bridgeWsUrl("https://vm.onrender.com/", { eventId: "pc", eventName: "PC", agentId: "ag 1", agentSecret: "s/+=" }));
    assert.equal(u.protocol, "wss:");
    assert.equal(u.pathname, "/ws/bridge");
    assert.equal(u.searchParams.get("agent"), "ag 1");
    assert.equal(u.searchParams.get("secret"), "s/+=");
    assert.equal(u.searchParams.get("token"), null);
  });
  test("modo códigos sigue igual", () => {
    const u = new URL(bridgeWsUrl("http://127.0.0.1:3000", { eventId: "pc", eventName: "Mi PC", bridgeToken: "tok" }));
    assert.equal(u.protocol, "ws:");
    assert.equal(u.searchParams.get("event"), "pc");
    assert.equal(u.searchParams.get("name"), "Mi PC");
    assert.equal(u.searchParams.get("token"), "tok");
    assert.equal(u.searchParams.get("agent"), null);
  });
});
