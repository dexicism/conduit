import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrations } from "./integrations";
import { createHttpClient } from "./net";
import { createOutbound } from "./outbound";
import { createRuntime } from "./runtime";
import { createVault } from "./vault";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let server: Server;
let url: string;
let failNext = 0;
const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
const vault = createVault(new Map([[1, randomBytes(32)]]));

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ launchTimeout: 60_000 }] });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("outbound_test");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end("boom");
      } else res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
  server?.close();
});

describe("outbound webhooks", () => {
  it("signs deliveries and retries failures with backoff", async () => {
    const out = createOutbound(db, { vault, http: createHttpClient({ allowPrivateNetwork: true }) });
    const ws = new ObjectId();
    const { id, secret } = await out.create(ws, url, ["execution.completed"]);
    expect(JSON.stringify(await db.collection("outbound_webhooks").findOne({})).includes(secret)).toBe(false);

    received.length = 0;
    failNext = 1;
    expect(await out.enqueue(ws, "execution.completed", { executionId: "x" })).toBe(1);
    expect(await out.enqueue(ws, "execution.failed", { executionId: "y" })).toBe(0); // not subscribed
    await out.tick();
    expect(received).toHaveLength(1);
    let [h] = await out.list(ws);
    expect(h!.recent[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });

    // Not due yet: nothing is sent. Make it due and it succeeds.
    await out.tick();
    expect(received).toHaveLength(1);
    await db.collection("webhook_deliveries").updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await out.tick();
    expect(received).toHaveLength(2);
    [h] = await out.list(ws);
    expect(h!.recent[0]).toMatchObject({ status: "delivered", attempts: 2 });

    // Signature: t=…,v1=HMAC(secret, "t.body")
    const r = received[1]!;
    const sig = String(r.headers["conduit-signature"]);
    const t = /t=(\d+)/.exec(sig)![1];
    const expected = createHmac("sha256", secret).update(`${t}.${r.body}`).digest("hex");
    expect(sig).toBe(`t=${t},v1=${expected}`);
    expect(JSON.parse(r.body)).toMatchObject({ type: "execution.completed", data: { executionId: "x" } });
    expect(r.headers["conduit-event"]).toBe("execution.completed");

    expect(await out.remove(new ObjectId(), id)).toBe(false); // other workspace
    expect(await out.remove(ws, id)).toBe(true);
  });

  it("refuses private addresses unless allowed", async () => {
    const out = createOutbound(db, { vault, http: createHttpClient({ allowPrivateNetwork: false }) });
    const ws = new ObjectId();
    await out.create(ws, url, ["execution.completed"]);
    received.length = 0;
    await out.enqueue(ws, "execution.completed", {});
    await out.tick();
    expect(received).toHaveLength(0);
    const [h] = await out.list(ws);
    expect(h!.recent[0]!.lastError).toMatch(/private network/);
  });

  it("live runs queue an event; test runs don't", async () => {
    const integrations = createIntegrations(db, { vault, http: createHttpClient({ allowPrivateNetwork: true }), allowPrivateNetwork: true, oauthClients: {} });
    const rt = createRuntime(db, { allowPrivateNetwork: true }, {}, { integrations });
    const ws = new ObjectId();
    await rt.outbound!.create(ws, url, ["execution.completed", "execution.failed"]);
    const graph = workflowGraphSchema.parse({
      nodes: [{ id: "t", type: "trigger.manual", label: "t", position: { x: 0, y: 0 }, parameters: defaultParameters(getDefinition("trigger.manual")!), connections: {} }],
    });
    received.length = 0;
    for (const mode of ["test", "production"] as const) {
      const id = await rt.createExecution({ workspaceId: ws, workflowId: new ObjectId(), workflowName: "W", versionId: null, mode, graph, triggerNodeId: "t", triggerItems: [{ json: {} }] }, false);
      await rt.processExecution(id);
    }
    await rt.outbound!.tick();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: "execution.completed", data: { workflowName: "W", status: "success" } });
  });
});
