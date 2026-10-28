// API REST del modo cuentas: registro, ingreso, equipo, invitaciones, PCs y superadministrador.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Role } from "../shared/protocol.js";
import {
  ACCOUNT_TOKEN_TTL_MS,
  LoginLimiter,
  cleanName,
  createAccountToken,
  hashPassword,
  safeEqual,
  sha256Hex,
  verifyAccountToken,
  verifyPassword,
} from "./auth.js";
import { clientIp, publicUrlFor, readBody, sendJson } from "./http.js";
import { cleanEventName, type ClientSession, type Hub, type LogFn } from "./hub.js";
import { DAY_MS, TRIAL_DAYS, getPlan, isPlanActive, isPlanId, planStatus } from "./plans.js";
import {
  EmailTakenError,
  type AgentRow,
  type MemberRole,
  type MembershipRow,
  type OrgRow,
  type Store,
  type UserRow,
} from "./store/store.js";
import { isEventId } from "./validate.js";

export interface AccountsOptions {
  store: Store;
  hub: Hub;
  sessionSecret: string;
  trustProxy: number;
  superadminEmails: string[];
  publicUrl?: string;
  log: LogFn;
}

const MAX_BODY = 8 * 1024;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;
const ORG_NAME_MAX = 60;
const PC_NAME_MAX = 60;
const INVITE_TTL_MS = 7 * DAY_MS;
const PAIRING_TTL_MS = 15 * 60 * 1000;
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const VERSION_RE = /^[0-9A-Za-z.+_-]{0,40}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Body = Record<string, unknown>;

interface Ctx {
  user: UserRow;
  member: MembershipRow;
  org: OrgRow;
}

// ---------------------------------------------------------------- Validación

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function parseEmail(raw: unknown): string {
  const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!e || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) throw new HttpError(400, "Escribe un correo válido");
  return e;
}

function parseNewPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < PASSWORD_MIN) {
    throw new HttpError(400, `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres`);
  }
  if (raw.length > PASSWORD_MAX) throw new HttpError(400, "La contraseña es demasiado larga");
  return raw;
}

const givenPassword = (raw: unknown): string => (typeof raw === "string" && raw.length <= PASSWORD_MAX ? raw : "");

function parseName(raw: unknown): string {
  const n = cleanName(raw);
  if (!n) throw new HttpError(400, "Escribe tu nombre");
  return n;
}

function parseRole(raw: unknown, allowOwner: boolean): MemberRole {
  if (raw === "operator" || raw === "viewer" || (allowOwner && raw === "owner")) return raw;
  throw new HttpError(400, allowOwner ? "Rol inválido" : 'El rol debe ser "operator" o "viewer"');
}

/** "abc-123" / "ABC123" → "ABC123", o "" si no tiene la forma. */
export function normalizePairingCode(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 20) return "";
  const c = raw.replace(/[\s-]/g, "").toUpperCase();
  if (c.length !== 6) return "";
  for (const ch of c) if (!PAIRING_ALPHABET.includes(ch)) return "";
  return c;
}

const prettyPairing = (c: string) => `${c.slice(0, 3)}-${c.slice(3)}`;

/** Fecha de entrada: ms, texto ISO o null. */
function parseDate(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string" && raw.length <= 40) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  throw new HttpError(400, "Fecha inválida");
}

/** Rol del modo cuentas → rol del protocolo. */
export function protocolRole(role: MemberRole): Role {
  return role === "viewer" ? "viewer" : "admin";
}

// ---------------------------------------------------------------- API

