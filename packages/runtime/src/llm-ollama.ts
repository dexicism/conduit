import { StepError, type LlmBlock, type LlmMessage, type LlmRequest, type LlmResult, type LlmService } from "@conduit/engine";

/**
 * A local model through Ollama (https://ollama.com), free and offline.
 *
 * Uses Ollama's native chat API (`POST /api/chat`) with tool calling and
 * JSON-schema output (`format`). Every request runs on one configured model
 * (OLLAMA_MODEL), whatever model the step names, because step settings name
 * Claude models.
 *
 * Ollama doesn't give tool calls ids, so ids are made up here and mapped back
 * to tool names when results are sent.
 */

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  /** Base64 pictures, for vision models (e.g. qwen2.5vl, llama3.2-vision). */
  images?: string[];
}

interface OllamaResponse {
  model?: string;
  message?: OllamaMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** Request timeout. Local models can be slow, so the default is generous. */
  timeoutMs?: number;
  /** Context window in tokens. Ollama's default (a few thousand) silently cuts off long prompts like the Builder's. */
  contextTokens?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";

/** Converts the conversation to Ollama's message list. */
export function toOllamaMessages(system: string | undefined, messages: LlmMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    const text = m.content
      .filter((b): b is Extract<LlmBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (m.role === "assistant") {
      const calls = m.content.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
      for (const c of calls) toolNames.set(c.id, c.name);
      out.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> } })) } : {}),
      });
      continue;
    }
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      out.push({ role: "tool", content: b.isError ? `Error: ${b.content}` : b.content, tool_name: toolNames.get(b.toolUseId) ?? "tool" });
    }
    const images = m.content.filter((b): b is Extract<LlmBlock, { type: "image" }> => b.type === "image").map((b) => b.base64);
    if (text || images.length) out.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
  }
  return out;
}

function parseArgs(a: Record<string, unknown> | string | undefined): unknown {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
}

/** Some local models (Qwen 3, DeepSeek R1) write their reasoning in <think> tags; that isn't the answer. */
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export function createOllamaLlm(opts: OllamaOptions = {}): LlmService {
  const baseUrl = (opts.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = opts.model || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const numCtx = opts.contextTokens ?? 16_384;
  const doFetch = opts.fetch ?? fetch;
  let seq = 0;

  return {
    async chat(req: LlmRequest): Promise<LlmResult> {
      const body = {
        model,
        stream: false,
        think: false,
        messages: toOllamaMessages(req.system, req.messages),
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
          : {}),
        // JSON-schema output only when no tools are offered: some models ignore tools when `format` is set.
        ...(req.jsonSchema && !req.tools?.length ? { format: req.jsonSchema } : {}),
        options: { num_predict: req.maxTokens, num_ctx: numCtx },
      };
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "TimeoutError") throw new StepError(`The local model took longer than ${Math.round(timeoutMs / 1000)} s to answer`);
        throw new StepError(`Can't reach Ollama at ${baseUrl}. Is it running?`);
      }
      const data = (await res.json().catch(() => ({}))) as OllamaResponse;
      if (!res.ok) {
        if (res.status === 404) throw new StepError(`Ollama doesn't have the model "${model}". Run: ollama pull ${model}`);
        throw new StepError(`Ollama request failed (${res.status}): ${data.error ?? "unknown error"}`);
      }
      const msg = data.message ?? { role: "assistant", content: "" };
      const content: LlmBlock[] = [];
      const text = stripThinking(msg.content ?? "");
      if (text) content.push({ type: "text", text });
      for (const c of msg.tool_calls ?? []) {
        content.push({ type: "tool_use", id: `ollama_${Date.now().toString(36)}_${++seq}`, name: c.function.name, input: parseArgs(c.function.arguments) });
      }
      const hasTools = content.some((b) => b.type === "tool_use");
      return {
        content,
        stopReason: hasTools ? "tool_use" : data.done_reason === "length" ? "max_tokens" : "end_turn",
        model: data.model ?? model,
        usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      };
    },
  };
}
