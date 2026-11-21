import "server-only";
import { FINAL_STATUSES, workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "./db";
import { rt } from "./runtime";

const MAX_BODY = 1_000_000;
const RESPOND_TIMEOUT_MS = 30_000;

function err(status: number, message: string) {
  return NextResponse.json({ error: status === 404 ? "not_found" : "invalid_request", message }, { status });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return { ok: false, res: err(413, "Request body is larger than 1 MB") };
  const raw = await req.text();
  if (raw.length > MAX_BODY) return { ok: false, res: err(413, "Request body is larger than 1 MB") };
  if (!raw) return { ok: true, body: null };
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return { ok: true, body: JSON.parse(raw) };
    } catch {
      return { ok: false, res: err(400, "Body is not valid JSON") };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) return { ok: true, body: Object.fromEntries(new URLSearchParams(raw)) };
  return { ok: true, body: raw };
}

const HIDDEN_HEADERS = new Set(["cookie", "authorization"]);

/** Handles a request to /hook/:path (published) or /hook-test/:path (armed from the editor). */
export async function handleWebhook(req: Request, path: string, test: boolean): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(path)) return err(404, "No webhook at this URL");
  const { triggers, runtime } = rt();
  const t = await triggers.findWebhook(path, test);
  if (!t) {
    return err(
      404,
      test ? "This test URL isn't listening. Click “Listen for a test request” in the editor first." : "No published workflow uses this webhook",
    );
  }

  const wf = await db.collection("workflows").findOne({ _id: t.workflowId });
  if (!wf) return err(404, "No webhook at this URL");
  let graph: WorkflowGraph;
  let versionId: ObjectId | null = null;
  if (test) graph = workflowGraphSchema.parse(wf.draft);
  else {
    const v = await db.collection("workflow_versions").findOne({ _id: t.versionId! });
    if (!v) return err(404, "No webhook at this URL");
    graph = workflowGraphSchema.parse(v.graph);
    versionId = v._id as ObjectId;
  }
  const node = graph.nodes.find((n) => n.id === t.nodeId && n.type === "trigger.webhook");
  if (!node) return err(404, "No webhook at this URL");

  const method = String(node.parameters.method ?? "POST");
  if (req.method !== method) {
    return NextResponse.json({ error: "invalid_request", message: `This webhook accepts ${method} requests` }, { status: 405, headers: { allow: method } });
  }
  if (node.parameters.auth === "header") {
    const name = String(node.parameters.authHeaderName ?? "").toLowerCase();
    const expected = String(node.parameters.authHeaderValue ?? "");
    const got = req.headers.get(name) ?? "";
    if (!name || !expected || !safeEqual(got, expected)) return err(401, "Missing or invalid authentication header");
  }

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.res;
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!HIDDEN_HEADERS.has(k) && k !== (node.parameters.authHeaderName as string | undefined)?.toLowerCase()) headers[k] = v;
  });
  const item = { json: { method: req.method, headers, query: Object.fromEntries(url.searchParams), body: parsed.body } };

  const executionId = await runtime.createExecution(
    {
      workspaceId: t.workspaceId,
      workflowId: t.workflowId,
      workflowName: String(wf.name),
      versionId,
      mode: test ? "test" : "production",
      graph,
      triggerNodeId: node.id,
      triggerItems: [item],
    },
    false,
  );
  if (test && t._id && !(await triggers.consumeListener(t._id, executionId))) {
    await db.collection("executions").deleteOne({ _id: executionId });
    return err(409, "This test URL already received a request. Listen again to send another.");
  }
  await db.collection("jobs").insertOne({
    _id: new ObjectId(),
    executionId,
    workspaceId: t.workspaceId,
    runAt: new Date(),
    status: "queued",
    lockedUntil: null,
    attempts: 0,
    createdAt: new Date(),
  });

  if (node.parameters.respond !== "respondNode") {
    return NextResponse.json({ ok: true, executionId: executionId.toHexString() }, { status: 202 });
  }

  // Wait for a Respond step (or the end of the run).
  const deadline = Date.now() + RESPOND_TIMEOUT_MS;
  while (Date.now() < deadline && !req.signal.aborted) {
    const e = await db.collection("executions").findOne({ _id: executionId }, { projection: { status: 1, response: 1, error: 1 } });
    if (e?.response) {
      const r = e.response as { status: number; headers: Record<string, string>; body: unknown };
      const isJson = r.body !== null && typeof r.body === "object";
      return new Response(isJson ? JSON.stringify(r.body) : r.body == null ? null : String(r.body), {
        status: r.status,
        headers: { ...(isJson ? { "content-type": "application/json" } : {}), ...r.headers },
      });
    }
    if (e && FINAL_STATUSES.includes(e.status)) {
      return e.status === "failed"
        ? NextResponse.json({ error: "workflow_failed", message: (e.error as { message?: string })?.message ?? "Workflow failed" }, { status: 500 })
        : NextResponse.json({ ok: true, executionId: executionId.toHexString() }, { status: 200 });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return NextResponse.json({ ok: true, executionId: executionId.toHexString(), message: "Still running" }, { status: 202 });
}
