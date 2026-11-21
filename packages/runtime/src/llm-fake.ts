import type { LlmBlock, LlmMessage, LlmRequest, LlmResult, LlmService } from "@conduit/engine";
import { BUILDER_TOOL_NAMES } from "./builder";

/**
 * Deterministic stand-in for a language model, for automated tests and local
 * development without an API key. Never enabled in production. Its answers are
 * rule-based, not intelligent: it exercises every code path (structured output,
 * tool calls, builder change sets) with predictable results.
 */

const MODEL = "test-model";

function result(content: LlmBlock[], stopReason: LlmResult["stopReason"] = "end_turn"): LlmResult {
  return { content, stopReason, model: MODEL, usage: { inputTokens: 0, outputTokens: 0 } };
}

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

function lastToolResult(messages: LlmMessage[]) {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return null;
  return last.content.filter((b): b is Extract<LlmBlock, { type: "tool_result" }> => b.type === "tool_result");
}

function between(text: string): string {
  const m = /<text>\n?([\s\S]*?)\n?<\/text>/.exec(text);
  return (m ? m[1]! : text).trim();
}

function fillSchema(schema: Record<string, unknown>, text: string): unknown {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const lower = text.toLowerCase();
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(props)) {
    const en = p.enum as string[] | undefined;
    if (key === "category" && en) {
      out[key] = en.find((c) => c !== "other" && lower.includes(c.toLowerCase())) ?? (en.includes("other") ? "other" : en[0]);
    } else if (key === "sentiment") {
      out[key] = /\b(love|great|thanks|thank you|awesome|happy)\b/.test(lower) ? "positive" : /\b(hate|bad|awful|angry|terrible|broken)\b/.test(lower) ? "negative" : "neutral";
    } else if (key === "flagged") {
      out[key] = /\b(idiot|stupid|kill|hate you)\b/.test(lower);
    } else if (key === "categories") {
      out[key] = /\b(idiot|stupid|hate you)\b/.test(lower) ? ["harassment"] : [];
    } else if (p.type === "number") {
      out[key] = key === "confidence" ? 0.9 : 0;
    } else if (p.type === "boolean") {
      out[key] = false;
    } else if (Array.isArray(p.anyOf)) {
      // Extraction: numbers from the text for numeric fields, emails for email fields, else null.
      const t = (p.anyOf as Array<{ type: string }>)[0]?.type;
      const num = /-?\d+(\.\d+)?/.exec(text);
      const email = /[^\s@]+@[^\s@]+\.[a-z]+/i.exec(text);
      out[key] = t === "number" ? (num ? Number(num[0]) : null) : /email/i.test(key) ? (email?.[0] ?? null) : null;
    } else {
      out[key] = key === "explanation" || key === "reason" ? "Rule-based test answer." : "";
    }
  }
  return out;
}

const ARITH = /(\d+(?:\.\d+)?\s*[-+*/×÷^]\s*\d+(?:\.\d+)?(?:\s*[-+*/×÷^]\s*\d+(?:\.\d+)?)*)/;

let counter = 0;

function builderTurn(req: LlmRequest): LlmResult {
  const results = lastToolResult(req.messages);
  if (results?.length) {
    const r = results[0]!;
    return result([{ type: "text", text: r.isError ? `I couldn't save that: ${r.content}` : "Built the workflow on your canvas. Fill in any empty fields, then test it." }]);
  }
  const ask = lastUserText(req.messages);
  const request = ask.split("Request:\n").pop()!.toLowerCase();
  const suffix = `${Date.now().toString(36)}${counter++}`;
  const id = (base: string) => `node-${base}-${suffix}`;
  const nodes: Array<Record<string, unknown>> = [];
  const add = (type: string, label: string, parameters: Record<string, unknown> = {}) => {
    const n = { id: id(type.split(".")[1]!), type, label, parameters, position: { x: nodes.length * 260, y: 0 }, connections: {} as Record<string, unknown> };
    const prev = nodes[nodes.length - 1];
    if (prev) prev.connections = { main: [{ targetId: n.id }] };
    nodes.push(n);
    return n;
  };
  if (request.includes("webhook")) add("trigger.webhook", "Incoming request", { method: "POST", path: `hook${suffix}`, respond: request.includes("respond") ? "respondNode" : "immediately", auth: "none" });
  else add("trigger.manual", "Start");
  if (request.includes("sentiment")) add("ai.sentiment", "Check sentiment", { text: "${['$input']['body']['message']}", outputField: "ai" });
  if (request.includes("respond")) add("core.respond", "Reply", { status: 200, headers: [], body: '{"ok": true}' });
  return result(
    [
      {
        type: "tool_use",
        id: `call-${suffix}`,
        name: BUILDER_TOOL_NAMES.save,
        input: { response: `Added ${nodes.length} steps.`, nodes, updates: [], deleted: [] },
      },
    ],
    "tool_use",
  );
}

export function createFakeLlm(): LlmService {
  return {
    async chat(req: LlmRequest): Promise<LlmResult> {
      if (req.tools?.some((t) => t.name === BUILDER_TOOL_NAMES.save)) return builderTurn(req);
      if (req.jsonSchema) return result([{ type: "text", text: JSON.stringify(fillSchema(req.jsonSchema, between(lastUserText(req.messages)))) }]);

      const results = lastToolResult(req.messages);
      if (results?.length) {
        return result([{ type: "text", text: `Result: ${results.map((r) => r.content).join("; ")}` }]);
      }
      const text = lastUserText(req.messages);
      const calc = req.tools?.find((t) => JSON.stringify(t.inputSchema).includes('"expression"'));
      const expr = ARITH.exec(text)?.[1];
      if (calc && expr) {
        return result([{ type: "tool_use", id: `t${counter++}`, name: calc.name, input: { expression: expr } }], "tool_use");
      }
      const memory = req.messages.filter((m) => m.role === "user").length - 1;
      return result([{ type: "text", text: `[test model] ${memory ? `(${memory} earlier turns) ` : ""}${text.slice(0, 200)}` }]);
    },
  };
}
