import { buildAiFill, workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { describe, expect, it, vi } from "vitest";
import { calculate } from "./calc";
import { initialState, runExecution } from "./runner";
import type { EngineServices, Item, LlmBlock, LlmRequest, LlmResult, MemoryTurn, StepRecord } from "./types";

type N = { id: string; type: string; parameters?: Record<string, unknown>; to?: Record<string, Array<string | { targetId: string; targetHandle: string }>> };

function graph(nodes: N[]): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: Object.fromEntries(
        Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => (typeof t === "string" ? { targetId: t } : t))]),
      ),
    })),
  });
}

const reply = (content: LlmBlock[], stopReason: LlmResult["stopReason"] = "end_turn"): LlmResult => ({
  content,
  stopReason,
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1 },
});
const text = (t: string): LlmBlock => ({ type: "text", text: t });

function services(chat: (req: LlmRequest) => Promise<LlmResult> | LlmResult, over: Partial<EngineServices> = {}): EngineServices {
  return {
    http: vi.fn(async (r) => ({ status: 200, headers: {}, body: { echoed: r.url } })),
    runCode: vi.fn(async ({ items }) => ({ items: items.map((i: Item) => ({ upper: String(i.json.input).toUpperCase() })), logs: [] })),
    executeWorkflow: vi.fn(async ({ input }) => [{ json: { got: input } }]),
    now: () => new Date("2026-01-01T00:00:00Z"),
    llm: { chat: vi.fn(async (r: LlmRequest) => chat(r)) },
    ...over,
  };
}

async function run(g: WorkflowGraph, items: Item[], svc: EngineServices) {
  const steps: StepRecord[] = [];
  const r = await runExecution({ graph: g, state: initialState(g, g.nodes[0]!.id, items), services: svc, hooks: { onStep: (s) => void steps.push(s) } });
  return { ...r, steps };
}

const agentGraph = (tools: N[], agentParams: Record<string, unknown> = {}) =>
  graph([
    { id: "t", type: "trigger.manual", to: { main: ["agent"] } },
    {
      id: "agent",
      type: "ai.agent",
      parameters: { prompt: "${['$input']['q']}", instructions: "Be brief.", ...agentParams },
      to: { tool: tools.map((x) => ({ targetId: x.id, targetHandle: "agent" })) },
    },
    ...tools,
  ]);

