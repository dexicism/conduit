/**
 * Runs the AI Builder against a real local model.
 * Run: npx tsx scripts/try-builder.mts "your request"
 */
import { emptyGraph } from "@conduit/core";
import { validateGraphWithRegistry } from "@conduit/nodes";
import { runBuilder } from "../packages/runtime/src/builder.ts";
import { createOllamaLlm } from "../packages/runtime/src/llm-ollama.ts";

const llm = createOllamaLlm({ baseUrl: process.env.OLLAMA_URL, model: process.env.OLLAMA_MODEL });
const message = process.argv[2] ?? "When a webhook arrives, check the sentiment of the message and respond with it";
const t0 = Date.now();
const out = await runBuilder({ llm, model: "x", graph: emptyGraph(), history: [], message });
console.log(`time: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log("steps:", out.steps);
console.log("response:", out.response);
if (out.applied) {
  const g = out.applied.graph;
  console.log("nodes:", g.nodes.map((n) => `${n.type} (${n.label})`));
  console.log("problems:", JSON.stringify(validateGraphWithRegistry(g)));
} else {
  console.log("applied: nothing");
}
