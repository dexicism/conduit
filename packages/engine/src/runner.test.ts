import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { describe, expect, it, vi } from "vitest";
import { nextCronRun, nextScheduleRun } from "./cron";
import { initialState, runExecution, type EngineState } from "./runner";
import type { EngineServices, Item, StepRecord } from "./types";

type N = { id: string; type: string; parameters?: Record<string, unknown>; to?: Record<string, string[] | Array<{ targetId: string; targetHandle?: string }>>; onError?: "stop" | "continue"; disabled?: boolean };

function graph(nodes: N[]): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => {
      const def = getDefinition(n.type);
      const connections = Object.fromEntries(
        Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => (typeof t === "string" ? { targetId: t } : t))]),
      );
      return {
        id: n.id,
        type: n.type,
        label: n.id,
        position: { x: i * 100, y: 0 },
        parameters: { ...(def ? defaultParameters(def) : {}), ...n.parameters },
        connections,
        onError: n.onError,
        disabled: n.disabled,
      };
    }),
  });
}

let clock = new Date("2026-01-01T00:00:00Z");
function services(over: Partial<EngineServices> = {}): EngineServices {
  return {
    http: vi.fn(async () => ({ status: 200, headers: {}, body: { ok: true } })),
    runCode: vi.fn(async ({ items }) => ({ items: items.map((i: Item) => ({ ...i.json, coded: true })), logs: ["hi"] })),
    executeWorkflow: vi.fn(async () => [{ json: { child: 1 } }]),
    now: () => clock,
    ...over,
  };
}

async function run(g: WorkflowGraph, items: Item[], svc = services(), state?: EngineState) {
  const steps: StepRecord[] = [];
  const out = await runExecution({ graph: g, state: state ?? initialState(g, g.nodes[0]!.id, items), services: svc, hooks: { onStep: (r) => void steps.push(r) } });
  return { ...out, steps };
}

const set = (assign: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  assignments: Object.entries(assign).map(([name, value], i) => ({ id: String(i), name, value, type: "string" })),
  ...extra,
});

describe("runner basics", () => {
  it("runs a linear chain and resolves references to earlier steps and $input", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["a"] } },
      { id: "a", type: "core.set", parameters: set({ greeting: "Hi ${['$input']['name']}" }), to: { main: ["b"] } },
      { id: "b", type: "core.set", parameters: set({ fromTrigger: "${['t']['name']}", fromA: "${['a']['greeting']}" }) },
    ]);
    const r = await run(g, [{ json: { name: "Ada" } }]);
    expect(r.status).toBe("success");
    expect(r.state.lastOutput[0]!.json).toMatchObject({ name: "Ada", greeting: "Hi Ada", fromTrigger: "Ada", fromA: "Hi Ada" });
    expect(r.steps.map((s) => s.nodeId)).toEqual(["t", "a", "b"]);
  });

  it("processes every item and pairs references by index", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["a"] } },
      { id: "a", type: "transform.text", parameters: { value: "${['$input']['n']}", operation: "upper", outputField: "u" } },
    ]);
    const r = await run(g, [{ json: { n: "x" } }, { json: { n: "y" } }]);
    expect(r.state.lastOutput.map((i) => i.json.u)).toEqual(["X", "Y"]);
  });

  it("routes If branches and skips branches with no items", async () => {
    const rule = { combinator: "and", rules: [{ id: "1", left: "${['$input']['age']}", operator: "gte", right: "18" }] };
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["if"] } },
      { id: "if", type: "flow.if", parameters: { conditions: rule }, to: { true: ["adult"], false: ["minor"] } },
      { id: "adult", type: "core.set", parameters: set({ kind: "adult" }) },
      { id: "minor", type: "core.set", parameters: set({ kind: "minor" }) },
    ]);
    const r = await run(g, [{ json: { age: 30 } }, { json: { age: 12 } }, { json: { age: "18" } }]);
    expect(r.status).toBe("success");
    expect(r.state.outputs.adult!.map((i) => i.json.age)).toEqual([30, "18"]);
    expect(r.state.outputs.minor!.map((i) => i.json.age)).toEqual([12]);

    const onlyAdults = await run(g, [{ json: { age: 40 } }]);
    expect(onlyAdults.steps.map((s) => s.nodeId)).toEqual(["t", "if", "adult"]);
  });

  it("routes Switch cases with fallback and filters items", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["sw"] } },
      {
        id: "sw",
        type: "flow.switch",
        parameters: { value: "${['$input']['role']}", cases: [{ id: "a", value: "admin" }], fallback: true },
        to: { "case-a": ["admins"], fallback: ["filter"] },
      },
      { id: "admins", type: "core.set", parameters: set({ x: "1" }) },
      {
        id: "filter",
        type: "flow.filter",
        parameters: { conditions: { combinator: "and", rules: [{ id: "1", left: "${['$input']['role']}", operator: "equals", right: "guest" }] } },
      },
    ]);
    const r = await run(g, [{ json: { role: "admin" } }, { json: { role: "guest" } }, { json: { role: "bot" } }]);
    expect(r.state.outputs.admins).toHaveLength(1);
    expect(r.state.outputs.filter!.map((i) => i.json.role)).toEqual(["guest"]);
  });
});

