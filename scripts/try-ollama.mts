/**
 * Checks the Ollama provider against a real, running Ollama.
 * Run: npx tsx scripts/try-ollama.mts   (OLLAMA_MODEL / OLLAMA_URL optional)
 */
import { createOllamaLlm } from "../packages/runtime/src/llm-ollama.ts";

const llm = createOllamaLlm({ baseUrl: process.env.OLLAMA_URL, model: process.env.OLLAMA_MODEL });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

// 1. Plain answer.
const a = await llm.chat({ model: "x", maxTokens: 200, messages: [{ role: "user", content: [{ type: "text", text: "Reply with one word: the capital of France." }] }] });
console.log("1. text:", JSON.stringify(a.content), a.stopReason, secs());

// 2. Tool call, then the final answer after the tool result.
const tools = [{ name: "get_weather", description: "Current temperature for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
const q = { role: "user" as const, content: [{ type: "text" as const, text: "What's the temperature in Pune right now? Use the tool." }] };
const b = await llm.chat({ model: "x", maxTokens: 400, tools, messages: [q] });
console.log("2. tool call:", JSON.stringify(b.content), b.stopReason, secs());
const call = b.content.find((x) => x.type === "tool_use");
if (call && call.type === "tool_use") {
  const c = await llm.chat({
    model: "x",
    maxTokens: 300,
    tools,
    messages: [q, { role: "assistant", content: b.content }, { role: "user", content: [{ type: "tool_result", toolUseId: call.id, content: '{"celsius":31}' }] }],
  });
  console.log("3. after tool:", JSON.stringify(c.content), c.stopReason, secs());
}

// 4. JSON-schema output.
const d = await llm.chat({
  model: "x",
  maxTokens: 300,
  jsonSchema: { type: "object", properties: { sentiment: { type: "string", enum: ["positive", "negative"] } }, required: ["sentiment"] },
  messages: [{ role: "user", content: [{ type: "text", text: "Classify: 'I love this product'" }] }],
});
console.log("4. json:", JSON.stringify(d.content), d.stopReason, secs());
