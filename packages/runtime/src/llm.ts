import type { LlmService, MemoryService, MemoryTurn } from "@conduit/engine";
import type { Db, ObjectId } from "mongodb";
import { createAnthropicLlm } from "./llm-anthropic";
import { createFakeLlm } from "./llm-fake";
import { createOllamaLlm } from "./llm-ollama";

export type LlmProviderName = "anthropic" | "ollama" | "fake" | "none";

/**
 * Picks the model provider from the environment:
 * - AI_PROVIDER=fake          deterministic test model (refused in production)
 * - AI_PROVIDER=ollama       a free local model through Ollama (OLLAMA_URL, OLLAMA_MODEL)
 * - AI_PROVIDER=anthropic, or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set   Claude
 * - otherwise none: AI steps and the builder are hidden.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): { provider: LlmProviderName; llm?: LlmService } {
  const choice = env.AI_PROVIDER?.trim().toLowerCase();
  if (choice === "fake") {
    if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build") {
      throw new Error("AI_PROVIDER=fake is for tests only and can't run in production");
    }
    return { provider: "fake", llm: createFakeLlm() };
  }
  if (choice === "none") return { provider: "none" };
  if (choice === "ollama") {
    const timeout = Number(env.OLLAMA_TIMEOUT_MS);
    const ctx = Number(env.OLLAMA_CONTEXT_TOKENS);
    return {
      provider: "ollama",
      llm: createOllamaLlm({ baseUrl: env.OLLAMA_URL, model: env.OLLAMA_MODEL, ...(timeout > 0 ? { timeoutMs: timeout } : {}), ...(ctx > 0 ? { contextTokens: ctx } : {}) }),
    };
  }
  if (choice === "anthropic" || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return { provider: "anthropic", llm: createAnthropicLlm() };
  }
  return { provider: "none" };
}

interface MemoryDoc {
  workflowId: ObjectId;
  nodeId: string;
  sessionKey: string;
  turns: MemoryTurn[];
  updatedAt: Date;
}

/** Agent conversation memory, scoped to one workflow. Idle conversations expire after 30 days. */
export function createMemoryService(db: Db, workflowId: ObjectId): MemoryService {
  const col = db.collection<MemoryDoc>("agent_memory");
  return {
    async load(nodeId, sessionKey) {
      const doc = await col.findOne({ workflowId, nodeId, sessionKey: sessionKey.slice(0, 200) });
      return doc?.turns ?? [];
    },
    async append(nodeId, sessionKey, turns, keep) {
      await col.updateOne(
        { workflowId, nodeId, sessionKey: sessionKey.slice(0, 200) },
        {
          $push: { turns: { $each: turns.map((t) => ({ role: t.role, text: t.text.slice(0, 20_000) })), $slice: -keep * 2 } },
          $set: { updatedAt: new Date() },
        },
        { upsert: true },
      );
    },
  };
}

export async function ensureMemoryIndexes(db: Db): Promise<void> {
  const col = db.collection("agent_memory");
  await Promise.all([
    col.createIndex({ workflowId: 1, nodeId: 1, sessionKey: 1 }, { unique: true }),
    col.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 30 * 86_400 }),
  ]);
}