describe("loops and merges", () => {
  it("iterates with a loop-back edge and returns collected results on done", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["loop"] } },
      { id: "loop", type: "flow.loop", parameters: { mode: "list", list: "${['$input']['xs']}", batchSize: 1 }, to: { loop: ["body"], done: ["after"] } },
      { id: "body", type: "core.set", parameters: set({ doubled: "${['$input']['item']}${['$input']['item']}" }), to: { main: ["loop"] } },
      { id: "after", type: "transform.list", parameters: { list: "[]", operation: "length", outputField: "n" } },
    ]);
    const r = await run(g, [{ json: { xs: ["a", "b", "c"] } }]);
    expect(r.status).toBe("success");
    const bodyRuns = r.steps.filter((s) => s.nodeId === "body");
    expect(bodyRuns.map((s) => s.output.main![0]!.json.doubled)).toEqual(["aa", "bb", "cc"]);
    const loopDone = r.steps.filter((s) => s.nodeId === "loop").pop()!;
    expect(loopDone.output.done!.map((i) => i.json.doubled)).toEqual(["aa", "bb", "cc"]);
    // The step after the loop runs once, receiving one item per collected result.
    const after = r.steps.filter((s) => s.nodeId === "after");
    expect(after).toHaveLength(1);
    expect(after[0]!.input).toHaveLength(3);
  });

  it("without a loop-back edge emits all elements at once, then done", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["loop"] } },
      { id: "loop", type: "flow.loop", parameters: { mode: "count", count: 3 }, to: { loop: ["body"], done: ["after"] } },
      { id: "body", type: "core.set", parameters: set({}) },
      { id: "after", type: "core.set", parameters: set({}) },
    ]);
    const r = await run(g, [{ json: { a: 1 } }]);
    expect(r.state.outputs.body).toHaveLength(3);
    expect(r.state.outputs.after).toEqual([{ json: { a: 1 } }]);
  });

  it("rejects a non-list for list loops", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["loop"] } },
      { id: "loop", type: "flow.loop", parameters: { mode: "list", list: "${['$input']['nope']}" } },
    ]);
    const r = await run(g, [{ json: {} }]);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error.message).toMatch(/must be a list/);
  });

  it("merges two branches, and flushes when one branch never arrives", async () => {
    const yes = { combinator: "and", rules: [{ id: "1", left: "${['$input']['go']}", operator: "isTrue", right: "" }] };
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["a", "if"] } },
      { id: "a", type: "core.set", parameters: set({ from: "a" }), to: { main: [{ targetId: "m", targetHandle: "a" }] } },
      { id: "if", type: "flow.if", parameters: { conditions: yes }, to: { true: [{ targetId: "m", targetHandle: "b" }] } },
      { id: "m", type: "flow.merge", parameters: { mode: "append" } },
    ]);
    const both = await run(g, [{ json: { go: true } }]);
    expect(both.state.outputs.m).toHaveLength(2);
    const one = await run(g, [{ json: { go: false } }]);
    expect(one.status).toBe("success");
    expect(one.state.outputs.m).toEqual([{ json: { go: false, from: "a" } }]);
  });
});

