import { planOf, type CreditBalanceView, type PlanId } from "@conduit/core";
import { ObjectId, type Db } from "mongodb";

/**
 * Credits per workspace. Balances are hot counters updated with single conditional
 * writes (never read-then-write), so concurrent runs can't overspend. Every change
 * is also written to the ledger.
 *
 * Pools: `plan` (reset each period), `lifetime` (one-off grants, used after plan),
 * `builder` (the AI Builder only).
 */

export interface CreditBalanceDoc {
  _id: ObjectId; // workspaceId
  plan: number;
  lifetime: number;
  builder: number;
  planId: PlanId;
  periodResetAt: Date;
  updatedAt: Date;
}

export interface CreditLedgerDoc {
  _id?: ObjectId;
  workspaceId: ObjectId;
  kind: "grant" | "debit" | "refund" | "reset";
  pool: "plan" | "lifetime" | "builder";
  amount: number;
  executionId?: ObjectId;
  nodeId?: string;
  reason: string;
  createdAt: Date;
}

const PERIOD_MS = 30 * 86_400_000;

export function creditCollections(db: Db) {
  return {
    balances: db.collection<CreditBalanceDoc>("credit_balances"),
    ledger: db.collection<CreditLedgerDoc>("credit_ledger"),
  };
}

export async function ensureCreditIndexes(db: Db) {
  await creditCollections(db).ledger.createIndex({ workspaceId: 1, createdAt: -1 });
}

