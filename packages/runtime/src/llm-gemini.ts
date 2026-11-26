import { StepError, type LlmBlock, type LlmMessage, type LlmRequest, type LlmResult, type LlmService } from "@conduit/engine";

/**
 * Google Gemini through its REST API (generativelanguage.googleapis.com).
 * Free tier available: get a key at https://aistudio.google.com.
 *
 * Every request runs on one configured model (GEMINI_MODEL), whatever model the
 * step names, because step settings name Claude models. Gemini can look at
 * images, call tools, and answer in a JSON schema.
 *
 * Newer Gemini models attach a "thought signature" to tool calls that has to be
 * sent back with the next request. The model's whole reply goes into an opaque
 * block, which the engine hands back unchanged, so nothing is lost.
 */

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  /**
   * Models to try, in order, when the main one is out of free requests or
   * overloaded (429/5xx). Default: gemini-2.5-flash-lite. Empty list = none.
   */
  fallbackModels?: string[];
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Wait before retrying an overloaded model (tests set 0). */
  retryDelayMs?: number;
}

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_GEMINI_FALLBACK = "gemini-2.5-flash-lite";

/** How long to skip a model after it said its quota is used up. */
const QUOTA_COOLDOWN_MS = 10 * 60_000;

/** Thinking makes answers slower; small budgets keep chat replies quick. */
function thinkingConfig(model: string, effort: LlmRequest["effort"]) {
  if (!/gemini-2\.5/.test(model)) return undefined;
  if (effort === "high") return { thinkingBudget: -1 };
  if (effort === "medium") return { thinkingBudget: 1024 };
  return { thinkingBudget: /pro/.test(model) ? 128 : 0 };
}

/** Another model can't use this one's thought signatures: send the plain parts. */
function withoutSignatures(contents: GeminiContent[]): GeminiContent[] {
  return contents.map((c) => ({
    ...c,
    parts: c.parts
      .filter((p) => !p.thought)
      .map((p) => {
        const { thoughtSignature: _sig, ...rest } = p as GeminiPart & { thoughtSignature?: unknown };
        return rest as GeminiPart;
      }),
  })).filter((c) => c.parts.length);
}
const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Marker for the opaque block that carries Gemini's own reply parts. */
const RAW = "geminiParts";

/** Converts the conversation to Gemini's `contents`. */
export function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const raw = m.content.find((b): b is Extract<LlmBlock, { type: "opaque" }> => b.type === "opaque" && Boolean((b.raw as Record<string, unknown>)?.[RAW]));
      for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
      if (raw) {
        // Send back exactly what Gemini said, signatures included.
        out.push({ role: "model", parts: (raw.raw as Record<string, GeminiPart[]>)[RAW]! });
        continue;
      }
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> } });
      }
      if (parts.length) out.push({ role: "model", parts });
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const name = toolNames.get(b.toolUseId) ?? "tool";
        const id = b.toolUseId.startsWith("gemini_") ? undefined : b.toolUseId;
        parts.push({ functionResponse: { ...(id ? { id } : {}), name, response: b.isError ? { error: b.content } : { result: b.content } } });
      } else if (b.type === "image") {
        parts.push({ inlineData: { mimeType: b.mimetype, data: b.base64 } });
      } else if (b.type === "text" && b.text) {
        parts.push({ text: b.text });
      }
    }
    if (parts.length) out.push({ role: "user", parts });
  }
  return out;
}

/** Gemini's JSON Schema support doesn't take every keyword; drop the ones it rejects. */
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "$schema" || k === "strict") continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

function stopReason(finish: string | undefined, hasTools: boolean): LlmResult["stopReason"] {
  if (hasTools) return "tool_use";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST" || finish === "SPII") return "refusal";
  return finish === "STOP" || !finish ? "end_turn" : "other";
}

