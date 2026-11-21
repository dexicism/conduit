import { describe, expect, it } from "vitest";
import {
  createWorkflowInputSchema,
  emptyGraph,
  listWorkflowsQuerySchema,
  updateWorkflowInputSchema,
  validateGraphStructure,
  workflowGraphSchema,
  type WorkflowGraph,
} from "./workflow";

describe("createWorkflowInputSchema", () => {
  it("trims and accepts a valid name", () => {
    expect(createWorkflowInputSchema.parse({ name: "  Lead router  " }).name).toBe("Lead router");
  });

  it("rejects empty and whitespace-only names", () => {
    expect(createWorkflowInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createWorkflowInputSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects names over 150 characters", () => {
    expect(createWorkflowInputSchema.safeParse({ name: "a".repeat(151) }).success).toBe(false);
    expect(createWorkflowInputSchema.safeParse({ name: "a".repeat(150) }).success).toBe(true);
  });

  it("requires requestId to be a UUID when present", () => {
    expect(createWorkflowInputSchema.safeParse({ name: "x", requestId: "nope" }).success).toBe(false);
    expect(
      createWorkflowInputSchema.safeParse({ name: "x", requestId: "3f1c2b8e-6a4d-4d3b-9c1e-0a5b7e2d9f10" }).success,
    ).toBe(true);
  });
});

describe("updateWorkflowInputSchema", () => {
  it("rejects an empty patch", () => {
    expect(updateWorkflowInputSchema.safeParse({}).success).toBe(false);
  });
  it("allows clearing the description with null", () => {
    expect(updateWorkflowInputSchema.parse({ description: null })).toEqual({ description: null });
  });
});

describe("listWorkflowsQuerySchema", () => {
  it("applies defaults and coerces limit", () => {
    expect(listWorkflowsQuerySchema.parse({})).toEqual({ filter: "active", limit: 20 });
    expect(listWorkflowsQuerySchema.parse({ limit: "5" }).limit).toBe(5);
  });
  it("clamps invalid limits by rejecting them", () => {
    expect(listWorkflowsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listWorkflowsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("validateGraphStructure", () => {
  const base = (): WorkflowGraph =>
    workflowGraphSchema.parse({
      nodes: [
        { id: "start", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 }, connections: { main: [{ targetId: "a" }] } },
        { id: "a", type: "core.set", label: "Set", position: { x: 200, y: 0 } },
      ],
    });

  it("accepts an empty graph", () => {
    expect(validateGraphStructure(emptyGraph())).toEqual([]);
  });

  it("accepts a valid graph", () => {
    expect(validateGraphStructure(base())).toEqual([]);
  });

  it("reports duplicate IDs", () => {
    const g = base();
    g.nodes.push({ ...g.nodes[1]! });
    expect(validateGraphStructure(g).some((i) => i.message.includes("Duplicate"))).toBe(true);
  });

  it("reports dangling and self connections", () => {
    const g = base();
    g.nodes[1]!.connections = { main: [{ targetId: "ghost" }, { targetId: "a" }] };
    const messages = validateGraphStructure(g).map((i) => i.message);
    expect(messages.some((m) => m.includes("missing node \"ghost\""))).toBe(true);
    expect(messages.some((m) => m.includes("connects to itself"))).toBe(true);
  });

  it("rejects node IDs with unsafe characters", () => {
    const r = workflowGraphSchema.safeParse({
      nodes: [{ id: "a b", type: "x", label: "x", position: { x: 0, y: 0 } }],
    });
    expect(r.success).toBe(false);
  });
});
