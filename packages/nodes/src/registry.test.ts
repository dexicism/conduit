import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { describe, expect, it } from "vitest";
import {
  canConnect,
  defaultParameters,
  getDefinition,
  isFieldVisible,
  isValidCron,
  NODE_DEFINITIONS,
  nodeIssues,
  outputsOf,
  searchDefinitions,
  uniqueLabel,
  uniqueNodeId,
  upstreamNodeIds,
  validateGraphWithRegistry,
  validateNodeParameters,
} from "./registry";

function graph(nodes: Array<Partial<WorkflowGraph["nodes"][number]> & { id: string; type: string }>): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => {
      const def = getDefinition(n.type);
      return { label: n.id, position: { x: i * 200, y: 0 }, parameters: def ? defaultParameters(def) : {}, ...n };
    }),
  });
}

describe("definitions", () => {
  it("have unique types and valid field defaults", () => {
    const types = NODE_DEFINITIONS.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const d of NODE_DEFINITIONS) {
      const names = d.fields.map((f) => f.name);
      expect(new Set(names).size, d.type).toBe(names.length);
      for (const f of d.fields) {
        if (f.showIf) expect(names, `${d.type}.${f.name}`).toContain(f.showIf.field);
      }
    }
  });

  it("triggers have no inputs; other nodes have at least one", () => {
    for (const d of NODE_DEFINITIONS) {
      if (d.category === "trigger") expect(d.inputs).toEqual([]);
      else expect(d.inputs.length).toBeGreaterThan(0);
    }
  });

  it("webhook gets a unique random path on creation", () => {
    const def = getDefinition("trigger.webhook")!;
    const a = defaultParameters(def).path;
    const b = defaultParameters(def).path;
    expect(a).toMatch(/^[a-z0-9]{16}$/);
    expect(a).not.toBe(b);
  });

  it("search matches names and keywords", () => {
    expect(searchDefinitions("api").map((d) => d.type)).toContain("core.http");
    expect(searchDefinitions("cron").map((d) => d.type)).toEqual(["trigger.schedule"]);
    expect(searchDefinitions("", "trigger").every((d) => d.category === "trigger")).toBe(true);
  });
});

describe("switch outputs", () => {
  it("derives one handle per case plus fallback", () => {
    const def = getDefinition("flow.switch")!;
    const outs = outputsOf(def, { cases: [{ id: "a1", value: "admin" }, { id: "b2", value: "guest", label: "Guests" }], fallback: true });
    expect(outs).toEqual([
      { id: "case-a1", label: "admin" },
      { id: "case-b2", label: "Guests" },
      { id: "fallback", label: "fallback" },
    ]);
    expect(outputsOf(def, { cases: [], fallback: false })).toEqual([]);
  });
});

describe("parameter validation", () => {
  it("requires visible required fields only", () => {
    const def = getDefinition("trigger.schedule")!;
    const p = defaultParameters(def);
    expect(validateNodeParameters(def, p)).toEqual([]); // interval mode: cron hidden
    expect(validateNodeParameters(def, { ...p, mode: "cron" }).map((i) => i.field)).toEqual(["cron"]);
    expect(validateNodeParameters(def, { ...p, mode: "cron", cron: "0 9 * * 1-5" })).toEqual([]);
  });

  it("hides fields whose controlling field is itself hidden", () => {
    const def = getDefinition("core.http")!;
    const jsonBody = def.fields.find((f) => f.name === "jsonBody")!;
    const get = { ...defaultParameters(def), method: "GET", bodyType: "json" };
    expect(isFieldVisible(jsonBody, get)).toBe(false);
    expect(isFieldVisible(jsonBody, { ...get, method: "POST" })).toBe(true);
    // Hidden fields are not validated.
    expect(validateNodeParameters(def, { ...get, url: "https://x.test", jsonBody: "{bad" })).toEqual([]);
  });

  it("checks URL, JSON and numbers but allows references", () => {
    const def = getDefinition("core.http")!;
    const p = { ...defaultParameters(def), method: "POST", url: "example.com", jsonBody: "{bad" };
    const fields = validateNodeParameters(def, p).map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["url", "jsonBody"]));
    const ok = { ...p, url: "${['$input']['url']}", jsonBody: '{"a": ${[\'$input\'][\'x\']}}' };
    expect(validateNodeParameters(def, ok)).toEqual([]);
    expect(validateNodeParameters(def, { ...ok, timeoutSeconds: 0 }).map((i) => i.field)).toEqual(["timeoutSeconds"]);
  });

  it("rejects references in literal-only fields", () => {
    const def = getDefinition("trigger.webhook")!;
    const issues = validateNodeParameters(def, { ...defaultParameters(def), path: "${['$input']['x']}" });
    expect(issues[0]?.message).toMatch(/can't use references/);
  });

  it("validates conditions, cases and assignments", () => {
    expect(validateNodeParameters(getDefinition("flow.if")!, defaultParameters(getDefinition("flow.if")!))[0]?.message).toMatch(/needs a value/);
    const sw = getDefinition("flow.switch")!;
    expect(validateNodeParameters(sw, { ...defaultParameters(sw), value: "x" })[0]?.message).toMatch(/Every case/);
    const set = getDefinition("core.set")!;
    const dup = { assignments: [{ id: "1", name: "a", value: "", type: "string" }, { id: "2", name: "a", value: "", type: "string" }] };
    expect(validateNodeParameters(set, dup)[0]?.message).toMatch(/unique/);
  });
});

