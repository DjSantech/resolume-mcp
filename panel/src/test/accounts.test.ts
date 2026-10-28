// Pruebas del modo cuentas: registro, sesiones, equipo, invitaciones, PCs, aislamiento entre empresas y planes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { EventState } from "../shared/protocol.js";
import { verifyToken } from "../server/auth.js";
import { normalizePairingCode } from "../server/accounts.js";
import { PLANS } from "../server/plans.js";
import { startServer, type RunningServer } from "../server/server.js";
import { MemoryStore } from "../server/store/memory.js";

const SECRET = "secreto-de-sesion-para-pruebas";
const SUPER = "jefe@visualmaping.co";

type Msg = Record<string, any>;

class Peer {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Msg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static connect(url: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const peer = new Peer(ws);
      ws.once("open", () => resolve(peer));
      ws.once("error", reject);
    });
  }

  next(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
    const i = this.messages.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (m: Msg) => {
          clearTimeout(t);
          resolve(m);
        },
      };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("Tiempo agotado esperando un mensaje"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  type(t: string, timeoutMs?: number): Promise<Msg> {
    return this.next((m) => m.type === t, timeoutMs);
  }

  async none(pred: (m: Msg) => boolean, ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.messages.find(pred), undefined);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  close(): Promise<unknown> {
    this.ws.close();
    return this.closed;
  }
}

function sampleState(): EventState {
  return {
    resolumeOnline: true,
    resolume: { product: "Arena", version: "7.20.0" },
    composition: null,
    nowPlaying: [],
    automations: [],
    runner: null,
    updatedAt: Date.now(),
  };
}

let ipCounter = 1;
const freshIp = () => `198.51.100.${ipCounter++ % 250}`;

