import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient, isPrivateAddress } from "./net";
import { createExecutionQueries } from "./queries";
import { createRuntime, resolveRuntimeOptions, type Runtime } from "./runtime";
import { createSandbox } from "./sandbox";
import { createTriggerService, PublishError } from "./triggers";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let server: Server;
let base: string;

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("runtime_test");
  server = createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "/json" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
  server?.close();
});

type N = { id: string; type: string; parameters?: Record<string, unknown>; to?: Record<string, string[]> };
function graph(nodes: N[]): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: Object.fromEntries(Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => ({ targetId: t }))])),
    })),
  });
}

async function insertWorkflow(workspaceId: ObjectId, name: string, g: WorkflowGraph, extra: Record<string, unknown> = {}) {
  const _id = new ObjectId();
  await db.collection("workflows").insertOne({
    _id,
    workspaceId,
    name,
    revision: 1,
    draft: g,
    publishedVersionId: null,
    archivedAt: null,
    ...extra,
  });
  return _id;
}

const setNode = (id: string, field: string, value: string, to?: Record<string, string[]>): N => ({
  id,
  type: "core.set",
  parameters: { assignments: [{ id: "1", name: field, value, type: "string" }] },
  to,
});

describe("sandbox", () => {
  const run = createSandbox({ memoryLimitMb: 32, timeoutMs: 1000 });

  it("runs per item and for all items, captures console output", async () => {
    const per = await run({ code: "console.log('n', item.n); return { ...item, sq: item.n * item.n };", mode: "perItem", items: [{ json: { n: 2 } }, { json: { n: 3 } }] });
    expect(per.items).toEqual([{ n: 2, sq: 4 }, { n: 3, sq: 9 }]);
    expect(per.logs).toEqual(["n 2", "n 3"]);
    const all = await run({ code: "return [{ total: items.reduce((a, i) => a + i.n, 0) }];", mode: "all", items: [{ json: { n: 2 } }, { json: { n: 3 } }] });
    expect(all.items).toEqual([{ total: 5 }]);
  });

  it("supports async code and drops null results", async () => {
    const r = await run({ code: "await new Promise(r => r()); return item.keep ? item : null;", mode: "perItem", items: [{ json: { keep: true } }, { json: { keep: false } }] });
    expect(r.items).toEqual([{ keep: true }]);
  });

  it("has no Node APIs, network or filesystem", async () => {
    const r = await run({
      code: "return { process: typeof process, require: typeof require, fetch: typeof fetch, global: typeof globalThis.setTimeout };",
      mode: "all",
      items: [],
    });
    expect(r.items).toEqual([{ process: "undefined", require: "undefined", fetch: "undefined", global: "undefined" }]);
  });

  it("stops infinite loops and reports syntax and runtime errors", async () => {
    await expect(run({ code: "while (true) {}", mode: "all", items: [] })).rejects.toThrow(/longer than 1s/);
    await expect(run({ code: "return {", mode: "all", items: [] })).rejects.toThrow(/Syntax error/);
    await expect(run({ code: "throw new Error('nope')", mode: "all", items: [] })).rejects.toThrow(/nope/);
  });

  it("enforces the memory limit", async () => {
    await expect(run({ code: "const a = []; while (true) a.push(new Array(1e6).fill(1));", mode: "all", items: [] })).rejects.toThrow(/memory|longer/);
  }, 20_000);
});

describe("network guard", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("blocks private targets by default, including via hostnames", async () => {
    const http = createHttpClient({ allowPrivateNetwork: false });
    await expect(http({ method: "GET", url: `${base}/x`, headers: {}, timeoutMs: 2000 })).rejects.toThrow(/private network/);
    const port = (server.address() as AddressInfo).port;
    await expect(http({ method: "GET", url: `http://localhost:${port}/x`, headers: {}, timeoutMs: 2000 })).rejects.toThrow(/private network|ECONNREFUSED/);
  });

  it("follows redirects and parses JSON when allowed", async () => {
    const http = createHttpClient({ allowPrivateNetwork: true });
    const r = await http({ method: "GET", url: `${base}/redirect`, headers: {}, timeoutMs: 2000 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ path: "/json", method: "GET" });
  });
});

describe("options", () => {
  it("keeps defaults for options passed as undefined (unset env vars)", () => {
    const o = resolveRuntimeOptions({ retentionDays: undefined, workerConcurrency: undefined, allowPrivateNetwork: true });
    expect(o.retentionDays).toBe(7);
    expect(o.workerConcurrency).toBe(8);
    expect(o.allowPrivateNetwork).toBe(true);
  });
});

