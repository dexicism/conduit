import type { LlmRequest, LlmService } from "@conduit/engine";
import { describe, expect, it } from "vitest";
import { createAnthropicLlm } from "./llm-anthropic";
import { withVoiceNotes } from "./llm";

/** A pretend Anthropic client that records what it was sent. */
function fakeClient() {
  const sent: Array<Record<string, any>> = [];
  const client = {
    beta: {
      messages: {
        async create(params: Record<string, unknown>) {
          sent.push(params);
          return {
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            model: String(params.model),
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  };
  return { client: client as never, sent };
}

const ask = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "claude-opus-5-5",
  system: "You help the sales team.",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  maxTokens: 100,
  effort: "low",
  ...over,
});

describe("Claude", () => {
  it("caches the instructions and the conversation, and can run every step on one model", async () => {
    const f = fakeClient();
    const llm = createAnthropicLlm({ client: f.client, model: "claude-haiku-5-5" });
    const r = await llm.chat(ask());
    expect(f.sent[0]!.model).toBe("claude-haiku-5-5");
    expect(f.sent[0]!.system).toEqual([{ type: "text", text: "You help the sales team.", cache_control: { type: "ephemeral" } }]);
    expect(f.sent[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(f.sent[0]!.output_config).toEqual({ effort: "low" });
    // Cached input still counts as input.
    expect(r.usage).toEqual({ inputTokens: 910, outputTokens: 5 });
    // Without a forced model, the step's model is used.
    const g = fakeClient();
    await createAnthropicLlm({ client: g.client }).chat(ask({ model: "claude-sonnet-5-5" }));
    expect(g.sent[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("sends PDFs as documents and says when a file can't be read", async () => {
    const f = fakeClient();
    await createAnthropicLlm({ client: f.client }).chat(
      ask({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mimetype: "application/pdf", base64: "JVBERi0=" },
              { type: "image", mimetype: "image/png", base64: "iVBOR" },
              { type: "image", mimetype: "video/mp4", base64: "AAAA" },
              { type: "text", text: "read these" },
            ],
          },
        ],
      }),
    );
    expect(f.sent[0]!.messages[0].content.slice(0, 3)).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      { type: "text", text: "[A video/mp4 file was attached, which can't be read here.]" },
    ]);
  });

  it("has voice notes written out by another model first (once each), or says it can't hear them", async () => {
    const seen: LlmRequest[] = [];
    const main: LlmService = { chat: async (req) => (seen.push(req), { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }) };
    let heard = 0;
    const ears: LlmService = { chat: async () => (heard++, { content: [{ type: "text", text: "Mohan ka quotation bhej do" }], stopReason: "end_turn", model: "g", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const voice = { role: "user" as const, content: [{ type: "image" as const, mimetype: "audio/ogg", base64: "T2dnUwAC".repeat(20) }, { type: "text" as const, text: "" }] };
    const llm = withVoiceNotes(main, ears);
    await llm.chat(ask({ messages: [voice] }));
    await llm.chat(ask({ messages: [voice] }));
    expect(heard).toBe(1);
    expect(seen[0]!.messages[0]!.content[0]).toEqual({ type: "text", text: "[Voice note] Mohan ka quotation bhej do" });
    await withVoiceNotes(main, null).chat(ask({ messages: [voice] }));
    expect((seen[2]!.messages[0]!.content[0] as { text: string }).text).toMatch(/couldn't be listened to/);
  });
});
