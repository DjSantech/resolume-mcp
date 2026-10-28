// Store en memoria: pruebas y desarrollo (se pierde al reiniciar).
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

const copy = <T extends object>(v: T | undefined): T | null => (v ? { ...v } : null);

export class MemoryStore implements Store {
  private readonly orgs = new Map<string, OrgRow>();
  private readonly users = new Map<string, UserRow>();
  /** userId → membresía (una empresa por usuario). */
  private readonly memberships = new Map<string, MembershipRow>();
  private readonly invites = new Map<string, InviteRow>();
  private readonly pairing = new Map<string, PairingCodeRow>();
  private readonly agents = new Map<string, AgentRow>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  private emailTaken(email: string): boolean {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email === e) return true;
    return false;
  }

  async createOrgWithOwner(org: OrgRow, user: UserRow): Promise<void> {
    if (this.emailTaken(user.email)) throw new EmailTakenError();
    this.orgs.set(org.id, { ...org });
    this.users.set(user.id, { ...user, email: user.email.toLowerCase() });
    this.memberships.set(user.id, { orgId: org.id, userId: user.id, role: "owner", createdAt: org.createdAt });
  }

  async createUserInOrg(user: UserRow, orgId: string, role: MemberRole, now: number): Promise<void> {
    if (this.emailTaken(user.email)) throw new EmailTakenError();
    this.users.set(user.id, { ...user, email: user.email.toLowerCase() });
    this.memberships.set(user.id, { orgId, userId: user.id, role, createdAt: now });
  }

  async getOrg(id: string): Promise<OrgRow | null> {
    return copy(this.orgs.get(id));
  }

  async updateOrg(id: string, patch: { name?: string; plan?: string; planExpiresAt?: number | null }): Promise<OrgRow | null> {
    const o = this.orgs.get(id);
    if (!o) return null;
    if (patch.name !== undefined) o.name = patch.name;
    if (patch.plan !== undefined) o.plan = patch.plan;
    if (patch.planExpiresAt !== undefined) o.planExpiresAt = patch.planExpiresAt;
    return { ...o };
  }

  async getUser(id: string): Promise<UserRow | null> {
    return copy(this.users.get(id));
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email === e) return { ...u };
    return null;
  }

  async updateUser(id: string, patch: { name?: string; passwordHash?: string; bumpTokenVersion?: boolean }): Promise<UserRow | null> {
    const u = this.users.get(id);
    if (!u) return null;
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.passwordHash !== undefined) u.passwordHash = patch.passwordHash;
    if (patch.bumpTokenVersion) u.tokenVersion++;
    return { ...u };
  }

  async getMembership(userId: string): Promise<MembershipRow | null> {
    return copy(this.memberships.get(userId));
  }

  async addMembership(orgId: string, userId: string, role: MemberRole, now: number): Promise<boolean> {
    if (this.memberships.has(userId) || !this.users.has(userId)) return false;
    this.memberships.set(userId, { orgId, userId, role, createdAt: now });
    return true;
  }

  async listMembers(orgId: string): Promise<MemberInfo[]> {
    const out: MemberInfo[] = [];
    for (const m of this.memberships.values()) {
      if (m.orgId !== orgId) continue;
      const u = this.users.get(m.userId);
      if (u) out.push({ ...m, name: u.name, email: u.email });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<boolean> {
    const m = this.memberships.get(userId);
    if (!m || m.orgId !== orgId) return false;
    m.role = role;
    return true;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const m = this.memberships.get(userId);
    if (!m || m.orgId !== orgId) return false;
    this.memberships.delete(userId);
    const u = this.users.get(userId);
    if (u) u.tokenVersion++;
    return true;
  }

  async createInvite(invite: InviteRow): Promise<void> {
    this.invites.set(invite.code, { ...invite });
  }

  async getInvite(code: string): Promise<InviteRow | null> {
    return copy(this.invites.get(code));
  }

  async listInvites(orgId: string, now: number): Promise<InviteRow[]> {
    return [...this.invites.values()]
      .filter((i) => i.orgId === orgId && i.usedAt === null && i.expiresAt > now)
      .map((i) => ({ ...i }))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  async deleteInvite(orgId: string, code: string): Promise<boolean> {
    const i = this.invites.get(code);
    if (!i || i.orgId !== orgId || i.usedAt !== null) return false;
    this.invites.delete(code);
    return true;
  }

  async useInvite(code: string, now: number): Promise<boolean> {
    const i = this.invites.get(code);
    if (!i || i.usedAt !== null || i.expiresAt <= now) return false;
    i.usedAt = now;
    return true;
  }

  async createPairingCode(row: PairingCodeRow): Promise<boolean> {
    if (this.pairing.has(row.code)) return false;
    this.pairing.set(row.code, { ...row });
    return true;
  }

  async getPairingCode(code: string): Promise<PairingCodeRow | null> {
    return copy(this.pairing.get(code));
  }

  async usePairingCode(code: string, now: number): Promise<boolean> {
    const p = this.pairing.get(code);
    if (!p || p.usedAt !== null || p.expiresAt <= now) return false;
    p.usedAt = now;
    return true;
  }

  async createAgentIfRoom(agent: AgentRow, maxPcs: number): Promise<boolean> {
    if ((await this.countAgents(agent.orgId)) >= maxPcs) return false;
    this.agents.set(agent.id, { ...agent });
    return true;
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    return copy(this.agents.get(id));
  }

  async listAgents(orgId: string): Promise<AgentRow[]> {
    return [...this.agents.values()]
      .filter((a) => a.orgId === orgId && a.revokedAt === null)
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async countAgents(orgId: string): Promise<number> {
    let n = 0;
    for (const a of this.agents.values()) if (a.orgId === orgId && a.revokedAt === null) n++;
    return n;
  }

  async updateAgent(id: string, patch: { name?: string; version?: string; lastSeenAt?: number; revokedAt?: number }): Promise<AgentRow | null> {
    const a = this.agents.get(id);
    if (!a) return null;
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.version !== undefined) a.version = patch.version;
    if (patch.lastSeenAt !== undefined) a.lastSeenAt = patch.lastSeenAt;
    if (patch.revokedAt !== undefined) a.revokedAt = patch.revokedAt;
    return { ...a };
  }

  async adminListOrgs(): Promise<AdminOrgInfo[]> {
    const out: AdminOrgInfo[] = [];
    for (const org of this.orgs.values()) {
      const members = await this.listMembers(org.id);
      const agents = await this.listAgents(org.id);
      out.push({
        org: { ...org },
        owners: members.filter((m) => m.role === "owner").map((m) => ({ name: m.name, email: m.email })),
        members: members.length,
        agentIds: agents.map((a) => a.id),
      });
    }
    return out.sort((a, b) => b.org.createdAt - a.org.createdAt);
  }
}