describe("runtime", () => {
  let rt: Runtime;
  const ws = new ObjectId();
  beforeAll(() => {
    rt = createRuntime(db, { allowPrivateNetwork: true, codeTimeoutMs: 2000 });
  });

  it("runs an execution and stores step logs", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["c"] } },
      { id: "c", type: "core.code", parameters: { code: "return { ...item, doubled: item.n * 2 };" }, to: { main: ["h"] } },
      { id: "h", type: "core.http", parameters: { url: `${base}/echo?n=\${['$input']['doubled']}` } },
    ]);
    const wfId = await insertWorkflow(ws, "Linear", g);
    const id = await rt.createExecution(
      { workspaceId: ws, workflowId: wfId, workflowName: "Linear", versionId: null, mode: "test", graph: g, triggerNodeId: "t", triggerItems: [{ json: { n: 21 } }] },
      false,
    );
    const done = await rt.processExecution(id);
    expect(done.status).toBe("success");
    const detail = await createExecutionQueries(db).get(ws, id.toHexString());
    expect(detail!.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["t", "success"],
      ["c", "success"],
      ["h", "success"],
    ]);
    expect(detail!.steps[2]!.output.main![0]!.json.body).toEqual({ path: "/echo?n=42", method: "GET" });
  });

  it("worker processes queued jobs, waits, resumes, and can cancel", async () => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: { main: ["w"] } },
      { id: "w", type: "flow.wait", parameters: { mode: "duration", amount: 1, unit: "seconds" }, to: { main: ["s"] } },
      setNode("s", "after", "yes"),
    ]);
    const wfId = await insertWorkflow(ws, "Waiting", g);
    const start = (wf: ObjectId) =>
      rt.createExecution({ workspaceId: ws, workflowId: wf, workflowName: "Waiting", versionId: null, mode: "production", graph: g, triggerNodeId: "t", triggerItems: [{ json: {} }] }, true);
    const id = await start(wfId);
    const worker = rt.startWorker({ pollMs: 50 });
    try {
      const status = async (x: ObjectId) => (await rt.collections.executions.findOne({ _id: x }))!.status;
      await expect.poll(() => status(id), { timeout: 5000 }).toBe("waiting");
      await expect.poll(() => status(id), { timeout: 8000 }).toBe("success");
      expect(await rt.collections.jobs.countDocuments({ executionId: id })).toBe(0);

      const id2 = await start(wfId);
      await expect.poll(() => status(id2), { timeout: 5000 }).toBe("waiting");
      const canceled = await createExecutionQueries(db).cancel(ws, id2.toHexString());
      expect(canceled!.status).toBe("canceled");
      expect(await rt.collections.jobs.countDocuments({ executionId: id2 })).toBe(0);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("calls sub-workflows inline with a depth limit, and starts error workflows", async () => {
    const child = graph([{ id: "in", type: "trigger.subworkflow", to: { main: ["s"] } }, setNode("s", "greeting", "Hello ${['$input']['input']['name']}")]);
    const childId = await insertWorkflow(ws, "Child", child);
    const parent = graph([
      { id: "t", type: "trigger.manual", to: { main: ["x"] } },
      { id: "x", type: "core.execute-workflow", parameters: { workflowId: childId.toHexString(), input: '{"name": "Ada"}' } },
    ]);
    const parentId = await insertWorkflow(ws, "Parent", parent);
    const id = await rt.createExecution(
      { workspaceId: ws, workflowId: parentId, workflowName: "Parent", versionId: null, mode: "test", graph: parent, triggerNodeId: "t", triggerItems: [{ json: {} }] },
      false,
    );
    const done = await rt.processExecution(id);
    expect(done.status).toBe("success");
    expect(done.state!.lastOutput[0]!.json).toEqual({ result: { input: { name: "Ada" }, greeting: "Hello Ada" } });

    // In production the child must be published.
    const prod = await rt.createExecution(
      { workspaceId: ws, workflowId: parentId, workflowName: "Parent", versionId: null, mode: "production", graph: parent, triggerNodeId: "t", triggerItems: [{ json: {} }] },
      false,
    );
    const failed = await rt.processExecution(prod);
    expect(failed.status).toBe("failed");
    expect(failed.error!.message).toMatch(/isn't published/);

    // A workflow that calls itself stops at the depth limit.
    const selfId = new ObjectId();
    const selfGraph = graph([
      { id: "in", type: "trigger.subworkflow", to: { main: ["x"] } },
      { id: "x", type: "core.execute-workflow", parameters: { workflowId: selfId.toHexString(), input: "{}" } },
    ]);
    await db.collection("workflows").insertOne({ _id: selfId, workspaceId: ws, name: "Recursive", revision: 1, draft: selfGraph, publishedVersionId: null, archivedAt: null });
    const rec = await rt.createExecution(
      { workspaceId: ws, workflowId: selfId, workflowName: "Recursive", versionId: null, mode: "test", graph: selfGraph, triggerNodeId: "in", triggerItems: [{ json: { input: {} } }] },
      false,
    );
    const recDone = await rt.processExecution(rec);
    expect(recDone.status).toBe("failed");
    expect(recDone.error!.message).toMatch(/at most 5 levels/);
  });

  it("starts the configured error workflow when a production run fails", async () => {
    const handler = graph([{ id: "e", type: "trigger.error", to: { main: ["s"] } }, setNode("s", "seen", "${['$input']['error']['message']}")]);
    const handlerId = await insertWorkflow(ws, "On error", handler);
    const triggers = createTriggerService(db, client);
    await triggers.publish(ws, handlerId, "u1");

    const failing = graph([
      { id: "t", type: "trigger.manual", to: { main: ["m"] } },
      { id: "m", type: "transform.math", parameters: { a: "1", operation: "divide", b: "0" } },
    ]);
    const failingId = await insertWorkflow(ws, "Fails", failing, { settings: { errorWorkflowId: handlerId.toHexString() } });
    const id = await rt.createExecution(
      { workspaceId: ws, workflowId: failingId, workflowName: "Fails", versionId: null, mode: "production", graph: failing, triggerNodeId: "t", triggerItems: [{ json: {} }] },
      false,
    );
    expect((await rt.processExecution(id)).status).toBe("failed");
    const errRun = await rt.collections.executions.findOne({ workflowId: handlerId, mode: "error" });
    expect(errRun).not.toBeNull();
    const result = await rt.processExecution(errRun!._id);
    expect(result.status).toBe("success");
    expect(result.state!.lastOutput[0]!.json.seen).toBe("Can't divide by zero");
  });
});

