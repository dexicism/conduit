import {
  validateGraphStructure,
  workflowGraphSchema,
  type ActiveTrigger,
  type PublishResult,
  type WorkflowGraph,
} from "@conduit/core";
import { nextScheduleRun } from "@conduit/engine";
import { getDefinition, nodeIssues, validateGraphWithRegistry } from "@conduit/nodes";
import { randomBytes } from "node:crypto";
import { MongoServerError, ObjectId, type ClientSession, type Db, type MongoClient } from "mongodb";
import { collections, ensureRuntimeIndexes, type TriggerDoc } from "./store";

export class PublishError extends Error {
  constructor(
    message: string,
    public issues: Array<{ nodeId?: string; message: string }> = [],
    public conflict = false,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

/** Name-based check: the runtime may be loaded twice (cached on globalThis across bundles), so instanceof is unreliable. */
export function isPublishError(err: unknown): err is PublishError {
  return err instanceof Error && err.name === "PublishError";
}

/** Everything that must be true before a workflow can go live. */
export function publishIssues(graph: WorkflowGraph): Array<{ nodeId?: string; message: string }> {
  const issues: Array<{ nodeId?: string; message: string }> = [
    ...validateGraphStructure(graph),
    ...validateGraphWithRegistry(graph),
  ];
  const triggers = graph.nodes.filter((n) => getDefinition(n.type)?.category === "trigger" && !n.disabled);
  if (!triggers.length) issues.push({ message: "Add a trigger before publishing" });
  for (const n of graph.nodes) {
    if (n.disabled) continue;
    for (const i of nodeIssues(graph, n)) issues.push({ nodeId: n.id, message: `${n.label}: ${i.message}` });
  }
  return issues;
}

const LIVE_TYPES = ["trigger.webhook", "trigger.schedule", "trigger.telegram", "trigger.whatsapp", "trigger.whatsappWeb", "trigger.form", "trigger.chat"];
const LIVE_KINDS: TriggerDoc["kind"][] = ["webhook", "schedule", "telegram", "whatsapp", "whatsappWeb", "form", "chat"];

function liveTriggers(graph: WorkflowGraph) {
  return graph.nodes.filter((n) => !n.disabled && LIVE_TYPES.includes(n.type));
}

/** Registers app webhooks (e.g. a Telegram bot's) when a workflow goes live. */
export interface TriggerHooks {
  telegram?: {
    urlFor(path: string): string;
    register(workspaceId: ObjectId, credentialId: string, url: string, secretToken: string): Promise<void>;
    unregister(workspaceId: ObjectId, credentialId: string): Promise<void>;
  };
  /** Throws if a WhatsApp connection is missing what incoming messages need (app secret, verify token). */
  whatsapp?: { check(workspaceId: ObjectId, credentialId: string): Promise<void> };
}

export function createTriggerService(db: Db, client: MongoClient, hooks: TriggerHooks = {}) {
  const c = collections(db);

  async function unregisterTelegram(list: TriggerDoc[], keep: Set<string>) {
    for (const t of list) {
      if (t.kind !== "telegram" || !t.credentialId || keep.has(t.credentialId)) continue;
      try {
        await hooks.telegram?.unregister(t.workspaceId, t.credentialId);
      } catch (e) {
        console.warn("[triggers] telegram unregister failed", (e as Error).message);
      }
    }
  }

  async function withTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = client.startSession();
    try {
      let out: T | undefined;
      await session.withTransaction(async () => {
        out = await fn(session);
      });
      return out as T;
    } finally {
      await session.endSession();
    }
  }

  async function publish(workspaceId: ObjectId, workflowId: ObjectId, userId: string): Promise<PublishResult> {
    await ensureRuntimeIndexes(db);
    const wf = await c.workflows.findOne({ _id: workflowId, workspaceId });
    if (!wf) throw new PublishError("Workflow not found");
    const graph = workflowGraphSchema.parse(wf.draft);
    const issues = publishIssues(graph);
    if (issues.length) throw new PublishError("Fix the problems in this workflow before publishing", issues);

    const now = new Date();
    const versionId = new ObjectId();
    const revision = Number(wf.revision ?? 0);
    const docs: TriggerDoc[] = liveTriggers(graph).map((n): TriggerDoc => {
      const base = { workspaceId, workflowId, versionId, nodeId: n.id, createdAt: now };
      if (n.type === "trigger.webhook") return { ...base, kind: "webhook", method: String(n.parameters.method ?? "POST"), path: String(n.parameters.path) };
      if (n.type === "trigger.form") return { ...base, kind: "form", method: "POST", path: String(n.parameters.path) };
      if (n.type === "trigger.chat") return { ...base, kind: "chat", method: "POST", path: String(n.parameters.path) };
      if (n.type === "trigger.telegram") {
        return {
          ...base,
          kind: "telegram",
          path: randomBytes(18).toString("base64url"),
          secretToken: randomBytes(32).toString("base64url"),
          credentialId: String(n.parameters.credential ?? ""),
        };
      }
      if (n.type === "trigger.whatsapp") return { ...base, kind: "whatsapp", credentialId: String(n.parameters.credential ?? "") };
      if (n.type === "trigger.whatsappWeb") return { ...base, kind: "whatsappWeb", credentialId: String(n.parameters.credential ?? "") };
      return { ...base, kind: "schedule", nextRunAt: nextScheduleRun(n.parameters, now) };
    });

    // Telegram allows one webhook per bot, so a bot can start only one live workflow.
    const bots = docs.filter((d) => d.kind === "telegram");
    if (bots.length) {
      if (!hooks.telegram) throw new PublishError("Connected apps aren't set up on this server, so Telegram triggers can't go live");
      const ids = bots.map((b) => b.credentialId!);
      if (new Set(ids).size !== ids.length) throw new PublishError("Two Telegram triggers use the same bot", [], true);
      const taken = await c.triggers.findOne({ kind: "telegram", credentialId: { $in: ids }, workflowId: { $ne: workflowId } });
      if (taken) {
        const other = await c.workflows.findOne({ _id: taken.workflowId }, { projection: { name: 1 } });
        const otherName = String(other?.name ?? "another workflow");
        throw new PublishError(`This bot already starts the live workflow "${otherName}". Unpublish it first or use another bot.`, [], true);
      }
      for (const b of bots) {
        try {
          await hooks.telegram.register(workspaceId, b.credentialId!, hooks.telegram.urlFor(b.path!), b.secretToken!);
        } catch (err) {
          const message = (err as Error).message;
          throw new PublishError(`Couldn't connect the Telegram bot: ${message}`, [{ nodeId: b.nodeId, message }]);
        }
      }
    }
    // Same for WhatsApp: one number, one live workflow.
    const numbers = docs.filter((d) => d.kind === "whatsapp");
    if (numbers.length) {
      const ids = numbers.map((b) => b.credentialId!);
      if (new Set(ids).size !== ids.length) throw new PublishError("Two WhatsApp triggers use the same number", [], true);
      const taken = await c.triggers.findOne({ kind: "whatsapp", credentialId: { $in: ids }, workflowId: { $ne: workflowId } });
      if (taken) {
        const other = await c.workflows.findOne({ _id: taken.workflowId }, { projection: { name: 1 } });
        throw new PublishError(`This WhatsApp number already starts the live workflow "${String(other?.name ?? "another workflow")}". Unpublish it first.`, [], true);
      }
      for (const b of numbers) {
        try {
          await hooks.whatsapp?.check(workspaceId, b.credentialId!);
        } catch (err) {
          const message = (err as Error).message;
          throw new PublishError(message, [{ nodeId: b.nodeId, message }]);
        }
      }
    }
    // A linked phone also starts one live workflow; that workflow decides what to do with each message.
    const phones = docs.filter((d) => d.kind === "whatsappWeb");
    if (phones.length) {
      const ids = phones.map((b) => b.credentialId!);
      if (new Set(ids).size !== ids.length) throw new PublishError("Two WhatsApp triggers use the same linked number", [], true);
      const taken = await c.triggers.findOne({ kind: "whatsappWeb", credentialId: { $in: ids }, workflowId: { $ne: workflowId } });
      if (taken) {
        const other = await c.workflows.findOne({ _id: taken.workflowId }, { projection: { name: 1 } });
        throw new PublishError(`This linked number already starts the live workflow "${String(other?.name ?? "another workflow")}". Unpublish it first.`, [], true);
      }
    }
    const previous = await c.triggers.find({ workflowId, kind: "telegram" }).toArray();
    const paths = docs.filter((d) => d.kind === "webhook").map((d) => d.path!);
    const formPaths = docs.filter((d) => d.kind === "form").map((d) => d.path!);
    if (formPaths.length) {
      if (new Set(formPaths).size !== formPaths.length) throw new PublishError("Two forms use the same link path", [], true);
      const taken = await c.triggers.findOne({ kind: "form", path: { $in: formPaths }, workflowId: { $ne: workflowId } });
      if (taken) throw new PublishError("Another workflow already uses this form link. Change the path and publish again.", [], true);
    }
    const chatPaths = docs.filter((d) => d.kind === "chat").map((d) => d.path!);
    if (chatPaths.length) {
      if (new Set(chatPaths).size !== chatPaths.length) throw new PublishError("Two chats use the same link path", [], true);
      const taken = await c.triggers.findOne({ kind: "chat", path: { $in: chatPaths }, workflowId: { $ne: workflowId } });
      if (taken) throw new PublishError("Another workflow already uses this chat link. Change the path and publish again.", [], true);
    }
    if (new Set(paths).size !== paths.length) throw new PublishError("Two webhook triggers use the same path", [], true);

    try {
      await withTx(async (session) => {
        await c.versions.insertOne(
          { _id: versionId, workflowId, workspaceId, revision, graph, publishedBy: userId, publishedAt: now },
          { session },
        );
        await c.triggers.deleteMany({ workflowId, kind: { $in: LIVE_KINDS } }, { session });
        if (docs.length) await c.triggers.insertMany(docs, { session });
        await c.workflows.updateOne(
          { _id: workflowId },
          { $set: { publishedVersionId: versionId, publishedRevision: revision, publishedAt: now } },
          { session },
        );
      });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new PublishError("Another workflow already uses this webhook path. Change the path and publish again.", [], true);
      }
      throw err;
    }
    await unregisterTelegram(previous, new Set(bots.map((b) => b.credentialId!)));

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const triggers: ActiveTrigger[] = docs.map((d) => ({
      nodeId: d.nodeId,
      label: byId.get(d.nodeId)?.label ?? d.nodeId,
      kind: d.kind as ActiveTrigger["kind"],
      method: d.method,
      path: d.path,
      nextRunAt: d.nextRunAt?.toISOString(),
    }));
    return { versionId: versionId.toHexString(), publishedRevision: revision, publishedAt: now.toISOString(), triggers };
  }

