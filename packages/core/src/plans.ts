/** Plans and their limits. Prices are display-only; billing uses the provider's price IDs. */

export const PLAN_IDS = ["free", "starter", "pro", "max"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  id: PlanId;
  name: string;
  /** Monthly price in US dollars, for display. */
  priceUsd: number;
  /** Credits granted each billing period. */
  credits: number;
  builderCredits: number;
  concurrency: number;
  retentionDays: number;
  members: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: { id: "free", name: "Free", priceUsd: 0, credits: 500, builderCredits: 5, concurrency: 2, retentionDays: 3, members: 1 },
  starter: { id: "starter", name: "Starter", priceUsd: 9, credits: 3_000, builderCredits: 10, concurrency: 4, retentionDays: 7, members: 3 },
  pro: { id: "pro", name: "Pro", priceUsd: 29, credits: 30_000, builderCredits: 50, concurrency: 12, retentionDays: 21, members: 10 },
  max: { id: "max", name: "Max", priceUsd: 149, credits: 200_000, builderCredits: 250, concurrency: 32, retentionDays: 60, members: 50 },
};

export function planOf(id: unknown): PlanLimits {
  return PLANS[(PLAN_IDS as readonly string[]).includes(String(id)) ? (id as PlanId) : "free"];
}

export interface CreditBalanceView {
  plan: number;
  lifetime: number;
  builder: number;
  periodResetAt: string;
  planId: PlanId;
}
