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
    const claude = createAnthropicLlm({ model: env.ANTHROPIC_MODEL });
    // Claude can't listen to voice notes: with a Gemini key too, Gemini writes them out first.
    const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    const ears = geminiKey ? createGeminiLlm({ apiKey: geminiKey, model: env.GEMINI_MODEL }) : null;
    return { provider: "anthropic", llm: withVoiceNotes(claude, ears) };
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

/**
 * Agent conversation memory, scoped to one workflow; the shared memory
 * (node id "__shared") is scoped to the workspace instead. Idle conversations
 * expire after 30 days.
 */
export function createMemoryService(db: Db, workflowId: ObjectId, workspaceId?: ObjectId): MemoryService {
  const col = db.collection<MemoryDoc>("agent_memory");
  const scope = (nodeId: string) => (nodeId === "__shared" && workspaceId ? workspaceId : workflowId);
  return {
    async load(nodeId, sessionKey) {
      const doc = await col.findOne({ workflowId: scope(nodeId), nodeId, sessionKey: sessionKey.slice(0, 200) });
      return doc?.turns ?? [];
    },
    async append(nodeId, sessionKey, turns, keep) {
      await col.updateOne(
        { workflowId: scope(nodeId), nodeId, sessionKey: sessionKey.slice(0, 200) },
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

/**
 * Turns voice notes into text before the main model sees them: `ears` (a model
 * that can listen, like Gemini) writes each one out. Without one, the model is
 * told a voice note was sent that it can't hear.
 */
export function withVoiceNotes(main: LlmService, ears: LlmService | null): LlmService {
  const done = new Map<string, string>();
  return {
    async chat(req) {
      const messages = await Promise.all(
        req.messages.map(async (m) => ({
          ...m,
          content: await Promise.all(
            m.content.map(async (b) => {
              if (b.type !== "image" || !b.mimetype.startsWith("audio/")) return b;
              const key = `${b.base64.length}:${b.base64.slice(0, 64)}:${b.base64.slice(-64)}`;
              let text = done.get(key);
              if (text === undefined) {
                if (!ears) text = "";
                else {
                  try {
                    const r = await ears.chat({
                      model: "",
                      effort: "low",
                      maxTokens: 2000,
                      system: "Write out this voice note exactly as spoken, in the language spoken (Hindi in Latin letters is fine). Only the words, nothing else.",
                      messages: [{ role: "user", content: [b, { type: "text", text: "Transcribe this voice note." }] }],
                    });
                    text = r.content.filter((x): x is { type: "text"; text: string } => x.type === "text").map((x) => x.text).join("").trim();
                  } catch {
                    text = "";
                  }
                }
                if (text) done.set(key, text);
                if (done.size > 200) done.delete(done.keys().next().value!);
              }
              return { type: "text" as const, text: text ? `[Voice note] ${text}` : "[A voice note was sent, but it couldn't be listened to. Ask the person to type it.]" };
            }),
          ),
        })),
      );
      return main.chat({ ...req, messages });
    },
  };
}
