// Interfaz de datos del modo cuentas. Fechas en ms desde epoch; null = sin valor.

export type MemberRole = "owner" | "operator" | "viewer";

export interface OrgRow {
  id: string;
  name: string;
  plan: string;
  planExpiresAt: number | null;
  createdAt: number;
}

export interface UserRow {
  id: string;
  /** Siempre en minúsculas. */
  email: string;
  name: string;
  passwordHash: string;
  tokenVersion: number;
  createdAt: number;
}

export interface MembershipRow {
  orgId: string;
  userId: string;
  role: MemberRole;
  createdAt: number;
}

export interface MemberInfo extends MembershipRow {
  name: string;
  email: string;
}

export interface InviteRow {
  code: string;
  orgId: string;
  role: MemberRole;
  createdBy: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface PairingCodeRow {
  /** 6 caracteres, sin guion, en mayúsculas. */
  code: string;
  orgId: string;
  createdBy: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface AgentRow {
  /** UUID en minúsculas: sirve de eventId en el protocolo. */
  id: string;
  orgId: string;
  name: string;
  /** SHA-256 (hex) del secreto. */
  secretHash: string;
  version: string;
  lastSeenAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface AdminOrgInfo {
  org: OrgRow;
  owners: { name: string; email: string }[];
  members: number;
  /** Ids de los PCs vinculados (no desvinculados). */
  agentIds: string[];
}

/** El correo ya está registrado. */
export class EmailTakenError extends Error {
  constructor() {
    super("Ese correo ya está registrado");
    this.name = "EmailTakenError";
  }
}

export interface Store {
  /** Prepara la base (crea tablas). */
  init(): Promise<void>;
  close(): Promise<void>;

  // Empresas y usuarios
  /** Crea empresa + usuario + membresía de dueño en una sola operación. Lanza EmailTakenError. */
  createOrgWithOwner(org: OrgRow, user: UserRow): Promise<void>;
  /** Crea un usuario y lo une a una empresa. Lanza EmailTakenError. */
  createUserInOrg(user: UserRow, orgId: string, role: MemberRole, now: number): Promise<void>;
  getOrg(id: string): Promise<OrgRow | null>;
  updateOrg(id: string, patch: { name?: string; plan?: string; planExpiresAt?: number | null }): Promise<OrgRow | null>;
  getUser(id: string): Promise<UserRow | null>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  /** bumpTokenVersion: suma 1 a token_version (cierra las sesiones). */
  updateUser(id: string, patch: { name?: string; passwordHash?: string; bumpTokenVersion?: boolean }): Promise<UserRow | null>;

  // Equipo
  getMembership(userId: string): Promise<MembershipRow | null>;
  /** Une a un usuario existente; false si ya pertenece a alguna empresa. */
  addMembership(orgId: string, userId: string, role: MemberRole, now: number): Promise<boolean>;
  listMembers(orgId: string): Promise<MemberInfo[]>;
  setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<boolean>;
  /** Saca al usuario de la empresa y sube su token_version. */
  removeMember(orgId: string, userId: string): Promise<boolean>;

  // Invitaciones
  createInvite(invite: InviteRow): Promise<void>;
  getInvite(code: string): Promise<InviteRow | null>;
  /** Pendientes (sin usar y sin vencer). */
  listInvites(orgId: string, now: number): Promise<InviteRow[]>;
  deleteInvite(orgId: string, code: string): Promise<boolean>;
  /** Marca como usada si sigue pendiente; false si ya se usó o venció. */
  useInvite(code: string, now: number): Promise<boolean>;

  // Vinculación de PCs
  /** false si el código ya existe (choque). */
  createPairingCode(row: PairingCodeRow): Promise<boolean>;
  getPairingCode(code: string): Promise<PairingCodeRow | null>;
  /** Marca como usado si sigue pendiente; false si ya se usó o venció. */
  usePairingCode(code: string, now: number): Promise<boolean>;

  // PCs (agentes)
  /** Crea el agente solo si la empresa tiene menos de maxPcs vinculados. */
  createAgentIfRoom(agent: AgentRow, maxPcs: number): Promise<boolean>;
  getAgent(id: string): Promise<AgentRow | null>;
  /** PCs vinculados (sin los desvinculados), por fecha de creación. */
  listAgents(orgId: string): Promise<AgentRow[]>;
  countAgents(orgId: string): Promise<number>;
  updateAgent(id: string, patch: { name?: string; version?: string; lastSeenAt?: number; revokedAt?: number }): Promise<AgentRow | null>;

  // Superadministrador
  adminListOrgs(): Promise<AdminOrgInfo[]>;
}