describe("wait, errors, services", () => {
  it("pauses on Wait and resumes when due", async () => {
    clock = new Date("2026-01-01T00:00:00Z");
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["w"] } },
      { id: "w", type: "flow.wait", parameters: { mode: "duration", amount: 5, unit: "minutes" }, to: { main: ["after"] } },
      { id: "after", type: "core.set", parameters: set({ done: "yes" }) },
    ]);
    const first = await run(g, [{ json: {} }]);
    expect(first.status).toBe("waiting");
    if (first.status !== "waiting") return;
    expect(first.resumeAt.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    const persisted = JSON.parse(JSON.stringify(first.state)) as EngineState; // must survive storage

    const early = await run(g, [], services(), persisted);
    expect(early.status).toBe("waiting");

    clock = new Date("2026-01-01T00:05:01Z");
    const resumed = await run(g, [], services(), JSON.parse(JSON.stringify(persisted)));
    expect(resumed.status).toBe("success");
    expect(resumed.state.outputs.after![0]!.json.done).toBe("yes");
  });

  it("stops on error by default, continues when configured", async () => {
    const http = vi.fn(async () => ({ status: 500, headers: {}, body: "boom" }));
    const mk = (onError?: "continue") =>
      graph([
        { id: "t", type: "trigger.manual", to: { main: ["h"] } },
        { id: "h", type: "core.http", parameters: { url: "https://api.test/x" }, onError, to: { main: ["after"] } },
        { id: "after", type: "core.set", parameters: set({}) },
      ]);
    const stopped = await run(mk(), [{ json: {} }], services({ http }));
    expect(stopped.status).toBe("failed");
    if (stopped.status === "failed") expect(stopped.error).toMatchObject({ nodeId: "h", message: expect.stringMatching(/status 500/) });
    const cont = await run(mk("continue"), [{ json: {} }], services({ http }));
    expect(cont.status).toBe("success");
    expect(cont.state.outputs.after![0]!.json.error).toMatch(/status 500/);
  });

  it("builds HTTP requests from parameters", async () => {
    const http = vi.fn(async () => ({ status: 201, headers: { a: "b" }, body: { id: 7 } }));
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["h"] } },
      {
        id: "h",
        type: "core.http",
        parameters: {
          method: "POST",
          url: "https://api.test/users",
          query: [{ key: "q", value: "${['$input']['q']}" }],
          headers: [{ key: "x-k", value: "v" }],
          bodyType: "json",
          jsonBody: '{"name": "${[\'$input\'][\'name\']}"}',
        },
      },
    ]);
    const r = await run(g, [{ json: { q: "a b", name: "Ada" } }], services({ http }));
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://api.test/users?q=a+b",
        headers: { "x-k": "v", "content-type": "application/json" },
        body: '{"name":"Ada"}',
      }),
    );
    expect(r.state.lastOutput[0]!.json).toEqual({ status: 201, headers: { a: "b" }, body: { id: 7 } });
  });

  it("uses the code service, captures logs, and passes disabled steps through", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["c"] } },
      { id: "c", type: "core.code", to: { main: ["off"] } },
      { id: "off", type: "transform.text", disabled: true, parameters: { value: "x", operation: "upper" } },
    ]);
    const r = await run(g, [{ json: { a: 1 } }]);
    expect(r.state.lastOutput).toEqual([{ json: { a: 1, coded: true } }]);
    expect(r.steps.find((s) => s.nodeId === "c")!.logs).toEqual(["hi"]);
  });

  it("records the webhook response from a Respond step", async () => {
    const g = graph([
      { id: "t", type: "trigger.webhook", to: { main: ["r"] } },
      { id: "r", type: "core.respond", parameters: { status: 201, headers: [{ key: "X-A", value: "1" }], body: '{"got": "${[\'$input\'][\'body\'][\'v\']}"}' } },
    ]);
    const r = await run(g, [{ json: { body: { v: "hello" } } }]);
    expect(r.state.response).toEqual({ status: 201, headers: { "x-a": "1" }, body: { got: "hello" } });
  });
});

