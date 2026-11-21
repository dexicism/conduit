import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredits } from "./credits";
import { createRuntime } from "./runtime";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ launchTimeout: 60_000 }] });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("credits_test");
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
});

async function workspace(plan = "free") {
  const _id = new ObjectId();
  await db.collection("workspaces").insertOne({ _id, name: "w", plan });
  return _id;
}

function graph(nodes: Array<{ id: string; type: string; parameters?: Record<string, unknown>; to?: string[]; onError?: string }>): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: n.to ? { main: n.to.map((t) => ({ targetId: t })) } : {},
      ...(n.onError ? { onError: n.onError } : {}),
    })),
  });
}

describe("credits ledger", () => {
  it("creates the balance from the plan, debits plan then lifetime, and never goes negative under concurrency", async () => {
    const credits = createCredits(db);
    const ws = await workspace("free"); // 500 credits
    expect((await credits.view(ws)).plan).toBe(500);
    await credits.grant(ws, 20, "lifetime", "promo");

    const results = await Promise.all(Array.from({ length: 60 }, () => credits.debit(ws, 10, { reason: "t" })));
    const b = await credits.balance(ws);
    expect(results.filter(Boolean)).toHaveLength(52); // 500 + 20 = 520 → 52 debits of 10
    expect(b.plan).toBe(0);
    expect(b.lifetime).toBe(0);
    const ledger = await credits.history(ws, 200);
    expect(ledger.filter((r) => r.kind === "debit").reduce((a, r) => a + r.amount, 0)).toBe(-520);
  });

  it("splits a debit across pools and keeps the builder pool separate", async () => {
    const credits = createCredits(db);
    const ws = await workspace("free");
    await credits.balance(ws);
    await credits.collections.balances.updateOne({ _id: ws }, { $set: { plan: 3, lifetime: 4 } });
    expect(await credits.debit(ws, 5, { reason: "split" })).toBe(true);
    expect(await credits.view(ws)).toMatchObject({ plan: 0, lifetime: 2, builder: 5 });
    expect(await credits.debit(ws, 3, { reason: "too much" })).toBe(false);
    expect(await credits.debit(ws, 5, { reason: "builder", builder: true })).toBe(true);
    expect(await credits.debit(ws, 1, { reason: "builder", builder: true })).toBe(false);
  });

  it("refills when the period ends, and on a plan change", async () => {
    let t = new Date("2026-01-01T00:00:00Z");
    const credits = createCredits(db, () => t);
    const ws = await workspace("starter");
    await credits.debit(ws, 1000, { reason: "use" });
    expect((await credits.view(ws)).plan).toBe(2000);
    t = new Date("2026-02-15T00:00:00Z");
    expect((await credits.view(ws)).plan).toBe(3000);
    await db.collection("workspaces").updateOne({ _id: ws }, { $set: { plan: "pro" } });
    await credits.applyPlan(ws, "pro");
    expect(await credits.view(ws)).toMatchObject({ plan: 30000, builder: 50, planId: "pro" });
  });
});

describe("credits in runs", () => {
  const nodes = graph([
    { id: "t", type: "trigger.manual", to: ["calc"] },
    { id: "calc", type: "core.code", parameters: { mode: "all", code: "return [{ ok: true }]" }, to: ["set"] },
    { id: "set", type: "core.set", parameters: { assignments: [{ id: "1", name: "x", value: "1", type: "string" }] } },
  ]);

  async function run(ws: ObjectId, mode: "test" | "production", g = nodes) {
    const rt = createRuntime(db, { codeTimeoutMs: 2000 });
    const id = await rt.createExecution({ workspaceId: ws, workflowId: new ObjectId(), workflowName: "c", versionId: null, mode, graph: g, triggerNodeId: "t", triggerItems: [{ json: {} }] }, false);
    return { rt, done: await rt.processExecution(id) };
  }

  it("charges live runs per step (free steps cost nothing), and test runs nothing", async () => {
    const ws = await workspace("free");
    const live = await run(ws, "production");
    expect(live.done.status).toBe("success");
    expect(live.done.creditsUsed).toBe(1); // code = 1, set = 0, trigger = 0
    expect((await live.rt.credits.view(ws)).plan).toBe(499);
    const test = await run(ws, "test");
    expect(test.done.creditsUsed).toBeUndefined();
    expect((await test.rt.credits.view(ws)).plan).toBe(499);
    // Retention follows the plan (free: 3 days).
    const days = (live.done.expiresAt.getTime() - live.done.startedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(3);
  });

  it("fails the run when credits run out, even if the step continues on error", async () => {
    const ws = await workspace("free");
    const credits = createCredits(db);
    await credits.balance(ws);
    await credits.collections.balances.updateOne({ _id: ws }, { $set: { plan: 0 } });
    const g = graph([
      { id: "t", type: "trigger.manual", to: ["calc"] },
      { id: "calc", type: "core.code", onError: "continue", parameters: { mode: "all", code: "return [{}]" } },
    ]);
    const { done } = await run(ws, "production", g);
    expect(done.status).toBe("failed");
    expect(done.error?.message).toMatch(/Out of credits/);
  });
});