describe("modo cuentas", () => {
  let srv: RunningServer;
  let store: MemoryStore;
  let base: string;
  let wsBase: string;
  let tmp: string;
  let webDir: string;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "panel-cuentas-"));
    webDir = path.join(tmp, "web");
    await import("node:fs/promises").then((fs) => fs.mkdir(webDir, { recursive: true }));
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>App</title>");
    await writeFile(path.join(webDir, "landing.html"), "<!doctype html><title>Portada</title>");
    await writeFile(path.join(webDir, "app.js"), "export {};");
    store = new MemoryStore();
    srv = await startServer({
      port: 0,
      host: "127.0.0.1",
      store,
      sessionSecret: SECRET,
      staticDir: webDir,
      trustProxy: 1,
      superadminEmails: [SUPER],
      contactWhatsapp: "+57 300 123 4567",
      agentVersion: "1.2.0",
      agentDownloadUrl: "https://ejemplo.co/agente.exe",
      agentSha256: "abc",
      publicUrl: "https://panel.ejemplo.co/",
      commandTimeoutMs: 300,
      eventsThrottleMs: 20,
      log: () => {},
    });
    base = `http://127.0.0.1:${srv.port}`;
    wsBase = `ws://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    await srv.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function api(method: string, p: string, body?: unknown, token?: string, ip = freshIp()) {
    const headers: Record<string, string> = { "X-Forwarded-For": ip };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  let n = 0;
  async function signup(orgName = "Luces SAS", email?: string) {
    const e = email ?? `user${++n}-${Date.now()}@ejemplo.co`;
    const r = await api("POST", "/api/signup", { orgName, name: "Ana", email: e, password: "clave-segura-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { token: r.body.token as string, me: r.body.me, email: e };
  }

  async function client(token: string): Promise<{ peer: Peer; welcome: Msg }> {
    const peer = await Peer.connect(`${wsBase}/ws/client?token=${encodeURIComponent(token)}`);
    return { peer, welcome: await peer.type("welcome") };
  }

  async function pairPc(token: string, pcName = "PC Cabina") {
    const code = await api("POST", "/api/pcs/pairing-code", {}, token);
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const pair = await api("POST", "/api/agent/pair", { code: code.body.code.toLowerCase(), pcName, agentVersion: "1.0.0" });
    assert.equal(pair.status, 200, JSON.stringify(pair.body));
    return pair.body as { agentId: string; agentSecret: string; orgName: string; pcName: string };
  }

  async function bridge(agentId: string, secret: string): Promise<Peer> {
    const q = new URLSearchParams({ agent: agentId, secret });
    const peer = await Peer.connect(`${wsBase}/ws/bridge?${q}`);
    await peer.type("watch");
    return peer;
  }

  // ------------------------------------------------------------ Públicas

  test("/api/config y /api/plans", async () => {
    const c = await api("GET", "/api/config");
    assert.deepEqual(c.body, {
      mode: "accounts",
      brand: "VisualMaping",
      contactWhatsapp: "573001234567",
      agent: { version: "1.2.0", downloadUrl: "https://ejemplo.co/agente.exe" },
    });
    const v = await api("GET", "/api/agent/version");
    assert.deepEqual(v.body, { version: "1.2.0", downloadUrl: "https://ejemplo.co/agente.exe", sha256: "abc" });
    const p = await api("GET", "/api/plans");
    assert.deepEqual(
      p.body.map((x: Msg) => [x.id, x.priceCop, x.maxPcs]),
      [
        ["prueba", 0, 1],
        ["vj", 60000, 1],
        ["productora", 200000, 5],
        ["empresa", 520000, 15],
      ],
    );
    assert.equal(p.body[0].trialDays, 14);
    assert.ok(p.body.every((x: Msg) => Array.isArray(x.features) && x.features.length > 0));
    assert.equal(PLANS.length, 4);
  });

  test("registro, ingreso y /api/me", async () => {
    const email = `Mixto${Date.now()}@Ejemplo.co`;
    const s = await signup("Producciones Ana", email);
    assert.equal(s.me.user.email, email.toLowerCase());
    assert.equal(s.me.role, "owner");
    assert.equal(s.me.org.name, "Producciones Ana");
    assert.equal(s.me.plan.id, "prueba");
    assert.equal(s.me.plan.active, true);
    assert.equal(s.me.plan.daysLeft, 14);
    assert.equal(s.me.superadmin, false);
    // Un token de cuentas no sirve en el modo códigos.
    assert.equal(verifyToken(s.token, SECRET), null);

    const dup = await api("POST", "/api/signup", { orgName: "Otra", name: "B", email: email.toUpperCase(), password: "otra-clave-1" });
    assert.equal(dup.status, 409);

    const short = await api("POST", "/api/signup", { orgName: "X", name: "B", email: "b@ejemplo.co", password: "corta" });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /8 caracteres/);

    const ok = await api("POST", "/api/login", { email: email.toLowerCase(), password: "clave-segura-1" });
    assert.equal(ok.status, 200);
    const me = await api("GET", "/api/me", undefined, ok.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.org.id, s.me.org.id);

    const bad = await api("POST", "/api/login", { email, password: "mala-clave-1" });
    assert.equal(bad.status, 401);
    const none = await api("POST", "/api/login", { email: "nadie@ejemplo.co", password: "mala-clave-1" });
    assert.equal(none.status, 401);
    assert.equal((await api("GET", "/api/me")).status, 401);
    assert.equal((await api("GET", "/api/me", undefined, "basura.xx")).status, 401);
  });

  test("límite de intentos de ingreso por IP", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i++) {
      assert.equal((await api("POST", "/api/login", { email: "x@ejemplo.co", password: "nada-nada" }, undefined, ip)).status, 401);
    }
    assert.equal((await api("POST", "/api/login", { email: "x@ejemplo.co", password: "nada-nada" }, undefined, ip)).status, 429);
  });

  test("cambiar contraseña sube token_version y cierra sesiones", async () => {
    const s = await signup();
    const { peer } = await client(s.token);
    const wrong = await api("PATCH", "/api/me", { password: "nueva-clave-1", currentPassword: "no-es" }, s.token);
    assert.equal(wrong.status, 403);
    const r = await api("PATCH", "/api/me", { password: "nueva-clave-1", currentPassword: "clave-segura-1", name: "Ana María" }, s.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.me.user.name, "Ana María");
    assert.equal((await peer.closed).code, 4001);
    assert.equal((await api("GET", "/api/me", undefined, s.token)).status, 401);
    assert.equal((await api("GET", "/api/me", undefined, r.body.token)).status, 200);
  });

  // ------------------------------------------------------------ Equipo e invitaciones

  test("invitaciones: crear, ver, aceptar, usada y vencida", async () => {
    const owner = await signup("Equipo SAS");
    const inv = await api("POST", "/api/invites", { role: "operator" }, owner.token);
    assert.equal(inv.status, 200);
    assert.equal(inv.body.url, `https://panel.ejemplo.co/app/#invitacion-${inv.body.code}`);
    assert.ok(inv.body.code.length >= 32);

    const bad = await api("POST", "/api/invites", { role: "owner" }, owner.token);
    assert.equal(bad.status, 400);

    const prev = await api("GET", `/api/invites/${inv.body.code}`);
    assert.deepEqual(prev.body, { orgName: "Equipo SAS", role: "operator", expiresAt: inv.body.expiresAt });

    const team0 = await api("GET", "/api/team", undefined, owner.token);
    assert.equal(team0.body.invites.length, 1);

    const email = `op${Date.now()}@ejemplo.co`;
    const acc = await api("POST", `/api/invites/${inv.body.code}/accept`, { name: "Carlos", email, password: "clave-carlos-1" });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.me.role, "operator");
    assert.equal(acc.body.me.org.id, owner.me.org.id);

    assert.equal((await api("GET", `/api/invites/${inv.body.code}`)).status, 410);
    const again = await api("POST", `/api/invites/${inv.body.code}/accept`, { name: "X", email: "x2@ejemplo.co", password: "clave-x-12" });
    assert.equal(again.status, 410);
    assert.equal((await api("GET", "/api/invites/no-existe-este-codigo-123")).status, 404);

    await store.createInvite({
      code: "vencida-vencida-vencida-1",
      orgId: owner.me.org.id,
      role: "viewer",
      createdBy: owner.me.user.id,
      expiresAt: Date.now() - 1000,
      usedAt: null,
    });
    assert.equal((await api("GET", "/api/invites/vencida-vencida-vencida-1")).status, 410);

    // Operador no puede invitar; el equipo lista a ambos.
    assert.equal((await api("POST", "/api/invites", { role: "viewer" }, acc.body.token)).status, 403);
    const team = await api("GET", "/api/team", undefined, acc.body.token);
    assert.deepEqual(team.body.members.map((m: Msg) => m.role).sort(), ["operator", "owner"]);
    assert.deepEqual(team.body.invites, []);

    // Anular una invitación pendiente.
    const inv2 = await api("POST", "/api/invites", { role: "viewer" }, owner.token);
    assert.equal((await api("DELETE", `/api/invites/${inv2.body.code}`, undefined, owner.token)).status, 200);
    assert.equal((await api("GET", `/api/invites/${inv2.body.code}`)).status, 404);
  });

  test("cambio de rol en vivo y sacar a alguien cierra con 4001", async () => {
    const owner = await signup("Roles SAS");
    const pc = await pairPc(owner.token);
    const b = await bridge(pc.agentId, pc.agentSecret);
    const inv = await api("POST", "/api/invites", { role: "operator" }, owner.token);
    const op = await api("POST", `/api/invites/${inv.body.code}/accept`, { name: "Op", email: `rol${Date.now()}@ejemplo.co`, password: "clave-op-123" });
    const uid = op.body.me.user.id;
    const { peer, welcome } = await client(op.body.token);
    assert.equal(welcome.role, "admin");

    // El último dueño no puede dejar de serlo.
    const lone = await api("PATCH", `/api/team/${owner.me.user.id}`, { role: "viewer" }, owner.token);
    assert.equal(lone.status, 409);
    assert.equal((await api("PATCH", `/api/team/${uid}`, { role: "viewer" }, op.body.token)).status, 403);

    assert.equal((await api("PATCH", `/api/team/${uid}`, { role: "viewer" }, owner.token)).status, 200);
    assert.equal((await peer.type("welcome")).role, "viewer");
    peer.send({ type: "command", requestId: "r1", eventId: pc.agentId, command: { action: "clearAll" } });
    const r = await peer.type("result");
    assert.equal(r.ok, false);
    await b.none((m) => m.type === "command");
    assert.equal((await api("GET", "/api/me", undefined, op.body.token)).body.role, "viewer");

    assert.equal((await api("DELETE", `/api/team/${uid}`, undefined, owner.token)).status, 200);
    assert.equal((await peer.closed).code, 4001);
    assert.equal((await api("GET", "/api/me", undefined, op.body.token)).status, 401);
    const relogin = await api("POST", "/api/login", { email: op.body.me.user.email, password: "clave-op-123" });
    assert.equal(relogin.status, 403);
    await b.close();
  });

  // ------------------------------------------------------------ PCs

  test("vincular PC: límite del plan, puente con secreto, secreto malo y desvinculado", async () => {
    const owner = await signup("PCs SAS");
    assert.equal(normalizePairingCode("abc-234"), "ABC234");
    assert.equal(normalizePairingCode("ABO-234"), ""); // O es ambiguo

    const code = await api("POST", "/api/pcs/pairing-code", {}, owner.token);
    assert.match(code.body.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.equal((await api("POST", "/api/agent/pair", { code: "ZZZ-999", pcName: "X" })).status, 404);
    const pair = await api("POST", "/api/agent/pair", { code: code.body.code.replace("-", ""), pcName: "Cabina", agentVersion: "1.0.0" });
    assert.equal(pair.status, 200);
    assert.equal(pair.body.orgName, "PCs SAS");
    assert.equal(pair.body.pcName, "Cabina");
    assert.ok(pair.body.agentSecret.length >= 32);
    // Un solo uso.
    assert.equal((await api("POST", "/api/agent/pair", { code: code.body.code, pcName: "Otro" })).status, 410);

    // Plan de prueba: 1 PC.
    const full = await api("POST", "/api/pcs/pairing-code", {}, owner.token);
    assert.equal(full.status, 403);
    assert.match(full.body.error, /permite 1 PC/);

    const { peer: c } = await client(owner.token);
    const evs = await c.type("events");
    assert.deepEqual(
      evs.events.map((e: Msg) => [e.eventId, e.name, e.online]),
      [[pair.body.agentId, "Cabina", false]],
    );

    await assert.rejects(Peer.connect(`${wsBase}/ws/bridge?agent=${pair.body.agentId}&secret=malo`), /401/);
    const b = await bridge(pair.body.agentId, pair.body.agentSecret);
    b.send({ type: "hello", eventId: pair.body.agentId, name: "Nombre del puente", bridgeVersion: "1.0.5" });
    await c.next((m) => m.type === "events" && m.events[0]?.online === true);
    const pcs = await api("GET", "/api/pcs", undefined, owner.token);
    assert.equal(pcs.body[0].online, true);
    assert.equal(pcs.body[0].name, "Cabina");
    assert.equal(pcs.body[0].version, "1.0.5");
    assert.ok(pcs.body[0].lastSeenAt > 0);

    // Orden del dueño llega al PC.
    c.send({ type: "command", requestId: "w1", eventId: pair.body.agentId, command: { action: "clearAll" } });
    const cmd = await b.type("command");
    b.send({ type: "result", requestId: cmd.requestId, ok: true });
    assert.equal((await c.type("result")).ok, true);

    // Desvincular cierra el puente y ya no puede entrar.
    assert.equal((await api("DELETE", `/api/pcs/${pair.body.agentId}`, undefined, owner.token)).status, 200);
    await b.closed;
    await c.next((m) => m.type === "events" && m.events.length === 0);
    await assert.rejects(Peer.connect(`${wsBase}/ws/bridge?agent=${pair.body.agentId}&secret=${pair.body.agentSecret}`), /401/);
    // Con cupo libre se puede generar otro código.
    assert.equal((await api("POST", "/api/pcs/pairing-code", {}, owner.token)).status, 200);
    await c.close();
  });

  test("aislamiento entre empresas y renombrar PC", async () => {
    const a = await signup("Empresa A");
    const bOrg = await signup("Empresa B");
    const pc = await pairPc(a.token, "PC de A");
    const br = await bridge(pc.agentId, pc.agentSecret);
    br.send({ type: "state", state: sampleState() });

    const { peer: ca } = await client(a.token);
    const { peer: cb } = await client(bOrg.token);
    await ca.next((m) => m.type === "events" && m.events.some((e: Msg) => e.eventId === pc.agentId && e.resolumeOnline));
    const evB = await cb.type("events");
    assert.deepEqual(evB.events, []);

    cb.send({ type: "subscribe", eventId: pc.agentId, snapshots: true });
    assert.deepEqual((await cb.type("logs")).entries, []);
    cb.send({ type: "command", requestId: "b1", eventId: pc.agentId, command: { action: "clearAll" } });
    const r = await cb.type("result");
    assert.equal(r.ok, false);
    assert.match(r.error, /no está conectado/);
    br.send({ type: "log", entry: { at: Date.now(), level: "info", by: "x", text: "secreto" } });
    br.send({ type: "snapshot", mime: "image/jpeg", data: "QUJD", at: 1 });
    await br.none((m) => m.type === "command");
    await cb.none((m) => m.type === "log" || m.type === "snapshot" || m.type === "state");

    // B no puede tocar el PC de A por REST.
    assert.equal((await api("PATCH", `/api/pcs/${pc.agentId}`, { name: "Robado" }, bOrg.token)).status, 404);
    assert.equal((await api("DELETE", `/api/pcs/${pc.agentId}`, undefined, bOrg.token)).status, 404);

    assert.equal((await api("PATCH", `/api/pcs/${pc.agentId}`, { name: "Tarima principal" }, a.token)).status, 200);
    await ca.next((m) => m.type === "events" && m.events.some((e: Msg) => e.name === "Tarima principal"));
    await cb.none((m) => m.type === "events" && m.events.length > 0);
    await Promise.all([ca.close(), cb.close(), br.close()]);
  });

  // ------------------------------------------------------------ Planes y superadministrador

  test("superadmin: listar y cambiar plan; plan vencido deja todo en solo lectura", async () => {
    const boss = await signup("Casa matriz", SUPER);
    assert.equal(boss.me.superadmin, true);
    const owner = await signup("Vence SAS");
    const pc = await pairPc(owner.token);
    const br = await bridge(pc.agentId, pc.agentSecret);
    const { peer: c, welcome } = await client(owner.token);
    assert.equal(welcome.role, "admin");

    assert.equal((await api("GET", "/api/admin/orgs", undefined, owner.token)).status, 403);
    const list = await api("GET", "/api/admin/orgs", undefined, boss.token);
    assert.equal(list.status, 200);
    const row = list.body.find((o: Msg) => o.id === owner.me.org.id);
    assert.equal(row.plan, "prueba");
    assert.equal(row.pcs, 1);
    assert.equal(row.pcsOnline, 1);
    assert.equal(row.members, 1);
    assert.equal(row.owners[0].email, owner.email);

    assert.equal((await api("PATCH", `/api/admin/orgs/${owner.me.org.id}`, { plan: "oro" }, boss.token)).status, 400);
    const exp = await api("PATCH", `/api/admin/orgs/${owner.me.org.id}`, { planExpiresAt: Date.now() - 1000 }, boss.token);
    assert.equal(exp.status, 200);
    assert.equal((await c.type("welcome")).role, "viewer");

    c.send({ type: "command", requestId: "e1", eventId: pc.agentId, command: { action: "triggerClip", clipId: 1 } });
    const denied = await c.type("result");
    assert.equal(denied.ok, false);
    assert.match(denied.error, /venció/);
    // Las miniaturas siguen permitidas.
    c.send({ type: "command", requestId: "e2", eventId: pc.agentId, command: { action: "getThumbnail", clipId: 1 } });
    const cmd = await br.type("command");
    assert.equal(cmd.command.action, "getThumbnail");

    const me = await api("GET", "/api/me", undefined, owner.token);
    assert.equal(me.body.plan.active, false);
    assert.equal(me.body.plan.daysLeft, 0);
    assert.equal((await api("POST", "/api/pcs/pairing-code", {}, owner.token)).status, 403);

    // Un cliente nuevo entra directo como observador.
    const { peer: c2, welcome: w2 } = await client(owner.token);
    assert.equal(w2.role, "viewer");

    // Renovar: plan Productora sin vencimiento.
    const renew = await api("PATCH", `/api/admin/orgs/${owner.me.org.id}`, { plan: "productora", planExpiresAt: null }, boss.token);
    assert.equal(renew.body.plan, "productora");
    assert.equal((await c.type("welcome")).role, "admin");
    const me2 = await api("GET", "/api/me", undefined, owner.token);
    assert.deepEqual([me2.body.plan.id, me2.body.plan.maxPcs, me2.body.plan.active, me2.body.plan.expiresAt], ["productora", 5, true, null]);
    assert.equal((await api("POST", "/api/pcs/pairing-code", {}, owner.token)).status, 200);
    await Promise.all([c.close(), c2.close(), br.close()]);
  });

  // ------------------------------------------------------------ Estáticos

  test("rutas estáticas en modo cuentas: / portada, /app la aplicación", async () => {
    const root = await fetch(`${base}/`);
    assert.match(await root.text(), /Portada/);
    assert.match(root.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    for (const p of ["/app", "/app/", "/app/equipo"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /App/, p);
    }
    const js = await fetch(`${base}/app.js`);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    await js.arrayBuffer();
    assert.equal((await api("GET", "/api/no-existe")).status, 404);
  });
});