describe("isValidCron", () => {
  it.each(["* * * * *", "0 9 * * 1-5", "*/15 * * * *", "0 0 1,15 * *", "5/5 * * * 0", "30 23 31 12 7"])("accepts %s", (c) =>
    expect(isValidCron(c)).toBe(true),
  );
  it.each(["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a * * * *"])(
    "rejects %s",
    (c) => expect(isValidCron(c)).toBe(false),
  );
});

describe("connections", () => {
  const g = graph([
    { id: "t", type: "trigger.manual", connections: { main: [{ targetId: "loop" }] } },
    { id: "loop", type: "flow.loop", connections: { loop: [{ targetId: "body" }] } },
    { id: "body", type: "core.set" },
    { id: "other", type: "core.http" },
  ]);

  it("allows normal edges and loop-back edges", () => {
    expect(canConnect(g, { source: "body", sourceHandle: "main", target: "other", targetHandle: "main" }).ok).toBe(true);
    expect(canConnect(g, { source: "body", sourceHandle: "main", target: "loop", targetHandle: "main" }).ok).toBe(true);
  });

  it("rejects self, trigger inputs, duplicates, unknown handles and cycles", () => {
    expect(canConnect(g, { source: "body", sourceHandle: "main", target: "body", targetHandle: "main" }).ok).toBe(false);
    expect(canConnect(g, { source: "body", sourceHandle: "main", target: "t", targetHandle: "main" }).reason).toMatch(/Triggers/);
    expect(canConnect(g, { source: "t", sourceHandle: "main", target: "loop", targetHandle: "main" }).reason).toMatch(/Already/);
    expect(canConnect(g, { source: "loop", sourceHandle: "nope", target: "other", targetHandle: "main" }).ok).toBe(false);
    const g2 = graph([
      { id: "a", type: "core.set", connections: { main: [{ targetId: "b" }] } },
      { id: "b", type: "core.set" },
    ]);
    expect(canConnect(g2, { source: "b", sourceHandle: "main", target: "a", targetHandle: "main" }).reason).toMatch(/cycle/);
  });

  it("graph validation accepts loop-backs and flags real cycles and bad handles", () => {
    const withLoopBack = graph([
      { id: "loop", type: "flow.loop", connections: { loop: [{ targetId: "body" }] } },
      { id: "body", type: "core.set", connections: { main: [{ targetId: "loop" }] } },
    ]);
    expect(validateGraphWithRegistry(withLoopBack)).toEqual([]);
    const cyclic = graph([
      { id: "a", type: "core.set", connections: { main: [{ targetId: "b" }] } },
      { id: "b", type: "core.set", connections: { main: [{ targetId: "a" }] } },
    ]);
    expect(validateGraphWithRegistry(cyclic)[0]?.message).toMatch(/cycle/);
    const bad = graph([
      { id: "a", type: "flow.if", connections: { main: [{ targetId: "b" }] } },
      { id: "b", type: "trigger.manual" },
      { id: "c", type: "does.not.exist" },
    ]);
    const msgs = validateGraphWithRegistry(bad).map((i) => i.message);
    expect(msgs.some((m) => m.includes('no output "main"'))).toBe(true);
    expect(msgs.some((m) => m.includes("trigger"))).toBe(true);
    expect(msgs.some((m) => m.includes("Unknown step type"))).toBe(true);
  });
});

