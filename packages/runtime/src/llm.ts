import type { LlmService, MemoryService, MemoryTurn } from "@conduit/engine";
import type { Db, ObjectId } from "mongodb";
import { createAnthropicLlm } from "./llm-anthropic";
import { createFakeLlm } from "./llm-fake";
import { createGeminiLlm } from "./llm-gemini";
import { createOllamaLlm } from "./llm-ollama";

export type LlmProviderName = "anthropic" | "gemini" | "ollama" | "fake" | "none";

/**
 * Picks the model provider from the environment:
 * - AI_PROVIDER=fake          deterministic test model (refused in production)
 * - AI_PROVIDER=ollama       a free local model through Ollama (OLLAMA_URL, OLLAMA_MODEL)
 * - AI_PROVIDER=gemini       Google Gemini, free tier available (GEMINI_API_KEY, GEMINI_MODEL)
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
  if (choice === "gemini") {
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("AI_PROVIDER=gemini needs GEMINI_API_KEY (get one free at aistudio.google.com)");
    const timeout = Number(env.GEMINI_TIMEOUT_MS);
    // GEMINI_FALLBACK_MODELS: comma separated models to use when the main one is busy or out of requests ("none" for none).
    const fb = env.GEMINI_FALLBACK_MODELS?.trim();
    const fallbackModels = fb === undefined || fb === "" ? undefined : fb.toLowerCase() === "none" ? [] : fb.split(",").map((m) => m.trim()).filter(Boolean);
    return { provider: "gemini", llm: createGeminiLlm({ apiKey, model: env.GEMINI_MODEL, ...(fallbackModels ? { fallbackModels } : {}), ...(timeout > 0 ? { timeoutMs: timeout } : {}) }) };
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
