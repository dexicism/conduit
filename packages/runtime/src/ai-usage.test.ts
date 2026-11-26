import type { LlmResult, LlmService } from "@conduit/engine";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureUsageIndexes, estimateCost, trackUsage, usageSummary } from "./ai-usage";

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db("usage_test");
  await ensureUsageIndexes(db);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});

const answer = (model: string, usage: LlmResult["usage"]): LlmService => ({ chat: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", model, usage }) });

describe("AI usage", () => {
  it("prices Haiku with the cache discount, and counts Gemini and local models as free", () => {
    // 1M plain input ($0.10) + 1M output ($0.50) + 2M cached ($0.02).
    expect(estimateCost("claude-haiku-5-5", { inputTokens: 3_000_000, outputTokens: 1_000_000, cacheReadTokens: 2_000_000 })).toBeCloseTo(0.62, 6);
    expect(estimateCost("claude-haiku-5-5-20261001", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1, 6);
    expect(estimateCost("gemini-2.5-flash", { inputTokens: 5_000_000, outputTokens: 1_000_000 })).toBe(0);
    expect(estimateCost("some-new-model", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("adds up every answer per workspace, day and model", async () => {
    const ws = new ObjectId();
    const other = new ObjectId();
    const haiku = trackUsage(answer("claude-haiku-5-5", { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 8000, cacheWriteTokens: 0 }), db, ws);
    const gem = trackUsage(answer("gemini-2.5-flash", { inputTokens: 4000, outputTokens: 200 }), db, ws);
    for (let i = 0; i < 3; i++) await haiku.chat({ model: "x", messages: [], maxTokens: 10 });
    await gem.chat({ model: "x", messages: [], maxTokens: 10 });
    await trackUsage(answer("claude-haiku-5-5", { inputTokens: 1, outputTokens: 1 }), db, other).chat({ model: "x", messages: [], maxTokens: 10 });
    // Counting doesn't wait on the database: give it a moment.
    await expect.poll(async () => (await usageSummary(db, ws)).requests).toBe(4);
    const s = await usageSummary(db, ws);
    expect(s).toMatchObject({ requests: 4, inputTokens: 34_000, outputTokens: 1700, cacheReadTokens: 24_000, today: { requests: 4 } });
    expect(s.cachedShare).toBeCloseTo(24_000 / 34_000, 6);
    expect(s.byModel.map((m) => [m.model, m.requests])).toEqual([["claude-haiku-5-5", 3], ["gemini-2.5-flash", 1]]);
    // 3 × (2000 plain × 0.10 + 8000 cached × 0.01 + 500 out × 0.50) / 1M
    expect(s.estCostUsd).toBeCloseTo((3 * (2000 * 0.1 + 8000 * 0.01 + 500 * 0.5)) / 1e6, 9);
  });
});