describe("references", () => {
  const g = graph([
    { id: "t", type: "trigger.webhook", connections: { main: [{ targetId: "a" }] } },
    { id: "a", type: "core.set", connections: { main: [{ targetId: "b" }] } },
    { id: "b", type: "transform.text" },
    { id: "lonely", type: "transform.text" },
  ]);

  it("lists upstream nodes nearest first", () => {
    expect(upstreamNodeIds(g, "b")).toEqual(["a", "t"]);
    expect(upstreamNodeIds(g, "t")).toEqual([]);
  });

  it("flags references to non-upstream or deleted steps and $input without a parent", () => {
    const b = { ...g.nodes[2]!, parameters: { ...g.nodes[2]!.parameters, value: "${['t']['body']} ${['lonely']['x']} ${['gone']['y']}" } };
    const msgs = nodeIssues(g, b).map((i) => i.message);
    expect(msgs.some((m) => m.includes("doesn't run before"))).toBe(true);
    expect(msgs.some((m) => m.includes("deleted step"))).toBe(true);
    const lonely = { ...g.nodes[3]!, parameters: { ...g.nodes[3]!.parameters, value: "${['$input']['x']}" } };
    expect(nodeIssues(g, lonely).some((i) => i.message.includes("nothing is connected"))).toBe(true);
  });
});

describe("agent tools", () => {
  const g = graph([
    { id: "t", type: "trigger.manual", connections: { main: [{ targetId: "agent" }] } },
    { id: "agent", type: "ai.agent", connections: { tool: [{ targetId: "calc", targetHandle: "agent" }] } },
    { id: "calc", type: "tool.calculator" },
    { id: "think", type: "tool.think" },
    { id: "set", type: "core.set" },
  ]);

  it("tools connect only to an agent's tool port", () => {
    expect(canConnect(g, { source: "agent", sourceHandle: "tool", target: "think", targetHandle: "agent" }).ok).toBe(true);
    expect(canConnect(g, { source: "agent", sourceHandle: "tool", target: "set", targetHandle: "main" }).ok).toBe(false);
    expect(canConnect(g, { source: "agent", sourceHandle: "main", target: "think", targetHandle: "agent" }).ok).toBe(false);
    expect(canConnect(g, { source: "set", sourceHandle: "tool", target: "think", targetHandle: "agent" }).ok).toBe(false);
    // A tool belongs to one agent.
    expect(canConnect(g, { source: "agent", sourceHandle: "tool", target: "calc", targetHandle: "agent" }).ok).toBe(false);
    expect(validateGraphWithRegistry(g)).toEqual([]);
  });

  it("flags orphan tools, duplicate tool names and self references", () => {
    expect(nodeIssues(g, g.nodes.find((n) => n.id === "think")!).some((i) => /Connect this tool/.test(i.message))).toBe(true);
    const dup = graph([
      { id: "agent", type: "ai.agent", parameters: { prompt: "x" }, connections: { tool: [{ targetId: "a", targetHandle: "agent" }, { targetId: "b", targetHandle: "agent" }] } },
      { id: "a", type: "tool.calculator" },
      { id: "b", type: "tool.calculator" },
    ]);
    expect(nodeIssues(dup, dup.nodes[0]!).some((i) => /named "calculator"/.test(i.message))).toBe(true);
    const selfRef = { ...dup.nodes[1]!, parameters: { ...dup.nodes[1]!.parameters, toolDescription: "${['agent']['output']}" } };
    expect(nodeIssues({ ...dup, nodes: [dup.nodes[0]!, selfRef, dup.nodes[2]!] }, selfRef).some((i) => /own agent/.test(i.message))).toBe(true);
  });

  it("classifier outputs follow its categories", () => {
    const def = getDefinition("ai.classify")!;
    expect(outputsOf(def, { categories: [{ id: "x", value: "billing" }], allowOther: true }).map((o) => o.id)).toEqual(["case-x", "other"]);
  });
});

describe("ids and labels", () => {
  it("generates unique readable IDs and labels", () => {
    expect(uniqueNodeId([], "HTTP request")).toBe("node-http-request");
    expect(uniqueNodeId(["node-http-request"], "HTTP request")).toBe("node-http-request-2");
    expect(uniqueLabel(["If", "If 2"], "If")).toBe("If 3");
  });
});