describe("modo códigos: rutas nuevas", () => {
  test("/api/config dice codes; / y /app sirven la app; sin endpoints de cuentas", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "panel-codigos-"));
    await writeFile(path.join(tmp, "index.html"), "<!doctype html><title>App</title>");
    await writeFile(path.join(tmp, "landing.html"), "<!doctype html><title>Portada</title>");
    const s = await startServer({ port: 0, host: "127.0.0.1", adminCode: "a-123", bridgeToken: "b".repeat(20), staticDir: tmp, log: () => {} });
    try {
      const b = `http://127.0.0.1:${s.port}`;
      const c = (await (await fetch(`${b}/api/config`)).json()) as Msg;
      assert.deepEqual(c, { mode: "codes", brand: "VisualMaping", contactWhatsapp: "", agent: null });
      assert.match(await (await fetch(`${b}/`)).text(), /App/);
      assert.match(await (await fetch(`${b}/app`)).text(), /App/);
      const su = await fetch(`${b}/api/signup`, { method: "POST", body: "{}" });
      assert.equal(su.status, 404);
      await su.arrayBuffer();
      const plans = await fetch(`${b}/api/plans`);
      assert.equal(plans.status, 200);
      await plans.arrayBuffer();
    } finally {
      await s.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("sin ADMIN_CODE ni modo cuentas no arranca", async () => {
    await assert.rejects(startServer({ port: 0, host: "127.0.0.1", log: () => {} }), /ADMIN_CODE/);
  });
});
