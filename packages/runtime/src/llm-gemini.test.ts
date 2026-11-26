import { describe, expect, it } from "vitest";
import { createGeminiLlm, geminiSchema, toGeminiContents } from "./llm-gemini";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, any> };

function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, sent };
}

describe("Gemini", () => {
  it("sends text and pictures, and reads the answer", async () => {
    const f = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: "It's a bill for ", thought: false }, { text: "₹4,500." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 9 }, modelVersion: "gemini-x" } }]);
    const llm = createGeminiLlm({ apiKey: "k-123", model: "gemini-x", fetch: f.fn });
    const res = await llm.chat({
      model: "claude-haiku-5-5",
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "image", mimetype: "image/png", base64: "iVBORw0KGgo=" }, { type: "text", text: "What is this?" }] }],
      maxTokens: 500,
    });
    expect(f.sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(f.sent[0]!.headers["x-goog-api-key"]).toBe("k-123");
    expect(f.sent[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }, { text: "What is this?" }] }],
      generationConfig: { maxOutputTokens: 500 },
    });
    expect(res.content.filter((b) => b.type === "text")).toEqual([{ type: "text", text: "It's a bill for ₹4,500." }]);
    expect(res).toMatchObject({ stopReason: "end_turn", model: "gemini-x", usage: { inputTokens: 300, outputTokens: 9 } });
  });

  it("calls tools and sends Gemini's own reply (with its signature) back next turn", async () => {
    const call = { functionCall: { id: "fc_1", name: "update_sheet_row", args: { value: "Mehta" } }, thoughtSignature: "SIG==" };
    const f = fakeFetch([
      { body: { candidates: [{ content: { parts: [call] }, finishReason: "STOP" }] } },
      { body: { candidates: [{ content: { parts: [{ text: "Updated Mehta." }] }, finishReason: "STOP" }] } },
    ]);
    const llm = createGeminiLlm({ apiKey: "k", fetch: f.fn });
    const tools = [{ name: "update_sheet_row", description: "Update a row", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false, $schema: "x" } }];
    const first = await llm.chat({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "Mehta paid" }] }], tools, maxTokens: 100 });
    expect(first.stopReason).toBe("tool_use");
    const use = first.content.find((b) => b.type === "tool_use");
    expect(use).toEqual({ type: "tool_use", id: "fc_1", name: "update_sheet_row", input: { value: "Mehta" } });
    expect(f.sent[0]!.body.tools[0].functionDeclarations[0].parametersJsonSchema).not.toHaveProperty("$schema");

    await llm.chat({
      model: "m",
      tools,
      maxTokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "Mehta paid" }] },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", toolUseId: "fc_1", content: '{"row":7}' }] },
      ],
    });
    expect(f.sent[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Mehta paid" }] },
      { role: "model", parts: [call] },
      { role: "user", parts: [{ functionResponse: { id: "fc_1", name: "update_sheet_row", response: { result: '{"row":7}' } } }] },
    ]);
  });

  it("asks for JSON with a schema, and explains common errors", async () => {
    const f = fakeFetch([
      { body: { candidates: [{ content: { parts: [{ text: '{"customer":"Mehta"}' }] }, finishReason: "STOP" }] } },
      { status: 429, body: { error: { code: 429, message: "Quota exceeded" } } },
      { status: 404, body: { error: { code: 404, message: "models/x is not found" } } },
      { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key." } } },
    ]);
    const llm = createGeminiLlm({ apiKey: "k", model: "x", fallbackModels: [], fetch: f.fn });
    const schema = { type: "object", properties: { customer: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["customer"], additionalProperties: false };
    const ask = () => llm.chat({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], jsonSchema: schema, maxTokens: 50 });
    expect((await ask()).content.find((b) => b.type === "text")).toEqual({ type: "text", text: '{"customer":"Mehta"}' });
    expect(f.sent[0]!.body.generationConfig).toEqual({ maxOutputTokens: 50, responseMimeType: "application/json", responseJsonSchema: schema });
    await expect(ask()).rejects.toThrow(/out of free requests/);
    await expect(ask()).rejects.toThrow(/doesn't have the model "x"/);
    await expect(ask()).rejects.toThrow(/rejected the API key/);
  });

  it("falls back to the next model when one is out of requests or overloaded, and skips a used-up one for a while", async () => {
    const ok = (text: string) => ({ body: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] } });
    const f = fakeFetch([
      { status: 429, body: { error: { code: 429, message: "Quota exceeded for metric ... limit: 20" } } },
      ok("from lite"),
      ok("lite again"),
      { status: 503, body: { error: { code: 503, message: "high demand" } } },
      { status: 503, body: { error: { code: 503, message: "high demand" } } },
      { status: 503, body: { error: { code: 503, message: "high demand" } } },
      { status: 503, body: { error: { code: 503, message: "high demand" } } },
    ]);
    const llm = createGeminiLlm({ apiKey: "k", model: "gemini-2.5-flash", fallbackModels: ["gemini-2.5-flash-lite"], retryDelayMs: 0, fetch: f.fn });
    const ask = () => llm.chat({ model: "m", effort: "low", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 50 });
    const first = await ask();
    expect(first.content.find((b) => b.type === "text")).toEqual({ type: "text", text: "from lite" });
    expect(f.sent.map((x) => x.url.split("/models/")[1])).toEqual(["gemini-2.5-flash:generateContent", "gemini-2.5-flash-lite:generateContent"]);
    expect(f.sent[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    // The used-up model is skipped next time: straight to lite.
    await ask();
    expect(f.sent[2]!.url).toContain("gemini-2.5-flash-lite");
    // Both overloaded (each retried once): a clear message.
    await expect(ask()).rejects.toThrow(/overloaded|out of free requests/);
  });

  it("converts history without Gemini's raw reply (e.g. from memory)", () => {
    expect(
      toGeminiContents([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    ).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
    expect(geminiSchema({ type: "object", strict: true, properties: { a: { $schema: "x", type: "string" } } })).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });
});