export function createGeminiLlm(opts: GeminiOptions): LlmService {
  const primary = opts.model || DEFAULT_GEMINI_MODEL;
  const models = [primary, ...(opts.fallbackModels ?? [DEFAULT_GEMINI_FALLBACK])].filter((m, i, all) => m && all.indexOf(m) === i);
  const base = (opts.baseUrl || BASE).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const retryDelayMs = opts.retryDelayMs ?? 1200;
  const doFetch = opts.fetch ?? fetch;
  /** Model -> time until which it's skipped (its quota ran out). */
  const resting = new Map<string, number>();
  let seq = 0;

  return {
    async chat(req: LlmRequest): Promise<LlmResult> {
      const tools = req.tools?.length
        ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: geminiSchema(t.inputSchema) })) }]
        : undefined;
      const contents = toGeminiContents(req.messages);
      const bodyFor = (model: string) => {
        const thinking = thinkingConfig(model, req.effort);
        return {
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          contents: model === primary ? contents : withoutSignatures(contents),
          ...(tools ? { tools } : {}),
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            ...(thinking ? { thinkingConfig: thinking } : {}),
            ...(req.jsonSchema && !tools ? { responseMimeType: "application/json", responseJsonSchema: geminiSchema(req.jsonSchema) } : {}),
          },
        };
      };
      const send = async (model: string) => {
        try {
          return await doFetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
            body: JSON.stringify(bodyFor(model)),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const e = err as Error;
          if (e.name === "TimeoutError") throw new StepError(`Gemini took longer than ${Math.round(timeoutMs / 1000)} s to answer`);
          throw new StepError("Can't reach Gemini. Check the internet connection.");
        }
      };

      let res: Response | null = null;
      let data: GeminiResponse = {};
      let model = primary;
      let lastBusy = "";
      const now = Date.now();
      const order = [...models.filter((m) => (resting.get(m) ?? 0) <= now), ...models.filter((m) => (resting.get(m) ?? 0) > now)];
      for (const m of order) {
        model = m;
        res = await send(m);
        data = (await res.json().catch(() => ({}))) as GeminiResponse;
        // Overloaded: one quick retry on the same model.
        if (res.status >= 500 && retryDelayMs >= 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          res = await send(m);
          data = (await res.json().catch(() => ({}))) as GeminiResponse;
        }
        if (res.status === 429 || res.status >= 500) {
          lastBusy = data.error?.message ?? `status ${res.status}`;
          if (res.status === 429) resting.set(m, Date.now() + QUOTA_COOLDOWN_MS);
          continue;
        }
        break;
      }
      if (!res) throw new StepError("No Gemini model configured");
      if (!res.ok) {
        const msg = data.error?.message ?? `request failed with status ${res.status}`;
        if (res.status === 429) throw new StepError(`Gemini: out of free requests on ${models.join(" and ")} for now. Wait a while, or turn on billing for the key at aistudio.google.com. (${lastBusy.split("\n")[0]})`);
        if (res.status >= 500) throw new StepError(`Gemini is overloaded right now, try again in a minute. (${lastBusy.split("\n")[0]})`);
        if (res.status === 404) throw new StepError(`Gemini doesn't have the model "${model}". Set GEMINI_MODEL to one from aistudio.google.com.`);
        if (res.status === 400 && /API key/i.test(msg)) throw new StepError("Gemini rejected the API key. Check GEMINI_API_KEY.");
        throw new StepError(`Gemini: ${msg}`);
      }
      if (data.promptFeedback?.blockReason) {
        return { content: [{ type: "text", text: "" }], stopReason: "refusal", model, usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: 0 } };
      }
      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const content: LlmBlock[] = [{ type: "opaque", raw: { [RAW]: parts } }];
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text!)
        .join("");
      if (text) content.push({ type: "text", text });
      for (const p of parts) {
        if (!p.functionCall) continue;
        content.push({ type: "tool_use", id: p.functionCall.id ?? `gemini_${Date.now().toString(36)}_${++seq}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      }
      const hasTools = content.some((b) => b.type === "tool_use");
      return {
        content,
        stopReason: stopReason(cand?.finishReason, hasTools),
        model: data.modelVersion ?? model,
        usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
      };
    },
  };
}
