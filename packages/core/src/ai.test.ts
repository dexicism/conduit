import { describe, expect, it } from "vitest";
import { aiFillSchema, buildAiFill, collectAiFills, fillAiPlaceholders, parseAiFills } from "./ai-fill";
import { applyChangeSet, changeSetSchema, ChangeSetError } from "./change-set";
import { workflowGraphSchema } from "./workflow";

describe("AI-fill placeholders", () => {
  it("parses key, description and type", () => {
    const v = "https://api.test/weather?q=" + buildAiFill("city", "City name, e.g. `Paris`") + "&d=" + buildAiFill("days", "How many days", "number");
    const slots = parseAiFills(v);
    expect(slots.map((s) => [s.key, s.type])).toEqual([
      ["city", "string"],
      ["days", "number"],
    ]);
    expect(slots[0]!.description).toBe("City name, e.g. `Paris`");
  });

  it("collects distinct slots deeply and builds a strict schema", () => {
    const params = { url: buildAiFill("q", "Query"), headers: [{ key: "x", value: buildAiFill("q", "dup") }], n: buildAiFill("n", "Count", "number") };
    const slots = collectAiFills(params);
    expect(slots).toEqual([
      { key: "q", description: "Query", type: "string" },
      { key: "n", description: "Count", type: "number" },
    ]);
    expect(aiFillSchema(slots)).toEqual({
      type: "object",
      properties: { q: { type: "string", description: "Query" }, n: { type: "number", description: "Count" } },
      required: ["q", "n"],
      additionalProperties: false,
    });
  });

  it("fills placeholders, keeping types for whole-value slots", () => {
    const params = { url: `https://x/?q=${buildAiFill("q", "Q")}`, count: buildAiFill("n", "N", "number"), plain: "keep" };
    expect(fillAiPlaceholders(params, { q: "a b", n: 3 })).toEqual({ url: "https://x/?q=a b", count: 3, plain: "keep" });
  });
});

describe("change sets", () => {
  const base = workflowGraphSchema.parse({
    nodes: [
      { id: "t", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 }, connections: { main: [{ targetId: "a" }] } },
      { id: "a", type: "core.set", label: "A", position: { x: 260, y: 0 }, parameters: { keep: 1, drop: 2 } },
    ],
  });

  it("adds, updates and deletes, removing dangling edges", () => {
    const cs = changeSetSchema.parse({
      response: "Done",
      nodes: [{ id: "node-b", type: "core.http", label: "Call", parameters: { url: "https://x" } }],
      updates: [{ id: "a", label: "A2", parameters: { drop: null, add: 3 }, connections: { main: [{ targetId: "node-b" }] } }],
      deleted: [],
    });
    const { graph, summary } = applyChangeSet(base, cs);
    expect(summary).toEqual({ added: ["node-b"], updated: ["a"], deleted: [] });
    const a = graph.nodes.find((n) => n.id === "a")!;
    expect(a.label).toBe("A2");
    expect(a.parameters).toEqual({ keep: 1, add: 3 });
    expect(a.connections.main).toEqual([{ targetId: "node-b" }]);
    expect(graph.nodes.find((n) => n.id === "node-b")!.position.x).toBe(520);

    const del = applyChangeSet(base, changeSetSchema.parse({ response: "x", deleted: ["a"] }));
    expect(del.graph.nodes.map((n) => n.id)).toEqual(["t"]);
    expect(del.graph.nodes[0]!.connections).toEqual({});
  });

  it("rejects unknown and duplicate IDs", () => {
    expect(() => applyChangeSet(base, changeSetSchema.parse({ response: "x", deleted: ["ghost"] }))).toThrow(ChangeSetError);
    expect(() => applyChangeSet(base, changeSetSchema.parse({ response: "x", updates: [{ id: "ghost" }] }))).toThrow(/no such step/);
    expect(() =>
      applyChangeSet(base, changeSetSchema.parse({ response: "x", nodes: [{ id: "a", type: "core.set", label: "dup" }] })),
    ).toThrow(/already exists/);
  });

  it("does not mutate the input graph", () => {
    const before = JSON.stringify(base);
    applyChangeSet(base, changeSetSchema.parse({ response: "x", deleted: ["a"] }));
    expect(JSON.stringify(base)).toBe(before);
  });
});
