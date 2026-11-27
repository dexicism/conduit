import Anthropic from "@anthropic-ai/sdk";
import { StepError, type LlmBlock, type LlmMessage, type LlmRequest, type LlmResult, type LlmService } from "@conduit/engine";

/** The API takes at most this many tools marked strict in one request. */
const MAX_STRICT_TOOLS = 20;

/** Model whose refusals can be re-run server-side on a fallback model (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toParamBlocks(blocks: LlmBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  return blocks.map((b): Anthropic.Beta.BetaContentBlockParam => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
      case "image":
        if (b.mimetype === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.base64 } };
        if (!b.mimetype.startsWith("image/")) return { type: "text", text: `[A ${b.mimetype} file was attached, which can't be read here.]` };
        // Claude takes pictures up to 5 MB (and PDFs up to 32 MB); bigger ones would fail the whole request.
        if (b.base64.length * 0.75 > 5 * 1024 * 1024) return { type: "text", text: "[A picture was attached, but it's over 5 MB, too big to read. Ask for a smaller photo or a screenshot.]" };
        return { type: "image", source: { type: "base64", media_type: b.mimetype as "image/jpeg", data: b.base64 } };
      case "opaque":
        // Thinking / fallback blocks go back exactly as the API returned them.
        return b.raw as Anthropic.Beta.BetaContentBlockParam;
    }
  });
}

function toMessages(messages: LlmMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: toParamBlocks(m.content) }));
}

function fromContent(content: Anthropic.Beta.BetaContentBlock[]): LlmBlock[] {
  return content.map((c): LlmBlock => {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input };
    return { type: "opaque", raw: c };
  });
}

function stopReason(r: string | null): LlmResult["stopReason"] {
  return r === "end_turn" || r === "tool_use" || r === "max_tokens" || r === "refusal" || r === "pause_turn" ? r : r === "stop_sequence" ? "end_turn" : "other";
}

/**
 * Claude through the official SDK. Credentials come from the environment
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 */
export function createAnthropicLlm(opts: { apiKey?: string; model?: string; client?: Pick<Anthropic, "beta"> } = {}): LlmService {
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  /** ANTHROPIC_MODEL: one model for every AI step (e.g. claude-haiku-5-5 to keep costs down). */
  const forced = opts.model?.trim() || undefined;
  /**
   * Tool sets the API turned down as strict. Thinking blocks are signed against the exact
   * tool definitions, so strict on/off must never change between the steps of one turn:
   * once a set is refused, it's sent without strict from then on.
   */
  const notStrict = new Set<string>();

  return {
    async chat(req: LlmRequest): Promise<LlmResult> {
      const model = forced ?? req.model;
      const fallback = FALLBACK_MODELS.has(model);
      const toolKey = req.tools?.map((t) => t.name).join("|") ?? "";
      // Decided once per tool set, the same on every step: over the limit, or refused before, means no strict.
      const strictOk = Boolean(req.tools?.length) && req.tools!.length <= MAX_STRICT_TOOLS && !notStrict.has(toolKey);
      const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens,
        messages: toMessages(req.messages),
        // Prompt caching: the instructions and tools are the same on every message, so mark them
        // (a read costs about a tenth), and let the API cache the growing conversation too.
        ...(req.system ? { system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }] } : {}),
        cache_control: { type: "ephemeral" },
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
                strict: strictOk ? (t.strict ?? true) : false,
              })),
            }
          : {}),
        output_config: {
          ...(req.effort ? { effort: req.effort } : {}),
          ...(req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
        },
        // Refusal fallbacks: a declined request is re-run on Anthropic's recommended fallback model.
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      };
      try {
        let res;
        try {
          res = await client.beta.messages.create(params);
        } catch (err) {
          // Strict tool schemas have limits (count, size); if the API turns them down, send the same request without strict.
          const e = err as { status?: number; message?: string };
          if (e.status === 400 && strictOk && params.tools?.length && /strict|schema|grammar|too (many|complex|large)/i.test(e.message ?? "")) {
            console.warn(`[ai] Claude rejected the strict tool schemas (${e.message}); these tools are sent without strict from now on`);
            notStrict.add(toolKey);
            res = await client.beta.messages.create({ ...params, tools: params.tools.map((t) => ({ ...t, strict: false })) as typeof params.tools });
          } else throw err;
        }
        return {
          content: fromContent(res.content),
          stopReason: stopReason(res.stop_reason),
          model: res.model,
          usage: {
            // Cached input still counts as input (it's just cheaper).
            inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
            outputTokens: res.usage.output_tokens,
            cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new StepError("The AI provider rejected the server's API key");
        if (err instanceof Anthropic.PermissionDeniedError) throw new StepError("The AI provider denied access to this model");
        if (err instanceof Anthropic.NotFoundError) throw new StepError(`Model "${model}" isn't available`);
        if (err instanceof Anthropic.RateLimitError) throw new StepError("The AI provider is rate limiting requests. Try again shortly.");
        if (err instanceof Anthropic.BadRequestError) throw new StepError(`The AI provider rejected the request: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new StepError(`AI request failed (${err.status ?? "network"}): ${err.message}`);
        throw err;
      }
    },
  };
}