  async function unpublish(workspaceId: ObjectId, workflowId: ObjectId): Promise<void> {
    const previous = await c.triggers.find({ workflowId, workspaceId, kind: "telegram" }).toArray();
    await withTx(async (session) => {
      await c.triggers.deleteMany({ workflowId, workspaceId, kind: { $in: LIVE_KINDS } }, { session });
      await c.workflows.updateOne(
        { _id: workflowId, workspaceId },
        { $set: { publishedVersionId: null, publishedRevision: null, publishedAt: null } },
        { session },
      );
    });
    await unregisterTelegram(previous, new Set());
  }

  async function activeTriggers(workflowId: ObjectId): Promise<TriggerDoc[]> {
    return c.triggers.find({ workflowId, kind: { $in: LIVE_KINDS } }).toArray();
  }

  function findForm(path: string): Promise<TriggerDoc | null> {
    return c.triggers.findOne({ kind: "form", path });
  }

  function findChat(path: string): Promise<TriggerDoc | null> {
    return c.triggers.findOne({ kind: "chat", path });
  }

  function findTelegram(path: string): Promise<TriggerDoc | null> {
    return c.triggers.findOne({ kind: "telegram", path });
  }

  async function findWebhook(path: string, test: boolean): Promise<TriggerDoc | null> {
    if (test) {
      return c.triggers.findOne({ kind: "webhook-test", path, expiresAt: { $gt: new Date() }, executionId: null });
    }
    return c.triggers.findOne({ kind: "webhook", path });
  }