describe("AI Agent", () => {
  it("runs the tool loop: parallel calls, results returned together, final answer", async () => {
    const g = agentGraph([
      { id: "calc", type: "tool.calculator" },
      { id: "api", type: "tool.http", parameters: { toolName: "weather", url: `https://api.test/w?city=${buildAiFill("city", "City")}` } },
    ]);
    const seen: LlmRequest[] = [];
    const svc = services((req) => {
      seen.push(structuredClone(req));
      if (req.messages.length === 1) {
        return reply(
          [
            { type: "opaque", raw: { type: "thinking", signature: "abc" } },
            { type: "tool_use", id: "c1", name: "calculator", input: { expression: "6 * 7" } },
            { type: "tool_use", id: "c2", name: "weather", input: { city: "Paris" } },
          ],
          "tool_use",
        );
      }
      return reply([text("42 and sunny")]);
    });
    const r = await run(g, [{ json: { q: "What is 6*7 and the weather?" } }], svc);
    expect(r.status).toBe("success");
    expect(r.state.lastOutput[0]!.json).toEqual({ output: "42 and sunny", toolCalls: 2, model: "test-model" });

    // Tool specs: the AI-fill slot became the HTTP tool's schema.
    expect(seen[0]!.tools!.find((t) => t.name === "weather")!.inputSchema).toMatchObject({ required: ["city"], additionalProperties: false });
    expect(seen[0]!.system?.startsWith("Be brief.\n\nIt's now ")).toBe(true);
    // Only the date is in the instructions (cacheable all day); the time goes with the message.
    expect(seen[0]!.system).toMatch(/the time is given with each message\.$/);
    expect((seen[0]!.messages.at(-1)!.content.at(-1) as { text: string }).text).toMatch(/^\[\d{2}:\d{2}\] /);
    // Second request: assistant turn kept verbatim (incl. opaque thinking), then both results in ONE user message.
    const second = seen[1]!.messages;
    expect(second[1]!.content[0]).toEqual({ type: "opaque", raw: { type: "thinking", signature: "abc" } });
    expect(second[2]!.role).toBe("user");
    expect(second[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "c1", content: '{"result":42}' },
      { type: "tool_result", toolUseId: "c2", content: expect.stringContaining("city=Paris") },
    ]);
    expect(svc.http).toHaveBeenCalledWith(expect.objectContaining({ url: "https://api.test/w?city=Paris" }));
    expect(r.steps.find((s) => s.nodeId === "agent")!.logs[0]).toMatch(/^calculator/);
    // Tool steps never run as normal steps.
    expect(r.steps.map((s) => s.nodeId)).toEqual(["t", "agent"]);
  });

  it("reports tool errors back to the model so it can recover", async () => {
    const g = agentGraph([{ id: "calc", type: "tool.calculator" }]);
    let round = 0;
    const svc = services((req) => {
      round++;
      if (round === 1) return reply([{ type: "tool_use", id: "x", name: "calculator", input: { expression: "1/0" } }], "tool_use");
      if (round === 2) return reply([{ type: "tool_use", id: "y", name: "nope", input: {} }], "tool_use");
      const last = req.messages.at(-1)!.content[0] as Extract<LlmBlock, { type: "tool_result" }>;
      return reply([text(`recovered: ${last.content}`)]);
    });
    const r = await run(g, [{ json: { q: "x" } }], svc);
    expect(r.state.lastOutput[0]!.json.output).toBe('recovered: Unknown tool "nope"');
  });

  it("stops at the round limit, and fails on refusals", async () => {
    const g = agentGraph([{ id: "think", type: "tool.think" }], { maxIterations: 2 });
    const loop = services(() => reply([{ type: "tool_use", id: "t", name: "think", input: { thought: "hmm" } }], "tool_use"));
    const r = await run(g, [{ json: { q: "x" } }], loop);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error.message).toMatch(/Stopped after 2 tool rounds/);
    expect(loop.llm!.chat).toHaveBeenCalledTimes(3);

    const refuse = await run(g, [{ json: { q: "x" } }], services(() => reply([], "refusal")));
    expect(refuse.status === "failed" && refuse.error.message).toMatch(/declined/);
  });

  it("remembers recent turns per conversation ID", async () => {
    const store = new Map<string, MemoryTurn[]>();
    const memory = {
      load: vi.fn(async (node: string, key: string) => store.get(`${node}:${key}`) ?? []),
      append: vi.fn(async (node: string, key: string, turns: MemoryTurn[], keep: number) => {
        store.set(`${node}:${key}`, [...(store.get(`${node}:${key}`) ?? []), ...turns].slice(-keep * 2));
      }),
    };
    const g = agentGraph([], { memory: "window", sessionKey: "${['$input']['chat']}", memoryTurns: 1 });
    const prompts: number[] = [];
    const svc = services((req) => {
      prompts.push(req.messages.length);
      return reply([text(`reply ${prompts.length}`)]);
    }, { memory });
    await run(g, [{ json: { q: "hi", chat: "c1" } }], svc);
    await run(g, [{ json: { q: "again", chat: "c1" } }], svc);
    await run(g, [{ json: { q: "other", chat: "c2" } }], svc);
    expect(prompts).toEqual([1, 3, 1]); // second call sees the previous user+assistant turn
    expect(store.get("agent:c1")).toEqual([
      { role: "user", text: "again" },
      { role: "assistant", text: "reply 2" },
    ]);
  });

  it("shares memory across workflows for the same person: a question sent earlier is part of the chat", async () => {
    const store = new Map<string, MemoryTurn[]>();
    const memory = {
      load: vi.fn(async (node: string, key: string) => store.get(`${node}:${key}`) ?? []),
      append: vi.fn(async (node: string, key: string, turns: MemoryTurn[]) => void store.set(`${node}:${key}`, [...(store.get(`${node}:${key}`) ?? []), ...turns])),
    };
    // What a checker workflow sent earlier (two messages in a row).
    store.set("__shared:919800000001", [
      { role: "assistant", text: "[Checker asked] Is the quotation for Mohan ready?" },
      { role: "assistant", text: "[Checker asked] Reminder: any update?" },
    ]);
    const g = agentGraph([], { memory: "shared", sessionKey: "${['$input']['chat']}" });
    let seen: LlmRequest | null = null;
    const svc = services((req) => ((seen = structuredClone(req)), reply([text("Great, marked as sent.")])), { memory });
    await run(g, [{ json: { q: "done", chat: "919800000001" } }], svc);
    const msgs = seen!.messages.map((m) => [m.role, (m.content.at(-1) as { text: string }).text.replace(/^\[\d{2}:\d{2}\] /, "")]);
    expect(msgs).toEqual([
      ["user", "(Earlier in this chat)"],
      ["assistant", "[Checker asked] Is the quotation for Mohan ready?\n\n[Checker asked] Reminder: any update?"],
      ["user", "done"],
    ]);
    expect(memory.load).toHaveBeenCalledWith("__shared", "919800000001");
    expect(store.get("__shared:919800000001")!.slice(-2)).toEqual([
      { role: "user", text: "done" },
      { role: "assistant", text: "Great, marked as sent." },
    ]);
  });
  it("with days of chat kept, sends only the recent exchanges and can search the rest", async () => {
    const store: MemoryTurn[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), text: i === 2 ? "Raghav wants 12 windows at 4500 each" : `chat ${i}`, at: "2026-11-20T10:00:00Z" }));
    const memory = {
      load: vi.fn(async () => store),
      append: vi.fn(async () => {}),
      search: vi.fn(async (_n: string, _k: string, q: string) => store.filter((t) => q.split(" ").every((w) => t.text.toLowerCase().includes(w.toLowerCase())))),
    };
    const g = agentGraph([], { memory: "shared", sessionKey: "${['$input']['chat']}", memoryTurns: 3, memoryKeepDays: 30 });
    const seen: LlmRequest[] = [];
    const svc = services((req) => {
      seen.push(structuredClone(req));
      if (seen.length === 1) return reply([{ type: "tool_use", id: "s1", name: "search_old_chat", input: { words: "raghav windows" } }], "tool_use");
      return reply([text("Raghav wanted 12 windows at 4500.")]);
    }, { memory });
    const r = await run(g, [{ json: { q: "what did Raghav want?", chat: "9198" } }], svc);
    expect(r.status).toBe("success");
    // 3 recent exchanges (6 turns) + the new message, not all 30.
    expect(seen[0]!.messages).toHaveLength(7);
    expect(seen[0]!.tools!.map((t) => t.name)).toContain("search_old_chat");
    const found = seen[1]!.messages.at(-1)!.content[0] as { content: string };
    expect(JSON.parse(found.content)).toEqual([{ when: "2026-11-20T10:00:00Z", from: "them", text: "Raghav wants 12 windows at 4500 each" }]);
    // Saved with the days, so the store keeps the whole month.
    expect(memory.append).toHaveBeenCalledWith("__shared", "9198", expect.any(Array), 3, 30);
  });

  it("uses file steps as tools and keeps file contents out of what the model reads", async () => {
    const g = agentGraph([{ id: "xl", type: "tool.doc.excel", parameters: { toolName: "make_excel", source: "rows", rows: buildAiFill("rows", "The table"), fileName: "leads" } }]);
    const seen: LlmRequest[] = [];
    const svc = services((req) => {
      seen.push(structuredClone(req));
      if (seen.length === 1) return reply([{ type: "tool_use", id: "x1", name: "make_excel", input: { rows: "Name | Phone\nMohan | 9800000101" } }], "tool_use");
      return reply([text("Here is your Excel file.")]);
    });
    const r = await run(g, [{ json: { q: "excel please" } }], svc);
    expect(r.status).toBe("success");
    const result = seen[1]!.messages.at(-1)!.content[0] as { type: string; content: string };
    expect(result.type).toBe("tool_result");
    expect(JSON.parse(result.content)).toEqual([{ file: { fileName: "leads.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: expect.any(Number), rows: 1 } }]);
    expect(result.content).not.toContain("base64");
  });
  it("calls sub-workflows and code tools", async () => {
    const g = agentGraph([
      { id: "wf", type: "tool.workflow", parameters: { workflowId: "abc", input: `{"request": "${buildAiFill("request", "Req")}"}` } },
      { id: "code", type: "tool.code" },
    ]);
    let round = 0;
    const svc = services(() => {
      round++;
      if (round === 1)
        return reply(
          [
            { type: "tool_use", id: "a", name: "run_workflow", input: { request: "refund #12" } },
            { type: "tool_use", id: "b", name: "run_code", input: { input: "shout" } },
          ],
          "tool_use",
        );
      return reply([text("done")]);
    });
    await run(g, [{ json: { q: "x" } }], svc);
    expect(svc.executeWorkflow).toHaveBeenCalledWith({ workflowId: "abc", input: { request: "refund #12" }, waitForResult: true });
    expect(svc.runCode).toHaveBeenCalledWith(expect.objectContaining({ items: [{ json: { input: "shout" } }] }));
  });

  it("explains when AI isn't configured", async () => {
    const g = agentGraph([]);
    const r = await run(g, [{ json: { q: "x" } }], { ...services(() => reply([])), llm: undefined });
    expect(r.status === "failed" && r.error.message).toMatch(/AI isn't configured/);
  });
});

describe("structured AI steps", () => {
  const json = (o: unknown) => reply([text(JSON.stringify(o))]);

  it("classifies and routes by category, with an 'other' branch", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["cls"] } },
      {
        id: "cls",
        type: "ai.classify",
        parameters: { text: "${['$input']['m']}", categories: [{ id: "b", value: "billing" }, { id: "s", value: "support" }], allowOther: true },
        to: { "case-b": ["bill"], other: ["misc"] },
      },
      { id: "bill", type: "core.set", parameters: { assignments: [] } },
      { id: "misc", type: "core.set", parameters: { assignments: [] } },
    ]);
    let schema: Record<string, unknown> | undefined;
    const svc = services((req) => {
      schema = req.jsonSchema;
      const m = (req.messages[0]!.content[0] as { text: string }).text;
      return json({ category: m.includes("refund") ? "billing" : "other", confidence: 0.9 });
    });
    const r = await run(g, [{ json: { m: "I want a refund" } }, { json: { m: "hello" } }], svc);
    expect(r.status).toBe("success");
    expect(r.state.outputs.bill!.map((i) => i.json.category)).toEqual(["billing"]);
    expect(r.state.outputs.misc!.map((i) => i.json.m)).toEqual(["hello"]);
    expect((schema!.properties as Record<string, { enum?: string[] }>).category!.enum).toEqual(["billing", "support", "other"]);
  });

  it("sentiment, moderation routing and extraction with nulls", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["mod"] } },
      { id: "mod", type: "ai.moderate", parameters: { text: "${['$input']['m']}" }, to: { allowed: ["sent"], flagged: ["bad"] } },
      { id: "sent", type: "ai.sentiment", parameters: { text: "${['$input']['m']}", outputField: "mood" }, to: { main: ["ext"] } },
      { id: "bad", type: "core.set", parameters: { assignments: [] } },
      {
        id: "ext",
        type: "ai.extract",
        parameters: {
          text: "${['$input']['m']}",
          fields: [
            { id: "1", name: "product", value: "Product mentioned", type: "string" },
            { id: "2", name: "amount", value: "Amount paid", type: "number" },
          ],
        },
      },
    ]);
    const svc = services((req) => {
      const sys = req.system ?? "";
      const m = (req.messages[0]!.content[0] as { text: string }).text;
      if (sys.includes("moderator")) return json({ flagged: m.includes("idiot"), categories: m.includes("idiot") ? ["harassment"] : [], reason: "r" });
      if (sys.includes("sentiment")) return json({ sentiment: "positive", confidence: 0.8, explanation: "e" });
      return json({ product: "Widget", amount: null });
    });
    const r = await run(g, [{ json: { m: "Love the Widget" } }, { json: { m: "you idiot" } }], svc);
    expect(r.status).toBe("success");
    expect(r.state.outputs.bad).toHaveLength(1);
    expect(r.state.lastOutput[0]!.json).toMatchObject({ mood: { sentiment: "positive" }, ai: { product: "Widget", amount: null } });
  });

  it("fails clearly on non-JSON or truncated answers", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["s"] } },
      { id: "s", type: "ai.sentiment", parameters: { text: "hi" } },
    ]);
    const bad = await run(g, [{ json: {} }], services(() => reply([text("not json")])));
    expect(bad.status === "failed" && bad.error.message).toMatch(/valid JSON/);
    const cut = await run(g, [{ json: {} }], services(() => reply([text("{")], "max_tokens")));
    expect(cut.status === "failed" && cut.error.message).toMatch(/cut off/);
  });
});

describe("calculator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["-4 + 10 / 4", -1.5],
    ["round(2.345, 2)", 2.35],
    ["max(1, sqrt(16), 3)", 4],
    ["12 × 3 ÷ 4", 9],
    ["1,234 + 1", 1235],
  ])("%s = %d", (expr, value) => expect(calculate(expr)).toBeCloseTo(value as number));

  it.each(["1/0", "2 +", "process.exit()", "constructor", "(1", "1 2"])("rejects %s", (expr) => {
    expect(() => calculate(expr)).toThrow();
  });
});
