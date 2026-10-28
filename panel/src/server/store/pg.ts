// Store en Postgres (Neon, Render, Supabase…). Solo consultas parametrizadas.
import pg from "pg";
import {
  EmailTakenError,
  type AdminOrgInfo,
  type AgentRow,
  type InviteRow,
  type MemberInfo,
  type MemberRole,
  type MembershipRow,
  type OrgRow,
  type PairingCodeRow,
  type Store,
  type UserRow,
} from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  plan_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id)
);
CREATE INDEX IF NOT EXISTS memberships_org ON memberships (org_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invites_org ON invites (org_id);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agents_org ON agents (org_id);
`;

type Row = Record<string, any>;
const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string | Date).getTime());
const d = (v: number | null | undefined): Date | null => (v == null ? null : new Date(v));

const toOrg = (r: Row): OrgRow => ({
  id: r.id,
  name: r.name,
  plan: r.plan,
  planExpiresAt: ms(r.plan_expires_at),
  createdAt: ms(r.created_at)!,
});
const toUser = (r: Row): UserRow => ({
  id: r.id,
  email: r.email,
  name: r.name,
  passwordHash: r.password_hash,
  tokenVersion: Number(r.token_version),
  createdAt: ms(r.created_at)!,
});
const toMember = (r: Row): MembershipRow => ({
  orgId: r.org_id,
  userId: r.user_id,
  role: r.role,
  createdAt: ms(r.created_at)!,
});
const toInvite = (r: Row): InviteRow => ({
  code: r.code,
  orgId: r.org_id,
  role: r.role,
  createdBy: r.created_by,
  expiresAt: ms(r.expires_at)!,
  usedAt: ms(r.used_at),
});
const toPairing = (r: Row): PairingCodeRow => ({
  code: r.code,
  orgId: r.org_id,
  createdBy: r.created_by,
  expiresAt: ms(r.expires_at)!,
  usedAt: ms(r.used_at),
});
const toAgent = (r: Row): AgentRow => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  secretHash: r.secret_hash,
  version: r.version ?? "",
  lastSeenAt: ms(r.last_seen_at),
  createdAt: ms(r.created_at)!,
  revokedAt: ms(r.revoked_at),
});

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

export function pgSslOption(url: string): pg.PoolConfig["ssl"] {
  try {
    const mode = new URL(url).searchParams.get("sslmode");
    if (mode === "require" || mode === "verify-ca" || mode === "verify-full" || mode === "prefer") {
      return { rejectUnauthorized: mode !== "require" && mode !== "prefer" };
    }
  } catch {
    /* URL rara: sin SSL explícito */
  }
  return undefined;
}

export class PgStore implements Store {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    // sslmode se maneja aquí: se quita de la URL para que pg no lo reinterprete.
    let conn = url;
    try {
      const u = new URL(url);
      u.searchParams.delete("sslmode");
      conn = u.toString();
    } catch {
      /* se usa tal cual */
    }
    this.pool = new pg.Pool({ connectionString: conn, ssl: pgSslOption(url), max: 10, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (err) => console.error(`Error de la base de datos: ${err.message}`));
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private async one<T>(sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> {
    const r = await this.pool.query(sql, params);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  private async insertUser(c: pg.PoolClient, u: UserRow): Promise<void> {
    try {
      await c.query(
        "INSERT INTO users (id, email, name, password_hash, token_version, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [u.id, u.email.toLowerCase(), u.name, u.passwordHash, u.tokenVersion, d(u.createdAt)],
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new EmailTakenError();
      throw e;
    }
  }

  async createOrgWithOwner(org: OrgRow, user: UserRow): Promise<void> {
    await this.tx(async (c) => {
      await c.query("INSERT INTO orgs (id, name, plan, plan_expires_at, created_at) VALUES ($1,$2,$3,$4,$5)", [
        org.id,
        org.name,
        org.plan,
        d(org.planExpiresAt),
        d(org.createdAt),
      ]);
      await this.insertUser(c, user);
      await c.query("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)", [
        org.id,
        user.id,
        d(org.createdAt),
      ]);
    });
  }

  async createUserInOrg(user: UserRow, orgId: string, role: MemberRole, now: number): Promise<void> {
    await this.tx(async (c) => {
      await this.insertUser(c, user);
      await c.query("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)", [orgId, user.id, role, d(now)]);
    });
  }

  getOrg(id: string) {
    return this.one("SELECT * FROM orgs WHERE id = $1", [id], toOrg);
  }

  updateOrg(id: string, patch: { name?: string; plan?: string; planExpiresAt?: number | null }) {
    return this.one(
      `UPDATE orgs SET
         name = COALESCE($2, name),
         plan = COALESCE($3, plan),
         plan_expires_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE plan_expires_at END
       WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.plan ?? null, patch.planExpiresAt !== undefined, d(patch.planExpiresAt)],
      toOrg,
    );
  }

  getUser(id: string) {
    return this.one("SELECT * FROM users WHERE id = $1", [id], toUser);
  }

  getUserByEmail(email: string) {
    return this.one("SELECT * FROM users WHERE lower(email) = lower($1)", [email], toUser);
  }

  updateUser(id: string, patch: { name?: string; passwordHash?: string; bumpTokenVersion?: boolean }) {
    return this.one(
      `UPDATE users SET
         name = COALESCE($2, name),
         password_hash = COALESCE($3, password_hash),
         token_version = token_version + $4
       WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.passwordHash ?? null, patch.bumpTokenVersion ? 1 : 0],
      toUser,
    );
  }

  getMembership(userId: string) {
    return this.one("SELECT * FROM memberships WHERE user_id = $1", [userId], toMember);
  }

  async addMembership(orgId: string, userId: string, role: MemberRole, now: number): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING",
      [orgId, userId, role, d(now)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async listMembers(orgId: string): Promise<MemberInfo[]> {
    const r = await this.pool.query(
      `SELECT m.*, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [orgId],
    );
    return r.rows.map((row: Row) => ({ ...toMember(row), name: row.name, email: row.email }));
  }

  async setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<boolean> {
    const r = await this.pool.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [orgId, userId, role]);
    return (r.rowCount ?? 0) > 0;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
      if ((r.rowCount ?? 0) === 0) return false;
      await c.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [userId]);
      return true;
    });
  }

  async createInvite(i: InviteRow): Promise<void> {
    await this.pool.query(
      "INSERT INTO invites (code, org_id, role, created_by, expires_at, used_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [i.code, i.orgId, i.role, i.createdBy, d(i.expiresAt), d(i.usedAt)],
    );
  }

  getInvite(code: string) {
    return this.one("SELECT * FROM invites WHERE code = $1", [code], toInvite);
  }

  async listInvites(orgId: string, now: number): Promise<InviteRow[]> {
    const r = await this.pool.query(
      "SELECT * FROM invites WHERE org_id = $1 AND used_at IS NULL AND expires_at > $2 ORDER BY expires_at",
      [orgId, d(now)],
    );
    return r.rows.map(toInvite);
  }

  async deleteInvite(orgId: string, code: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM invites WHERE org_id = $1 AND code = $2 AND used_at IS NULL", [orgId, code]);
    return (r.rowCount ?? 0) > 0;
  }

  async useInvite(code: string, now: number): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE invites SET used_at = $2 WHERE code = $1 AND used_at IS NULL AND expires_at > $2",
      [code, d(now)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async createPairingCode(p: PairingCodeRow): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO pairing_codes (code, org_id, created_by, expires_at, used_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.orgId, p.createdBy, d(p.expiresAt), d(p.usedAt)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  getPairingCode(code: string) {
    return this.one("SELECT * FROM pairing_codes WHERE code = $1", [code], toPairing);
  }

  async usePairingCode(code: string, now: number): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE pairing_codes SET used_at = $2 WHERE code = $1 AND used_at IS NULL AND expires_at > $2",
      [code, d(now)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async createAgentIfRoom(a: AgentRow, maxPcs: number): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO agents (id, org_id, name, secret_hash, version, last_seen_at, created_at, revoked_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,NULL
       WHERE (SELECT count(*) FROM agents WHERE org_id = $2 AND revoked_at IS NULL) < $8`,
      [a.id, a.orgId, a.name, a.secretHash, a.version, d(a.lastSeenAt), d(a.createdAt), maxPcs],
    );
    return (r.rowCount ?? 0) > 0;
  }

  getAgent(id: string) {
    return this.one("SELECT * FROM agents WHERE id = $1", [id], toAgent);
  }

  async listAgents(orgId: string): Promise<AgentRow[]> {
    const r = await this.pool.query("SELECT * FROM agents WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at", [orgId]);
    return r.rows.map(toAgent);
  }

  async countAgents(orgId: string): Promise<number> {
    const r = await this.pool.query("SELECT count(*)::int AS n FROM agents WHERE org_id = $1 AND revoked_at IS NULL", [orgId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  updateAgent(id: string, patch: { name?: string; version?: string; lastSeenAt?: number; revokedAt?: number }) {
    return this.one(
      `UPDATE agents SET
         name = COALESCE($2, name),
         version = COALESCE($3, version),
         last_seen_at = COALESCE($4, last_seen_at),
         revoked_at = COALESCE($5, revoked_at)
       WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.version ?? null, d(patch.lastSeenAt), d(patch.revokedAt)],
      toAgent,
    );
  }

  async adminListOrgs(): Promise<AdminOrgInfo[]> {
    const [orgs, members, agents] = await Promise.all([
      this.pool.query("SELECT * FROM orgs ORDER BY created_at DESC"),
      this.pool.query("SELECT m.org_id, m.role, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id"),
      this.pool.query("SELECT id, org_id FROM agents WHERE revoked_at IS NULL"),
    ]);
    const byOrg = new Map<string, AdminOrgInfo>();
    for (const r of orgs.rows) byOrg.set(r.id, { org: toOrg(r), owners: [], members: 0, agentIds: [] });
    for (const m of members.rows) {
      const o = byOrg.get(m.org_id);
      if (!o) continue;
      o.members++;
      if (m.role === "owner") o.owners.push({ name: m.name, email: m.email });
    }
    for (const a of agents.rows) byOrg.get(a.org_id)?.agentIds.push(a.id);
    return [...byOrg.values()];
  }
}
