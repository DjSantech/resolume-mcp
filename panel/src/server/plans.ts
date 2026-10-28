// Planes del modo cuentas (precios en pesos colombianos). Publicados en GET /api/plans.

export type PlanId = "prueba" | "vj" | "productora" | "empresa";

export interface Plan {
  id: PlanId;
  name: string;
  /** Precio mensual en COP (entero). */
  priceCop: number;
  /** PCs vinculados como máximo. */
  maxPcs: number;
  /** Solo el plan de prueba: días desde el registro. */
  trialDays?: number;
  features: string[];
}

export const TRIAL_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const PLANS: readonly Plan[] = [
  {
    id: "prueba",
    name: "Prueba",
    priceCop: 0,
    maxPcs: 1,
    trialDays: TRIAL_DAYS,
    features: ["1 PC con Resolume", `${TRIAL_DAYS} días gratis`, "Control desde el celular", "Automatizaciones"],
  },
  {
    id: "vj",
    name: "VJ",
    priceCop: 60_000,
    maxPcs: 1,
    features: ["1 PC con Resolume", "Control desde el celular", "Automatizaciones", "Diseño de pantallas LED"],
  },
  {
    id: "productora",
    name: "Productora",
    priceCop: 200_000,
    maxPcs: 5,
    features: ["Hasta 5 PCs", "Equipo ilimitado", "Operadores y observadores", "Todo lo del plan VJ"],
  },
  {
    id: "empresa",
    name: "Empresa",
    priceCop: 520_000,
    maxPcs: 15,
    features: ["Hasta 15 PCs", "Equipo ilimitado", "Soporte prioritario", "Todo lo del plan Productora"],
  },
];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && PLANS.some((p) => p.id === v);
}

/** Plan por id; uno desconocido se trata como el de prueba. */
export function getPlan(id: string): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]!;
}

export interface PlanStatus {
  id: PlanId;
  name: string;
  maxPcs: number;
  /** ms desde epoch; null = no vence. */
  expiresAt: number | null;
  active: boolean;
  /** Días que quedan (redondeado hacia arriba); null = no vence. */
  daysLeft: number | null;
}

export function isPlanActive(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt === null || now < expiresAt;
}

export function planStatus(org: { plan: string; planExpiresAt: number | null }, now = Date.now()): PlanStatus {
  const p = getPlan(org.plan);
  const exp = org.planExpiresAt;
  return {
    id: p.id,
    name: p.name,
    maxPcs: p.maxPcs,
    expiresAt: exp,
    active: isPlanActive(exp, now),
    daysLeft: exp === null ? null : Math.max(0, Math.ceil((exp - now) / DAY_MS)),
  };
}