export function createAccounts(opts: AccountsOptions) {
  const { store, hub, sessionSecret, trustProxy, log } = opts;
  const superadmins = new Set(opts.superadminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const loginLimiter = new LoginLimiter(10, 10 * 60 * 1000);
  /** Cuenta todos los registros (no solo los fallidos). */
  const signupLimiter = new LoginLimiter(10, 60 * 60 * 1000);
  const inviteLimiter = new LoginLimiter(10, 10 * 60 * 1000);
  const pairLimiter = new LoginLimiter(10, 10 * 60 * 1000);

  const isSuperadmin = (u: UserRow) => superadmins.has(u.email.toLowerCase());

  function limited(limiter: LoginLimiter, ip: string): void {
    const wait = limiter.blockedFor(ip);
    if (wait > 0) {
      throw new HttpError(429, "Demasiados intentos. Prueba de nuevo en unos minutos.", {
        "Retry-After": String(Math.ceil(wait / 1000)),
      });
    }
  }

  async function readJson(req: IncomingMessage): Promise<Body> {
    const text = await readBody(req, MAX_BODY);
    if (text === null) throw new HttpError(413, "Solicitud demasiado grande");
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new HttpError(400, "JSON inválido");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON inválido");
    return body as Body;
  }

  function me(ctx: Ctx) {
    return {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      org: { id: ctx.org.id, name: ctx.org.name },
      role: ctx.member.role,
      plan: planStatus(ctx.org),
      superadmin: isSuperadmin(ctx.user),
    };
  }

  function issue(ctx: Ctx) {
    const token = createAccountToken(
      {
        uid: ctx.user.id,
        oid: ctx.org.id,
        role: ctx.member.role,
        tv: ctx.user.tokenVersion,
        name: ctx.user.name,
        exp: Date.now() + ACCOUNT_TOKEN_TTL_MS,
      },
      sessionSecret,
    );
    return { token, me: me(ctx) };
  }

  /** Carga usuario, membresía y empresa; null si el token no vale (firma, vencimiento, token_version, membresía). */
  async function loadSession(token: string | null): Promise<(Ctx & { exp: number }) | null> {
    const s = token ? verifyAccountToken(token, sessionSecret) : null;
    if (!s) return null;
    const user = await store.getUser(s.uid);
    if (!user || user.tokenVersion !== s.tv) return null;
    const member = await store.getMembership(user.id);
    if (!member || member.orgId !== s.oid) return null;
    const org = await store.getOrg(member.orgId);
    if (!org) return null;
    return { user, member, org, exp: s.exp };
  }

  async function requireSession(req: IncomingMessage, roles?: MemberRole[]): Promise<Ctx> {
    const h = req.headers.authorization;
    const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    const ctx = await loadSession(m ? m[1]! : null);
    if (!ctx) throw new HttpError(401, "Tu sesión venció. Ingresa de nuevo.");
    if (roles && !roles.includes(ctx.member.role)) throw new HttpError(403, "No tienes permiso para esto");
    return ctx;
  }

  async function ctxFor(userId: string): Promise<Ctx> {
    const user = await store.getUser(userId);
    const member = user && (await store.getMembership(user.id));
    const org = member && (await store.getOrg(member.orgId));
    if (!user || !member || !org) throw new HttpError(500, "Error interno");
    return { user, member, org };
  }

  // ------------------------------------------------------------ Públicas

  async function signup(req: IncomingMessage) {
    const ip = clientIp(req, trustProxy);
    limited(signupLimiter, ip);
    signupLimiter.fail(ip);
    const b = await readJson(req);
    const orgName = cleanText(b.orgName, ORG_NAME_MAX);
    if (!orgName) throw new HttpError(400, "Escribe el nombre de tu empresa");
    const name = parseName(b.name);
    const email = parseEmail(b.email);
    const password = parseNewPassword(b.password);
    const now = Date.now();
    const org: OrgRow = { id: randomUUID(), name: orgName, plan: "prueba", planExpiresAt: now + TRIAL_DAYS * DAY_MS, createdAt: now };
    const user: UserRow = { id: randomUUID(), email, name, passwordHash: await hashPassword(password), tokenVersion: 0, createdAt: now };
    try {
      await store.createOrgWithOwner(org, user);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new HttpError(409, "Ese correo ya está registrado. Ingresa con tu contraseña.");
      throw e;
    }
    log("info", `Empresa nueva: "${orgName}" (${email})`);
    return issue({ user, member: { orgId: org.id, userId: user.id, role: "owner", createdAt: now }, org });
  }

  async function login(req: IncomingMessage) {
    const ip = clientIp(req, trustProxy);
    limited(loginLimiter, ip);
    const b = await readJson(req);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase().slice(0, EMAIL_MAX) : "";
    const user = email ? await store.getUserByEmail(email) : null;
    const ok = await verifyPassword(givenPassword(b.password), user?.passwordHash ?? null);
    if (!user || !ok) {
      loginLimiter.fail(ip);
      throw new HttpError(401, "Correo o contraseña incorrectos");
    }
    const member = await store.getMembership(user.id);
    const org = member && (await store.getOrg(member.orgId));
    if (!member || !org) throw new HttpError(403, "No perteneces a ninguna empresa. Pide una invitación nueva.");
    log("info", `Ingreso: ${user.email}`);
    return issue({ user, member, org });
  }

  async function pendingInvite(code: string, ip: string) {
    const inv = INVITE_CODE_RE.test(code) ? await store.getInvite(code) : null;
    if (!inv) {
      inviteLimiter.fail(ip);
      throw new HttpError(404, "Invitación no encontrada");
    }
    if (inv.usedAt !== null || inv.expiresAt <= Date.now()) {
      throw new HttpError(410, "Esta invitación ya se usó o venció. Pide una nueva.");
    }
    const org = await store.getOrg(inv.orgId);
    if (!org) throw new HttpError(404, "Invitación no encontrada");
    return { inv, org };
  }

  async function invitePreview(req: IncomingMessage, code: string) {
    const ip = clientIp(req, trustProxy);
    limited(inviteLimiter, ip);
    const { inv, org } = await pendingInvite(code, ip);
    return { orgName: org.name, role: inv.role, expiresAt: inv.expiresAt };
  }

  async function inviteAccept(req: IncomingMessage, code: string) {
    const ip = clientIp(req, trustProxy);
    limited(inviteLimiter, ip);
    const b = await readJson(req);
    const { inv, org } = await pendingInvite(code, ip);
    const email = parseEmail(b.email);
    const existing = await store.getUserByEmail(email);
    const now = Date.now();

    if (existing) {
      if (!(await verifyPassword(givenPassword(b.password), existing.passwordHash))) {
        inviteLimiter.fail(ip);
        throw new HttpError(401, "Ese correo ya tiene cuenta y la contraseña no coincide");
      }
      const current = await store.getMembership(existing.id);
      if (current) {
        throw new HttpError(
          409,
          current.orgId === org.id ? "Ya perteneces a esta empresa" : "Ese correo ya pertenece a otra empresa",
        );
      }
      if (!(await store.useInvite(code, now))) throw new HttpError(410, "Esta invitación ya se usó o venció. Pide una nueva.");
      if (!(await store.addMembership(org.id, existing.id, inv.role, now))) throw new HttpError(409, "Ese correo ya pertenece a otra empresa");
      log("info", `${email} se unió a "${org.name}" como ${inv.role}`);
      return issue(await ctxFor(existing.id));
    }

    const name = parseName(b.name);
    const password = parseNewPassword(b.password);
    const user: UserRow = { id: randomUUID(), email, name, passwordHash: await hashPassword(password), tokenVersion: 0, createdAt: now };
    if (!(await store.useInvite(code, now))) throw new HttpError(410, "Esta invitación ya se usó o venció. Pide una nueva.");
    try {
      await store.createUserInOrg(user, org.id, inv.role, now);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new HttpError(409, "Ese correo ya está registrado");
      throw e;
    }
    log("info", `${email} se unió a "${org.name}" como ${inv.role}`);
    return issue({ user, member: { orgId: org.id, userId: user.id, role: inv.role, createdAt: now }, org });
  }

  async function agentPair(req: IncomingMessage) {
    const ip = clientIp(req, trustProxy);
    limited(pairLimiter, ip);
    const b = await readJson(req);
    const code = normalizePairingCode(b.code);
    const row = code ? await store.getPairingCode(code) : null;
    if (!row) {
      pairLimiter.fail(ip);
      throw new HttpError(404, "Código de vinculación incorrecto");
    }
    const now = Date.now();
    if (row.usedAt !== null || row.expiresAt <= now) throw new HttpError(410, "Ese código ya se usó o venció. Genera uno nuevo en el panel.");
    const pcName = cleanEventName(b.pcName, "").slice(0, PC_NAME_MAX).trim();
    if (!pcName) throw new HttpError(400, "Escribe el nombre del PC");
    const version = typeof b.agentVersion === "string" && VERSION_RE.test(b.agentVersion) ? b.agentVersion : "";

    const org = await store.getOrg(row.orgId);
    if (!org) throw new HttpError(404, "Código de vinculación incorrecto");
    if (!isPlanActive(org.planExpiresAt, now)) throw new HttpError(403, "El plan de la empresa venció: no se pueden vincular PCs nuevos.");
    if (!(await store.usePairingCode(code, now))) throw new HttpError(410, "Ese código ya se usó o venció. Genera uno nuevo en el panel.");

    const plan = getPlan(org.plan);
    const secret = randomBytes(32).toString("base64url");
    const agent: AgentRow = {
      id: randomUUID(),
      orgId: org.id,
      name: pcName,
      secretHash: sha256Hex(secret),
      version,
      lastSeenAt: null,
      createdAt: now,
      revokedAt: null,
    };
    if (!(await store.createAgentIfRoom(agent, plan.maxPcs))) {
      throw new HttpError(403, `El plan ${plan.name} permite ${plan.maxPcs} PC${plan.maxPcs === 1 ? "" : "s"}. Desvincula uno o mejora el plan.`);
    }
    hub.upsertEvent(org.id, agent.id, agent.name);
    log("info", `PC vinculado: "${pcName}" en "${org.name}"`);
    return { agentId: agent.id, agentSecret: secret, orgName: org.name, pcName };
  }

  // ------------------------------------------------------------ Con sesión

  async function patchMe(req: IncomingMessage) {
    const ctx = await requireSession(req);
    const b = await readJson(req);
    const patch: { name?: string; passwordHash?: string; bumpTokenVersion?: boolean } = {};
    if (b.name !== undefined) patch.name = parseName(b.name);
    if (b.password !== undefined) {
      const password = parseNewPassword(b.password);
      if (!(await verifyPassword(givenPassword(b.currentPassword), ctx.user.passwordHash))) {
        throw new HttpError(403, "La contraseña actual no es correcta");
      }
      patch.passwordHash = await hashPassword(password);
      patch.bumpTokenVersion = true;
    }
    const user = await store.updateUser(ctx.user.id, patch);
    if (!user) throw new HttpError(401, "Tu sesión venció. Ingresa de nuevo.");
    // Cambiar la contraseña cierra las demás sesiones; esta recibe un token nuevo.
    if (patch.bumpTokenVersion) hub.closeUserClients(user.id, "Contraseña cambiada");
    return issue({ ...ctx, user });
  }

  async function patchOrg(req: IncomingMessage) {
    const ctx = await requireSession(req, ["owner"]);
    const b = await readJson(req);
    const name = cleanText(b.name, ORG_NAME_MAX);
    if (!name) throw new HttpError(400, "Escribe el nombre de la empresa");
    const org = await store.updateOrg(ctx.org.id, { name });
    return { org: { id: ctx.org.id, name: org?.name ?? name } };
  }

  async function team(req: IncomingMessage) {
    const ctx = await requireSession(req);
    const members = (await store.listMembers(ctx.org.id)).map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      createdAt: m.createdAt,
    }));
    let invites: { code: string; role: MemberRole; expiresAt: number; url: string }[] = [];
    if (ctx.member.role === "owner") {
      const base = publicUrlFor(req, opts.publicUrl, trustProxy);
      invites = (await store.listInvites(ctx.org.id, Date.now())).map((i) => ({
        code: i.code,
        role: i.role,
        expiresAt: i.expiresAt,
        url: `${base}/app/#invitacion-${i.code}`,
      }));
    }
    return { members, invites };
  }

  async function createInvite(req: IncomingMessage) {
    const ctx = await requireSession(req, ["owner"]);
    const b = await readJson(req);
    const role = parseRole(b.role, false);
    const code = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + INVITE_TTL_MS;
    await store.createInvite({ code, orgId: ctx.org.id, role, createdBy: ctx.user.id, expiresAt, usedAt: null });
    return { code, url: `${publicUrlFor(req, opts.publicUrl, trustProxy)}/app/#invitacion-${code}`, expiresAt };
  }

  async function deleteInvite(req: IncomingMessage, code: string) {
    const ctx = await requireSession(req, ["owner"]);
    if (!INVITE_CODE_RE.test(code) || !(await store.deleteInvite(ctx.org.id, code))) {
      throw new HttpError(404, "Invitación no encontrada");
    }
    return { ok: true };
  }

  async function ownersLeft(orgId: string, without: string): Promise<number> {
    return (await store.listMembers(orgId)).filter((m) => m.role === "owner" && m.userId !== without).length;
  }

  async function patchMember(req: IncomingMessage, userId: string) {
    const ctx = await requireSession(req, ["owner"]);
    const b = await readJson(req);
    const role = parseRole(b.role, true);
    const target = isEventId(userId) ? await store.getMembership(userId) : null;
    if (!target || target.orgId !== ctx.org.id) throw new HttpError(404, "Esa persona no está en tu equipo");
    if (target.role === "owner" && role !== "owner" && (await ownersLeft(ctx.org.id, userId)) === 0) {
      throw new HttpError(409, "Debe quedar al menos un dueño en la empresa");
    }
    await store.setMemberRole(ctx.org.id, userId, role);
    hub.updateUserRole(userId, protocolRole(role));
    return { ok: true, userId, role };
  }

  async function removeMember(req: IncomingMessage, userId: string) {
    const ctx = await requireSession(req, ["owner"]);
    const target = isEventId(userId) ? await store.getMembership(userId) : null;
    if (!target || target.orgId !== ctx.org.id) throw new HttpError(404, "Esa persona no está en tu equipo");
    if (target.role === "owner" && (await ownersLeft(ctx.org.id, userId)) === 0) {
      throw new HttpError(409, "Debe quedar al menos un dueño en la empresa");
    }
    await store.removeMember(ctx.org.id, userId);
    hub.closeUserClients(userId, "Ya no perteneces a esta empresa");
    log("info", `Usuario ${userId} salió de "${ctx.org.name}"`);
    return { ok: true };
  }

  async function pcs(req: IncomingMessage) {
    const ctx = await requireSession(req);
    return (await store.listAgents(ctx.org.id)).map((a) => ({
      id: a.id,
      name: a.name,
      ...hub.liveInfo(a.id),
      version: a.version,
      lastSeenAt: a.lastSeenAt,
      createdAt: a.createdAt,
    }));
  }

  async function pairingCode(req: IncomingMessage) {
    const ctx = await requireSession(req, ["owner", "operator"]);
    const now = Date.now();
    if (!isPlanActive(ctx.org.planExpiresAt, now)) {
      throw new HttpError(403, "Tu plan venció: renuévalo para vincular PCs nuevos.");
    }
    const plan = getPlan(ctx.org.plan);
    const count = await store.countAgents(ctx.org.id);
    if (count >= plan.maxPcs) {
      throw new HttpError(
        403,
        `Tu plan ${plan.name} permite ${plan.maxPcs} PC${plan.maxPcs === 1 ? "" : "s"} y ya tienes ${count}. Desvincula uno o mejora el plan.`,
      );
    }
    const expiresAt = now + PAIRING_TTL_MS;
    for (let i = 0; i < 5; i++) {
      let code = "";
      for (let j = 0; j < 6; j++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
      if (await store.createPairingCode({ code, orgId: ctx.org.id, createdBy: ctx.user.id, expiresAt, usedAt: null })) {
        return { code: prettyPairing(code), expiresAt };
      }
    }
    throw new HttpError(500, "No se pudo generar el código, intenta de nuevo");
  }

  async function ownAgent(ctx: Ctx, id: string): Promise<AgentRow> {
    const a = isEventId(id) ? await store.getAgent(id) : null;
    if (!a || a.orgId !== ctx.org.id || a.revokedAt !== null) throw new HttpError(404, "PC no encontrado");
    return a;
  }

  async function patchPc(req: IncomingMessage, id: string) {
    const ctx = await requireSession(req, ["owner", "operator"]);
    const b = await readJson(req);
    await ownAgent(ctx, id);
    const name = cleanEventName(b.name, "").slice(0, PC_NAME_MAX).trim();
    if (!name) throw new HttpError(400, "Escribe el nombre del PC");
    await store.updateAgent(id, { name });
    hub.renameEvent(id, name);
    return { id, name };
  }

  async function deletePc(req: IncomingMessage, id: string) {
    const ctx = await requireSession(req, ["owner"]);
    const a = await ownAgent(ctx, id);
    await store.updateAgent(id, { revokedAt: Date.now() });
    hub.removeEvent(id);
    log("info", `PC desvinculado: "${a.name}" de "${ctx.org.name}"`);
    return { ok: true };
  }

  // ------------------------------------------------------------ Superadministrador

  async function requireSuperadmin(req: IncomingMessage): Promise<Ctx> {
    const ctx = await requireSession(req);
    if (!isSuperadmin(ctx.user)) throw new HttpError(403, "No tienes permiso para esto");
    return ctx;
  }

  async function adminOrgs(req: IncomingMessage) {
    await requireSuperadmin(req);
    return (await store.adminListOrgs()).map((o) => ({
      id: o.org.id,
      name: o.org.name,
      plan: o.org.plan,
      planExpiresAt: o.org.planExpiresAt,
      owners: o.owners,
      members: o.members,
      pcs: o.agentIds.length,
      pcsOnline: o.agentIds.filter((id) => hub.liveInfo(id).online).length,
      createdAt: o.org.createdAt,
    }));
  }

  async function adminPatchOrg(req: IncomingMessage, id: string) {
    const ctx = await requireSuperadmin(req);
    const b = await readJson(req);
    const patch: { plan?: string; planExpiresAt?: number | null } = {};
    if (b.plan !== undefined) {
      if (!isPlanId(b.plan)) throw new HttpError(400, "Plan inválido");
      patch.plan = b.plan;
    }
    if (b.planExpiresAt !== undefined) patch.planExpiresAt = parseDate(b.planExpiresAt);
    const org = isEventId(id) ? await store.updateOrg(id, patch) : null;
    if (!org) throw new HttpError(404, "Empresa no encontrada");
    hub.updateOrgPlan(org.id, org.planExpiresAt);
    log("info", `Superadmin ${ctx.user.email}: "${org.name}" → plan ${org.plan}, vence ${org.planExpiresAt ? new Date(org.planExpiresAt).toISOString() : "nunca"}`);
    return { id: org.id, name: org.name, plan: org.plan, planExpiresAt: org.planExpiresAt, createdAt: org.createdAt };
  }

  // ------------------------------------------------------------ Enrutado

  type Handler = () => Promise<unknown>;

  function route(req: IncomingMessage, pathname: string): Record<string, Handler> | null {
    const seg = pathname.split("/").slice(2); // ["", "api", ...]
    const p = seg.map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return "\0";
      }
    });
    const path = seg.join("/");
    switch (path) {
      case "signup":
        return { POST: () => signup(req) };
      case "login":
        return { POST: () => login(req) };
      case "agent/pair":
        return { POST: () => agentPair(req) };
      case "me":
        return { GET: async () => me(await requireSession(req)), PATCH: () => patchMe(req) };
      case "org":
        return { PATCH: () => patchOrg(req) };
      case "team":
        return { GET: () => team(req) };
      case "invites":
        return { POST: () => createInvite(req) };
      case "pcs":
        return { GET: () => pcs(req) };
      case "pcs/pairing-code":
        return { POST: () => pairingCode(req) };
      case "admin/orgs":
        return { GET: () => adminOrgs(req) };
    }
    if (p.length === 2 && p[0] === "invites") return { GET: () => invitePreview(req, p[1]!), DELETE: () => deleteInvite(req, p[1]!) };
    if (p.length === 3 && p[0] === "invites" && p[2] === "accept") return { POST: () => inviteAccept(req, p[1]!) };
    if (p.length === 2 && p[0] === "team") return { PATCH: () => patchMember(req, p[1]!), DELETE: () => removeMember(req, p[1]!) };
    if (p.length === 2 && p[0] === "pcs") return { PATCH: () => patchPc(req, p[1]!), DELETE: () => deletePc(req, p[1]!) };
    if (p.length === 3 && p[0] === "admin" && p[1] === "orgs") return { PATCH: () => adminPatchOrg(req, p[2]!) };
    return null;
  }

  return {
    /** Atiende /api/… del modo cuentas. false si la ruta no es suya. */
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
      const methods = route(req, pathname);
      if (!methods) return false;
      const fn = methods[req.method ?? ""];
      if (!fn) {
        sendJson(res, 405, { error: "Método no permitido" }, { Allow: Object.keys(methods).join(", ") });
        return true;
      }
      try {
        sendJson(res, 200, await fn());
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        sendJson(res, e.status, { error: e.message }, e.headers);
      }
      return true;
    },

    /** Sesión para /ws/client, o null. */
    async clientSession(token: string | null): Promise<ClientSession | null> {
      const ctx = await loadSession(token);
      if (!ctx) return null;
      hub.syncOrg(ctx.org.id, await store.listAgents(ctx.org.id));
      return {
        name: ctx.user.name,
        role: protocolRole(ctx.member.role),
        exp: ctx.exp,
        orgId: ctx.org.id,
        userId: ctx.user.id,
        planExpiresAt: ctx.org.planExpiresAt,
      };
    },

    /** Agente para /ws/bridge, o null si no existe, está desvinculado o el secreto no coincide. */
    async bridgeAgent(agentId: string, secret: string, version: string): Promise<AgentRow | null> {
      if (!isEventId(agentId) || !secret || secret.length > 256) return null;
      const a = await store.getAgent(agentId);
      // Se compara siempre (aunque no exista) para no filtrar nada por el tiempo.
      const match = safeEqual(sha256Hex(secret), a?.secretHash ?? "x".repeat(64));
      if (!a || !match || a.revokedAt !== null) return null;
      const patch: { lastSeenAt: number; version?: string } = { lastSeenAt: Date.now() };
      if (version && VERSION_RE.test(version)) patch.version = version;
      await store.updateAgent(a.id, patch);
      return a;
    },

    onHello(agentId: string, version: string): void {
      if (!VERSION_RE.test(version) || !version) return;
      store.updateAgent(agentId, { version, lastSeenAt: Date.now() }).catch((e: Error) => log("warn", `No se guardó la versión del PC: ${e.message}`));
    },

    onBridgeClose(agentId: string): void {
      store.updateAgent(agentId, { lastSeenAt: Date.now() }).catch((e: Error) => log("warn", `No se guardó la última conexión del PC: ${e.message}`));
    },

    prune(): void {
      for (const l of [loginLimiter, signupLimiter, inviteLimiter, pairLimiter]) l.prune();
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
