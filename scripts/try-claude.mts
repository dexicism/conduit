/**
 * Checks Claude with your real key: a plain answer, a tool call, and that the
 * prompt cache is used (the second request should read the instructions from it).
 * Three tiny requests; on Haiku that's well under a cent.
 * Run: npx tsx --env-file=apps/web/.env.local scripts/try-claude.mts
 */
import type { LlmBlock, LlmRequest } from "../packages/engine/src/types.ts";
import { createAnthropicLlm } from "../packages/runtime/src/llm-anthropic.ts";

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log("No ANTHROPIC_API_KEY in apps/web/.env.local yet.");
  process.exit(1);
}
const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const llm = createAnthropicLlm({ model });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const text = (c: LlmBlock[]) => c.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");

// Long enough to be cached (the minimum is about 512 tokens on current models).
const system = [
  "You're the WhatsApp assistant of a small sales team. Reply briefly, in the language the person writes in.",
  ...Array.from({ length: 40 }, (_, i) => `Rule ${i + 1}: keep the customer's notes, never invent phone numbers, write dates as DD-MM-YY, and look things up with your tools before answering.`),
].join("\n");
const tools = [
  {
    name: "find_lead",
    description: "Find a lead in the sheet by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The name" } }, required: ["name"], additionalProperties: false },
  },
];
const ask = (q: string): LlmRequest => ({ model, system, tools, maxTokens: 1000, effort: "low", messages: [{ role: "user", content: [{ type: "text", text: q }] }] });

try {
  const a = await llm.chat(ask("Say hello in Hinglish, in five words."));
  console.log(`1. answer (${a.model}, ${secs()}): ${text(a.content)}`);
  console.log(`   tokens: ${a.usage.inputTokens} in (cache written ${a.usage.cacheWriteTokens ?? 0}, read ${a.usage.cacheReadTokens ?? 0}), ${a.usage.outputTokens} out`);

  const b = await llm.chat(ask("What's the status of Mohan? Use the tool."));
  const call = b.content.find((x) => x.type === "tool_use");
  console.log(`2. tool call (${secs()}): ${call && call.type === "tool_use" ? `${call.name}(${JSON.stringify(call.input)})` : `none, it said: ${text(b.content)}`}`);
  console.log(`   tokens: ${b.usage.inputTokens} in (read from cache: ${b.usage.cacheReadTokens ?? 0}), ${b.usage.outputTokens} out`);

  const c = await llm.chat(ask("Kal kitne baje call karna hai? One line."));
  console.log(`3. third request (${secs()}): read from cache ${c.usage.cacheReadTokens ?? 0} of ${c.usage.inputTokens} input tokens`);
  console.log((c.usage.cacheReadTokens ?? 0) > 0 ? "\nAll good: Claude answers, uses tools, and the cache works." : "\nClaude works, but nothing came from the cache. Tell me and I'll look.");
} catch (e) {
  console.log(`Claude didn't work: ${(e as Error).message}`);
  process.exit(1);
}
