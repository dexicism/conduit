import { emptyGraph, workflowGraphSchema } from "@conduit/core";
import type { LlmBlock, LlmRequest, LlmResult, LlmService } from "@conduit/engine";
import { validateGraphWithRegistry } from "@conduit/nodes";
import { describe, expect, it } from "vitest";
import { BUILDER_TOOL_NAMES, runBuilder } from "./builder";
import { createFakeLlm } from "./llm-fake";

const r = (content: LlmBlock[], stopReason: LlmResult["stopReason"] = "end_turn"): LlmResult => ({
  content,
  stopReason,
  model: "m",
  usage: { inputTokens: 0, outputTokens: 0 },
});

function scripted(turns: Array<(req: LlmRequest) => LlmResult>): LlmService & { seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  let i = 0;
  return {
    seen,
    async chat(req) {
      seen.push(structuredClone(req));
      return turns[Math.min(i++, turns.length - 1)]!(req);
    },
  };
}

describe("builder", () => {
  it("applies the fake model's scaffold and the result validates", async () => {
    const out = await runBuilder({
      llm: createFakeLlm(),
      model: "m",
      graph: emptyGraph(),
      history: [],
      message: "When a webhook arrives, check the sentiment and respond",
    });
    expect(out.applied).not.toBeNull();
    const g = out.applied!.graph;
    expect(g.nodes.map((n) => n.type)).toEqual(["trigger.webhook", "ai.sentiment", "core.respond"]);
    expect(validateGraphWithRegistry(g)).toEqual([]);
    expect(out.response).toMatch(/Built the workflow/);
  });

  it("feeds validation errors back until the change set is valid", async () => {
    const base = workflowGraphSchema.parse({
      nodes: [{ id: "t", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 } }],
    });
    const llm = scripted([
      () => r([{ type: "tool_use", id: "1", name: BUILDER_TOOL_NAMES.describe, input: { type: "core.http" } }], "tool_use"),
      () =>
        r(
          [
            {
              type: "tool_use",
              id: "2",
              name: BUILDER_TOOL_NAMES.save,
              input: { response: "x", nodes: [{ id: "node-x", type: "does.not.exist", label: "X" }] },
            },
          ],
          "tool_use",
        ),
      () =>
        r(
          [
            {
              type: "tool_use",
              id: "3",
              name: BUILDER_TOOL_NAMES.save,
              // A tool wired into the main flow is rejected by the registry rules.
              input: {
                response: "x",
                nodes: [{ id: "node-calc", type: "tool.calculator", label: "Calc" }],
                updates: [{ id: "t", connections: { main: [{ targetId: "node-calc", targetHandle: "agent" }] } }],
              },
            },
          ],
          "tool_use",
        ),
      () =>
        r(
          [
            {
              type: "tool_use",
              id: "4",
              name: BUILDER_TOOL_NAMES.save,
              input: {
                response: "Added an HTTP call.",
                nodes: [{ id: "node-call", type: "core.http", label: "Call API", parameters: { method: "GET", url: "https://api.example.com" } }],
                updates: [{ id: "t", connections: { main: [{ targetId: "node-call" }] } }],
              },
            },
          ],
          "tool_use",
        ),
      () => r([{ type: "text", text: "Added an HTTP call after Start." }]),
    ]);
    const out = await runBuilder({ llm, model: "m", graph: base, history: [{ role: "user", text: "earlier" }], message: "Call our API" });

    const resultsOf = (i: number) => llm.seen[i]!.messages.at(-1)!.content[0] as Extract<LlmBlock, { type: "tool_result" }>;
    expect(JSON.parse(resultsOf(1).content).parameters.some((p: { name: string }) => p.name === "url")).toBe(true);
    expect(resultsOf(2)).toMatchObject({ isError: true, content: expect.stringMatching(/Unknown step types: does.not.exist/) });
    expect(resultsOf(3)).toMatchObject({ isError: true, content: expect.stringMatching(/agent tool/) });
    expect(resultsOf(4).isError).toBeUndefined();

    expect(out.response).toBe("Added an HTTP call after Start.");
    expect(out.applied!.summary).toEqual({ added: ["node-call"], updated: ["t"], deleted: [] });
    expect(out.applied!.graph.nodes[0]!.connections.main).toEqual([{ targetId: "node-call" }]);
    // The current canvas and history are sent; the save tool isn't strict (free-form parameters).
    expect(llm.seen[0]!.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "earlier" }] });
    expect(llm.seen[0]!.tools!.find((t) => t.name === BUILDER_TOOL_NAMES.save)!.strict).toBe(false);
  });

  it("answers questions without changing anything", async () => {
    const llm = scripted([() => r([{ type: "text", text: "A webhook starts a workflow from an HTTP request." }])]);
    const out = await runBuilder({ llm, model: "m", graph: emptyGraph(), history: [], message: "What does a webhook do?" });
    expect(out.applied).toBeNull();
    expect(out.response).toMatch(/HTTP request/);
  });
});