describe("transforms", () => {
  const one = async (type: string, parameters: Record<string, unknown>, json: Record<string, unknown> = {}) => {
    const g = graph([{ id: "t", type: "trigger.manual", to: { main: ["x"] } }, { id: "x", type, parameters: { outputField: "r", ...parameters } }]);
    const r = await run(g, [{ json }]);
    if (r.status === "failed") throw new Error(r.error.message);
    return r.state.lastOutput[0]!.json.r;
  };

  it("text, math, json, list, crypto, date", async () => {
    expect(await one("transform.text", { value: "a-b-c", operation: "replace", search: "-", replaceWith: "+" })).toBe("a+b+c");
    expect(await one("transform.math", { a: "${['$input']['p']}", operation: "multiply", b: "1.1" }, { p: 10 })).toBeCloseTo(11);
    expect(await one("transform.math", { a: "2.345", operation: "round", decimals: 2 })).toBe(2.35);
    await expect(one("transform.math", { a: "1", operation: "divide", b: "0" })).rejects.toThrow(/divide by zero/);
    expect(await one("transform.json", { value: '{"a":1}', operation: "parse" })).toEqual({ a: 1 });
    expect(await one("transform.list", { list: "${['$input']['xs']}", operation: "sort", field: "n", direction: "desc" }, { xs: [{ n: 1 }, { n: 3 }] })).toEqual([{ n: 3 }, { n: 1 }]);
    expect(await one("transform.list", { list: "${['$input']['xs']}", operation: "unique" }, { xs: [1, 1, 2] })).toEqual([1, 2]);
    expect(await one("transform.crypto", { value: "abc", operation: "sha256" })).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await one("transform.crypto", { value: "hi", operation: "base64-encode" })).toBe("aGk=");
    expect(await one("transform.date", { operation: "add", date: "2026-01-31T10:00:00Z", amount: 1, unit: "days", format: "YYYY-MM-DD HH:mm", timezone: "Asia/Jakarta" })).toBe("2026-02-01 17:00");
    expect(await one("transform.date", { operation: "diff", date: "2026-01-10", otherDate: "2026-01-01", unit: "days" })).toBe(9);
  });

  it("list split fans out into items", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["x"] } },
      { id: "x", type: "transform.list", parameters: { list: "${['$input']['xs']}", operation: "split" } },
    ]);
    const r = await run(g, [{ json: { xs: [{ a: 1 }, 2] } }]);
    expect(r.state.lastOutput).toEqual([{ json: { a: 1 } }, { json: { value: 2 } }]);
  });
});

describe("schedules", () => {
  it("computes the next cron run in a time zone", () => {
    const after = new Date("2026-01-05T00:00:00Z"); // Monday 07:00 in Jakarta
    expect(nextCronRun("0 9 * * 1-5", after, "Asia/Jakarta").toISOString()).toBe("2026-01-05T02:00:00.000Z");
    expect(nextCronRun("*/15 * * * *", new Date("2026-01-01T00:07:30Z")).toISOString()).toBe("2026-01-01T00:15:00.000Z");
    // Saturday 2026-01-03 → next weekday run is Monday.
    expect(nextCronRun("30 8 * * 1-5", new Date("2026-01-03T12:00:00Z")).toISOString()).toBe("2026-01-05T08:30:00.000Z");
    expect(nextCronRun("0 0 1 * *", new Date("2026-01-15T00:00:00Z")).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("computes interval schedules", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(nextScheduleRun({ mode: "interval", every: 2, unit: "hours" }, after).toISOString()).toBe("2026-01-01T02:00:00.000Z");
  });
});