export function createCredits(db: Db, now: () => Date = () => new Date()) {
  const c = creditCollections(db);

  async function planIdOf(workspaceId: ObjectId): Promise<PlanId> {
    const ws = await db.collection("workspaces").findOne({ _id: workspaceId }, { projection: { plan: 1 } });
    return planOf(ws?.plan).id;
  }

  /** Current balance; creates it on first use and refills the plan pools when the period has ended. */
  async function balance(workspaceId: ObjectId): Promise<CreditBalanceDoc> {
    const t = now();
    let doc = await c.balances.findOne({ _id: workspaceId });
    if (!doc) {
      const planId = await planIdOf(workspaceId);
      const p = planOf(planId);
      await c.balances.updateOne(
        { _id: workspaceId },
        { $setOnInsert: { plan: p.credits, lifetime: 0, builder: p.builderCredits, planId, periodResetAt: new Date(t.getTime() + PERIOD_MS), updatedAt: t } },
        { upsert: true },
      );
      doc = (await c.balances.findOne({ _id: workspaceId }))!;
      if (doc.updatedAt.getTime() === t.getTime()) {
        await c.ledger.insertOne({ workspaceId, kind: "grant", pool: "plan", amount: p.credits, reason: `${p.name} plan credits`, createdAt: t });
      }
    }
    if (doc.periodResetAt <= t) {
      const p = planOf(await planIdOf(workspaceId));
      const reset = await c.balances.findOneAndUpdate(
        { _id: workspaceId, periodResetAt: doc.periodResetAt },
        { $set: { plan: p.credits, builder: p.builderCredits, planId: p.id, periodResetAt: new Date(t.getTime() + PERIOD_MS), updatedAt: t } },
        { returnDocument: "after" },
      );
      if (reset) {
        await c.ledger.insertOne({ workspaceId, kind: "reset", pool: "plan", amount: p.credits, reason: `New period: ${p.name} plan credits`, createdAt: t });
        doc = reset;
      } else doc = (await c.balances.findOne({ _id: workspaceId }))!;
    }
    return doc;
  }

  async function view(workspaceId: ObjectId): Promise<CreditBalanceView> {
    const b = await balance(workspaceId);
    return { plan: b.plan, lifetime: b.lifetime, builder: b.builder, planId: b.planId, periodResetAt: b.periodResetAt.toISOString() };
  }

  /**
   * Spends credits from the plan pool, then lifetime. Returns false (and spends nothing)
   * when there aren't enough. `builder: true` spends the Builder pool instead.
   */
  async function debit(
    workspaceId: ObjectId,
    amount: number,
    meta: { reason: string; executionId?: ObjectId; nodeId?: string; builder?: boolean },
  ): Promise<boolean> {
    if (amount <= 0) return true;
    await balance(workspaceId);
    const t = now();
    const log = (pool: CreditLedgerDoc["pool"], amt: number) =>
      c.ledger.insertOne({ workspaceId, kind: "debit", pool, amount: -amt, executionId: meta.executionId, nodeId: meta.nodeId, reason: meta.reason, createdAt: t });

    if (meta.builder) {
      const r = await c.balances.updateOne({ _id: workspaceId, builder: { $gte: amount } }, { $inc: { builder: -amount }, $set: { updatedAt: t } });
      if (r.modifiedCount) await log("builder", amount);
      return r.modifiedCount === 1;
    }
    if ((await c.balances.updateOne({ _id: workspaceId, plan: { $gte: amount } }, { $inc: { plan: -amount }, $set: { updatedAt: t } })).modifiedCount) {
      await log("plan", amount);
      return true;
    }
    if ((await c.balances.updateOne({ _id: workspaceId, lifetime: { $gte: amount } }, { $inc: { lifetime: -amount }, $set: { updatedAt: t } })).modifiedCount) {
      await log("lifetime", amount);
      return true;
    }
    // Split across both pools: compare-and-set on the exact values read.
    for (let i = 0; i < 5; i++) {
      const b = await c.balances.findOne({ _id: workspaceId });
      if (!b || b.plan + b.lifetime < amount) return false;
      const fromPlan = Math.max(0, b.plan);
      const fromLifetime = amount - fromPlan;
      const r = await c.balances.updateOne(
        { _id: workspaceId, plan: b.plan, lifetime: b.lifetime },
        { $inc: { plan: -fromPlan, lifetime: -fromLifetime }, $set: { updatedAt: t } },
      );
      if (r.modifiedCount) {
        if (fromPlan) await log("plan", fromPlan);
        await log("lifetime", fromLifetime);
        return true;
      }
    }
    return false;
  }

  async function refund(workspaceId: ObjectId, amount: number, pool: CreditLedgerDoc["pool"], reason: string) {
    if (amount <= 0) return;
    await c.balances.updateOne({ _id: workspaceId }, { $inc: { [pool]: amount }, $set: { updatedAt: now() } });
    await c.ledger.insertOne({ workspaceId, kind: "refund", pool, amount, reason, createdAt: now() });
  }

  async function grant(workspaceId: ObjectId, amount: number, pool: CreditLedgerDoc["pool"], reason: string) {
    await balance(workspaceId);
    await c.balances.updateOne({ _id: workspaceId }, { $inc: { [pool]: amount }, $set: { updatedAt: now() } });
    await c.ledger.insertOne({ workspaceId, kind: "grant", pool, amount, reason, createdAt: now() });
  }

  /** Plan changed (billing): refill to the new plan's allowance and start a new period. */
  async function applyPlan(workspaceId: ObjectId, planId: PlanId) {
    await balance(workspaceId);
    const p = planOf(planId);
    const t = now();
    await c.balances.updateOne(
      { _id: workspaceId },
      { $set: { plan: p.credits, builder: p.builderCredits, planId: p.id, periodResetAt: new Date(t.getTime() + PERIOD_MS), updatedAt: t } },
    );
    await c.ledger.insertOne({ workspaceId, kind: "reset", pool: "plan", amount: p.credits, reason: `${p.name} plan credits`, createdAt: t });
  }

  async function history(workspaceId: ObjectId, limit = 50) {
    const rows = await c.ledger.find({ workspaceId }, { sort: { createdAt: -1, _id: -1 }, limit }).toArray();
    return rows.map((r) => ({
      id: String(r._id),
      kind: r.kind,
      pool: r.pool,
      amount: r.amount,
      reason: r.reason,
      executionId: r.executionId?.toHexString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  return { balance, view, debit, refund, grant, applyPlan, history, collections: c };
}

export type Credits = ReturnType<typeof createCredits>;