  /** Arms the test URL for one request. */
  async function listen(workspaceId: ObjectId, workflowId: ObjectId, nodeId: string, path: string, method: string, userId: string, seconds = 120) {
    await ensureRuntimeIndexes(db);
    await c.triggers.deleteMany({ workflowId, kind: "webhook-test" });
    const expiresAt = new Date(Date.now() + seconds * 1000);
    const doc: TriggerDoc = {
      workspaceId,
      workflowId,
      versionId: null,
      nodeId,
      kind: "webhook-test",
      method,
      path,
      expiresAt,
      executionId: null,
      createdBy: userId,
      createdAt: new Date(),
    };
    const res = await c.triggers.insertOne(doc);
    return { id: res.insertedId, expiresAt };
  }

  /** Marks the listener used; only the first request wins. */
  async function consumeListener(id: ObjectId, executionId: ObjectId): Promise<boolean> {
    const r = await c.triggers.updateOne({ _id: id, executionId: null }, { $set: { executionId } });
    return r.modifiedCount === 1;
  }

  async function listenerStatus(workflowId: ObjectId) {
    const t = await c.triggers.findOne({ workflowId, kind: "webhook-test" }, { sort: { createdAt: -1 } });
    if (!t) return null;
    return { expiresAt: t.expiresAt!, executionId: t.executionId?.toHexString() ?? null, nodeId: t.nodeId };
  }

  async function stopListening(workflowId: ObjectId) {
    await c.triggers.deleteMany({ workflowId, kind: "webhook-test" });
  }

  return { publish, unpublish, activeTriggers, findWebhook, findTelegram, findForm, findChat, listen, consumeListener, listenerStatus, stopListening };
}

export type TriggerService = ReturnType<typeof createTriggerService>;
