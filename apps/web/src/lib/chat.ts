import "server-only";
import { FINAL_STATUSES, workflowGraphSchema, type WorkflowNode } from "@conduit/core";
import { ObjectId } from "mongodb";
import { db } from "./db";
import { rt } from "./runtime";

export interface PublishedChat {
  workspaceId: ObjectId;
  workflowId: ObjectId;
  workflowName: string;
  versionId: ObjectId;
  graph: ReturnType<typeof workflowGraphSchema.parse>;
  node: WorkflowNode;
  title: string;
  welcomeMessage: string;
  placeholder: string;
}

export const MAX_CHAT_MESSAGE = 4000;
export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The live chat at /chat/:path, from the published version. */
export async function loadPublishedChat(path: string): Promise<PublishedChat | null> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(path)) return null;
  const t = await rt().triggers.findChat(path);
  if (!t?.versionId) return null;
  const [wf, version] = await Promise.all([
    db.collection("workflows").findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
    db.collection("workflow_versions").findOne({ _id: t.versionId }),
  ]);
  if (!wf || !version) return null;
  const graph = workflowGraphSchema.parse(version.graph);
  const node = graph.nodes.find((n) => n.id === t.nodeId && n.type === "trigger.chat");
  if (!node) return null;
  const p = node.parameters;
  return {
    workspaceId: t.workspaceId,
    workflowId: t.workflowId,
    workflowName: String(wf.name),
    versionId: t.versionId,
    graph,
    node,
    title: String(p.title || "Chat"),
    welcomeMessage: String(p.welcomeMessage ?? ""),
    placeholder: String(p.placeholder || "Type a message…"),
  };
}

// --- Rate limits (per server process): a public page shouldn't be able to start unlimited runs. ---
const g = globalThis as unknown as { __chatHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__chatHits ??= new Map());

/** True when this key has used up `max` messages in the last minute. Records the attempt otherwise. */
export function overLimit(key: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return false;
}

export async function startChatRun(chat: PublishedChat, sessionId: string, message: string): Promise<ObjectId> {
  return rt().runtime.createExecution(
    {
      workspaceId: chat.workspaceId,
      workflowId: chat.workflowId,
      workflowName: chat.workflowName,
      versionId: chat.versionId,
      mode: "production",
      graph: chat.graph,
      triggerNodeId: chat.node.id,
      triggerItems: [{ json: { message, sessionId, sentAt: new Date().toISOString() } }],
    },
    true,
  );
}

const REPLY_KEYS = ["reply", "output", "text", "message", "answer"];

function textOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && !Array.isArray(v)) {
    for (const k of REPLY_KEYS) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === "string" || typeof x === "number") return String(x);
    }
  }
  return JSON.stringify(v);
}

export type ChatReply = { status: "pending" } | { status: "done"; reply: string | null } | { status: "failed" };

/**
 * The reply for one message: the Respond step's body if the workflow has one,
 * otherwise the last step's output. Only runs of this chat and this visitor's
 * session are readable.
 */
export async function chatReply(chat: PublishedChat, runId: string, sessionId: string): Promise<ChatReply | null> {
  if (!ObjectId.isValid(runId)) return null;
  const e = await db.collection("executions").findOne(
    { _id: new ObjectId(runId), workflowId: chat.workflowId, triggerNodeId: chat.node.id, "triggerItems.0.json.sessionId": sessionId },
    { projection: { status: 1, response: 1 } },
  );
  if (!e) return null;
  const response = e.response as { body?: unknown } | null;
  if (response) return { status: "done", reply: textOf(response.body) };
  if (!FINAL_STATUSES.includes(e.status)) return { status: "pending" };
  if (e.status !== "success") return { status: "failed" };
  const last = await db
    .collection("execution_steps")
    .find({ executionId: e._id, nodeId: { $ne: chat.node.id }, status: "success" }, { projection: { output: 1 } })
    .sort({ index: -1 })
    .limit(1)
    .next();
  const item = (last?.output as { main?: Array<{ json: unknown }> } | undefined)?.main?.[0]?.json;
  return { status: "done", reply: item === undefined ? null : textOf(item) };
}