describe("publishing and schedules", () => {
  const ws = new ObjectId();

  it("refuses incomplete workflows and registers webhooks and schedules", async () => {
    const triggers = createTriggerService(db, client);
    const empty = await insertWorkflow(ws, "Empty", graph([]));
    await expect(triggers.publish(ws, empty, "u")).rejects.toBeInstanceOf(PublishError);

    const bad = await insertWorkflow(ws, "Bad", graph([{ id: "t", type: "trigger.manual", to: { main: ["h"] } }, { id: "h", type: "core.http", parameters: { url: "" } }]));
    const err = (await triggers.publish(ws, bad, "u").catch((e: unknown) => e)) as PublishError;
    expect(err).toBeInstanceOf(PublishError);
    expect(err.issues.some((i: { message: string }) => /URL is required/.test(i.message))).toBe(true);

    const g = graph([
      { id: "hook", type: "trigger.webhook", parameters: { path: "unique-path-1", method: "POST" }, to: { main: ["s"] } },
      { id: "sched", type: "trigger.schedule", parameters: { mode: "interval", every: 5, unit: "minutes" }, to: { main: ["s"] } },
      setNode("s", "ok", "1"),
    ]);
    const wf = await insertWorkflow(ws, "Live", g);
    const res = await triggers.publish(ws, wf, "u");
    expect(res.triggers.map((t) => t.kind).sort()).toEqual(["schedule", "webhook"]);
    expect((await triggers.findWebhook("unique-path-1", false))?.workflowId.toHexString()).toBe(wf.toHexString());

    // Another workflow can't take the same live path.
    const clash = await insertWorkflow(ws, "Clash", graph([{ id: "hook", type: "trigger.webhook", parameters: { path: "unique-path-1" } }]));
    await expect(triggers.publish(ws, clash, "u")).rejects.toMatchObject({ conflict: true });

    // The scheduler fires due schedules and books the next run.
    const rt = createRuntime(db);
    await rt.collections.triggers.updateOne({ workflowId: wf, kind: "schedule" }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    await rt.tickSchedules();
    const run = await rt.collections.executions.findOne({ workflowId: wf, mode: "production" });
    expect(run?.triggerNodeId).toBe("sched");
    const next = (await rt.collections.triggers.findOne({ workflowId: wf, kind: "schedule" }))!.nextRunAt!;
    expect(next.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    await triggers.unpublish(ws, wf);
    expect(await triggers.findWebhook("unique-path-1", false)).toBeNull();
  });
});
