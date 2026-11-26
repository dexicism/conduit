import type { LlmService } from "@conduit/engine";
import type { Db, ObjectId } from "mongodb";

/**
 * How much AI a workspace uses: one document per workspace, day and model with
 * running totals. Prices are an estimate for the home page, not a bill.
 */

interface UsageDoc {
  workspaceId: ObjectId;
  /** YYYY-MM-DD in the server's time zone. */
  day: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  updatedAt: Date;
}

/** US$ per million tokens: input, output, cached input read, cache write. */
const PRICES: Array<{ prefix: string; input: number; output: number; cacheRead: number; cacheWrite: number }> = [
  { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { prefix: "claude-fable-5-2", input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
];

function priceOf(model: string) {
  return PRICES.find((p) => model.startsWith(p.prefix)) ?? null;
}

/** Estimated cost in US$; null when the model's price isn't known (local models and free tiers count as 0). */
export function estimateCost(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | null {
  if (/^(gemini|qwen|llama|fake|gemma|mistral|phi)/i.test(model)) return 0;
  const p = priceOf(model);
  if (!p) return null;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const plain = Math.max(0, u.inputTokens - cacheRead - cacheWrite);
  return (plain * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + u.outputTokens * p.output) / 1_000_000;
}

function today(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}

/** Wraps a model so every answer adds to the workspace's usage. Never fails a request because of the counting. */
export function trackUsage(llm: LlmService, db: Db, workspaceId: ObjectId): LlmService {
  const col = db.collection<UsageDoc>("ai_usage");
  return {
    async chat(req) {
      const res = await llm.chat(req);
      const u = res.usage;
      void col
        .updateOne(
          { workspaceId, day: today(new Date()), model: res.model || req.model || "unknown" },
          {
            $inc: { requests: 1, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0 },
            $set: { updatedAt: new Date() },
          },
          { upsert: true },
        )
        .catch(() => {});
      return res;
    },
  };
}

export async function ensureUsageIndexes(db: Db): Promise<void> {
  const col = db.collection("ai_usage");
  await Promise.all([
    col.createIndex({ workspaceId: 1, day: 1, model: 1 }, { unique: true }),
    col.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 400 * 86_400 }),
  ]);
}

export interface UsageSummary {
  days: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Share of input that came from the cache (0..1), or null with no input. */
  cachedShare: number | null;
  /** Estimated US$; null if a model's price isn't known. */
  estCostUsd: number | null;
  byModel: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number; estCostUsd: number | null }>;
  today: { requests: number; estCostUsd: number | null };
}

/** Totals for the last `days` days (today included). */
export async function usageSummary(db: Db, workspaceId: ObjectId, days = 7, now = new Date()): Promise<UsageSummary> {
  const from = today(new Date(now.getTime() - (days - 1) * 86_400_000));
  const docs = await db.collection<UsageDoc>("ai_usage").find({ workspaceId, day: { $gte: from } }).toArray();
  const byModel = new Map<string, { model: string; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>();
  for (const d of docs) {
    const m = byModel.get(d.model) ?? { model: d.model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    m.requests += d.requests;
    m.inputTokens += d.inputTokens;
    m.outputTokens += d.outputTokens;
    m.cacheReadTokens += d.cacheReadTokens ?? 0;
    m.cacheWriteTokens += d.cacheWriteTokens ?? 0;
    byModel.set(d.model, m);
  }
  const models = [...byModel.values()].map((m) => ({ ...m, estCostUsd: estimateCost(m.model, m) })).sort((a, b) => b.requests - a.requests);
  const sum = (k: "requests" | "inputTokens" | "outputTokens" | "cacheReadTokens") => models.reduce((t, m) => t + m[k], 0);
  const cost = models.some((m) => m.estCostUsd === null) ? null : models.reduce((t, m) => t + (m.estCostUsd ?? 0), 0);
  const todays = docs.filter((d) => d.day === today(now));
  const todayCost = todays.some((d) => estimateCost(d.model, d) === null) ? null : todays.reduce((t, d) => t + (estimateCost(d.model, d) ?? 0), 0);
  const input = sum("inputTokens");
  return {
    days,
    requests: sum("requests"),
    inputTokens: input,
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cachedShare: input ? sum("cacheReadTokens") / input : null,
    estCostUsd: cost,
    byModel: models.map(({ model, requests, inputTokens, outputTokens, estCostUsd }) => ({ model, requests, inputTokens, outputTokens, estCostUsd })),
    today: { requests: todays.reduce((t, d) => t + d.requests, 0), estCostUsd: todayCost },
  };
}
