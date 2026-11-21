import { describe, expect, it } from "vitest";
import { llmFromEnv } from "./llm";
import { createOllamaLlm, toOllamaMessages } from "./llm-ollama";

/** A stand-in for Ollama's /api/chat that records requests and replays canned answers. */
function fakeOllama(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("ollama provider", () => {
  it("is chosen by AI_PROVIDER=ollama, even when a Claude key is set", () => {
    expect(llmFromEnv({ AI_PROVIDER: "ollama" } as NodeJS.ProcessEnv).provider).toBe("ollama");
    expect(llmFromEnv({ AI_PROVIDER: "OLLAMA", ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv).provider).toBe("ollama");
  });

  it("converts tool calls and tool results to Ollama messages", () => {
    const out = toOllamaMessages("be brief", [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Pune" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "31C" }, { type: "tool_result", toolUseId: "zz", content: "boom", isError: true }] },
      { role: "assistant", content: [{ type: "opaque", raw: { type: "thinking" } }, { type: "text", text: "31C" }] },
    ]);
    expect(out).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "weather?" },
      { role: "assistant", content: "checking", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Pune" } } }] },
      { role: "tool", content: "31C", tool_name: "get_weather" },
      { role: "tool", content: "Error: boom", tool_name: "tool" },
      { role: "assistant", content: "31C" },
    ]);
  });

  it("sends the configured model, tools and token limit, and reads tool calls back", async () => {
    const { f, calls } = fakeOllama([
      {
        body: {
          model: "qwen3:8b",
          message: { role: "assistant", content: "<think>hmm</think>", tool_calls: [{ function: { name: "add", arguments: { a: 1, b: 2 } } }, { function: { name: "add", arguments: '{"a":3}' } }] },
          done_reason: "stop",
          prompt_eval_count: 40,
          eval_count: 7,
        },
      },
    ]);
    const llm = createOllamaLlm({ baseUrl: "http://ollama.test:11434/", model: "qwen3:8b", fetch: f });
    const r = await llm.chat({
      model: "claude-opus-5-5",
      maxTokens: 500,
      messages: [{ role: "user", content: [{ type: "text", text: "1+2" }] }],
      tools: [{ name: "add", description: "adds", inputSchema: { type: "object", properties: { a: { type: "number" } } } }],
      jsonSchema: { type: "object" },
    });
    expect(calls[0]!.url).toBe("http://ollama.test:11434/api/chat");
    expect(calls[0]!.body).toMatchObject({ model: "qwen3:8b", stream: false, options: { num_predict: 500 } });
    expect(calls[0]!.body.tools).toEqual([{ type: "function", function: { name: "add", description: "adds", parameters: { type: "object", properties: { a: { type: "number" } } } } }]);
    expect(calls[0]!.body.format).toBeUndefined(); // not combined with tools
    expect(r.stopReason).toBe("tool_use");
    expect(r.content.map((b) => b.type)).toEqual(["tool_use", "tool_use"]); // reasoning stripped
    const [a, b] = r.content as Array<{ id: string; input: unknown }>;
    expect(a!.input).toEqual({ a: 1, b: 2 });
    expect(b!.input).toEqual({ a: 3 });
    expect(a!.id).not.toBe(b!.id);
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 7 });
  });

  it("uses JSON-schema output when there are no tools, and reports a cut-off answer", async () => {
    const { f, calls } = fakeOllama([{ body: { message: { role: "assistant", content: '{"ok":true' }, done_reason: "length" } }]);
    const r = await createOllamaLlm({ fetch: f }).chat({ model: "x", maxTokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], jsonSchema: { type: "object" } });
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]!.body.format).toEqual({ type: "object" });
    expect(calls[0]!.body.model).toBe("qwen3:8b");
    expect(r.stopReason).toBe("max_tokens");
    expect(r.content).toEqual([{ type: "text", text: '{"ok":true' }]);
  });

  it("gives clear errors for a missing model, a failure, and Ollama not running", async () => {
    const req = { model: "x", maxTokens: 10, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }] };
    const missing = fakeOllama([{ status: 404, body: { error: "model not found" } }]);
    await expect(createOllamaLlm({ model: "llama3.1:8b", fetch: missing.f }).chat(req)).rejects.toThrow("ollama pull llama3.1:8b");
    const broken = fakeOllama([{ status: 500, body: { error: "out of memory" } }]);
    await expect(createOllamaLlm({ fetch: broken.f }).chat(req)).rejects.toThrow("out of memory");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createOllamaLlm({ fetch: down }).chat(req)).rejects.toThrow("Is it running?");
  });
});
