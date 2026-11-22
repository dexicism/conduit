import "server-only";
import { ObjectId, type Filter, type WithId, type Document, MongoServerError } from "mongodb";
import {
  emptyGraph,
  WORKFLOW_DESCRIPTION_MAX,
  workflowGraphSchema,
  type CreateWorkflowInput,
  type ListWorkflowsQuery,
  type Page,
  type UpdateWorkflowInput,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowStatus,
  type WorkflowSummary,
} from "@conduit/core";
import { getDefinition } from "@conduit/nodes";
import { collections, db, ensureIndexes } from "./db";
import { ApiError } from "./api";

interface WorkflowDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  name: string;
  description: string | null;
  revision: number;
  draft: WorkflowGraph;
  publishedVersionId: ObjectId | null;
  publishedRevision?: number | null;
  publishedAt?: Date | null;
  settings?: { errorWorkflowId?: string | null };
  archivedAt: Date | null;
  requestId?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const coll = () => collections.workflows();

function statusOf(doc: WorkflowDoc): WorkflowStatus {
  if (doc.archivedAt) return "archived";
  return doc.publishedVersionId ? "published" : "draft";
}

function toSummary(doc: WorkflowDoc): WorkflowSummary {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description ?? null,
    status: statusOf(doc),
    revision: doc.revision,
    nodeCount: doc.draft?.nodes?.length ?? 0,
    publishedRevision: doc.publishedVersionId ? (doc.publishedRevision ?? null) : null,
    publishedAt: doc.publishedVersionId && doc.publishedAt ? doc.publishedAt.toISOString() : null,
    settings: { errorWorkflowId: doc.settings?.errorWorkflowId ?? null },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toDetail(doc: WorkflowDoc): WorkflowDetail {
  return { ...toSummary(doc), draft: workflowGraphSchema.parse(doc.draft ?? emptyGraph()) };
}

function oid(id: string): ObjectId {
  if (!ObjectId.isValid(id) || !/^[a-f\d]{24}$/i.test(id)) throw new ApiError(404, "not_found", "Workflow not found");
  return new ObjectId(id);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cursor = base64url("<updatedAt ms>.<id hex>") for stable keyset pagination on (updatedAt desc, _id desc).
function encodeCursor(doc: WorkflowDoc): string {
  return Buffer.from(`${doc.updatedAt.getTime()}.${doc._id.toHexString()}`).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: ObjectId } {
  try {
    const [ms, hex] = Buffer.from(cursor, "base64url").toString("utf8").split(".");
    const t = Number(ms);
    if (!Number.isFinite(t) || !hex || !ObjectId.isValid(hex)) throw new Error("bad");
    return { updatedAt: new Date(t), id: new ObjectId(hex) };
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid pagination cursor");
  }
}

export async function listWorkflows(workspaceId: ObjectId, q: ListWorkflowsQuery): Promise<Page<WorkflowSummary>> {
  await ensureIndexes();
  const and: Filter<Document>[] = [
    { workspaceId },
    q.filter === "archived" ? { archivedAt: { $ne: null } } : { archivedAt: null },
  ];
  if (q.q) and.push({ name: { $regex: escapeRegex(q.q), $options: "i" } });
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    and.push({ $or: [{ updatedAt: { $lt: c.updatedAt } }, { updatedAt: c.updatedAt, _id: { $lt: c.id } }] });
  }
  const docs = (await coll()
    .find({ $and: and }, { projection: { "draft.stickyNotes": 0, "draft.viewport": 0 } })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .toArray()) as unknown as WorkflowDoc[];
  const hasMore = docs.length > q.limit;
  const page = hasMore ? docs.slice(0, q.limit) : docs;
  return { data: page.map(toSummary), nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null };
}

export async function getWorkflow(workspaceId: ObjectId, id: string): Promise<WorkflowDetail> {
  const doc = (await coll().findOne({ _id: oid(id), workspaceId })) as WorkflowDoc | null;
  if (!doc) throw new ApiError(404, "not_found", "Workflow not found");
  return toDetail(doc);
}

export async function createWorkflow(
  workspaceId: ObjectId,
  userId: string,
  input: CreateWorkflowInput,
  graph: WorkflowGraph = emptyGraph(),
): Promise<{ workflow: WorkflowDetail; created: boolean }> {
  await ensureIndexes();
  if (input.requestId) {
    const prior = (await coll().findOne({ workspaceId, requestId: input.requestId })) as WorkflowDoc | null;
    if (prior) return { workflow: toDetail(prior), created: false };
  }
  const now = new Date();
  const doc: WorkflowDoc = {
    _id: new ObjectId(),
    workspaceId,
    name: input.name,
    description: input.description ?? null,
    revision: 0,
    draft: graph,
    publishedVersionId: null,
    archivedAt: null,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await coll().insertOne(doc as unknown as Document);
  } catch (err) {
    // Concurrent retry with the same requestId: return the winner.
    if (err instanceof MongoServerError && err.code === 11000 && input.requestId) {
      const winner = (await coll().findOne({ workspaceId, requestId: input.requestId })) as WorkflowDoc | null;
      if (winner) return { workflow: toDetail(winner), created: false };
    }
    throw err;
  }
  return { workflow: toDetail(doc), created: true };
}

export async function updateWorkflow(
  workspaceId: ObjectId,
  userId: string,
  id: string,
  input: UpdateWorkflowInput,
): Promise<WorkflowDetail> {
  const _id = oid(id);
  const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: userId };
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
  if (input.settings?.errorWorkflowId !== undefined) {
    const target = input.settings.errorWorkflowId;
    if (target !== null) {
      if (target === id) throw new ApiError(400, "validation_failed", "A workflow can't be its own error workflow");
      const exists = await coll().countDocuments({ _id: new ObjectId(target), workspaceId });
      if (!exists) throw new ApiError(400, "validation_failed", "Error workflow not found");
    }
    set["settings.errorWorkflowId"] = target;
  }
  // Archiving takes the workflow offline: its webhooks and schedules stop.
  if (input.archived === true) {
    set.publishedVersionId = null;
    set.publishedRevision = null;
    set.publishedAt = null;
  }
  const doc = (await coll().findOneAndUpdate({ _id, workspaceId }, { $set: set }, { returnDocument: "after" })) as WorkflowDoc | null;
  if (!doc) throw new ApiError(404, "not_found", "Workflow not found");
  if (input.archived === true) await db.collection("triggers").deleteMany({ workflowId: _id });
  return toDetail(doc);
}

/**
 * Saves the editor draft with optimistic concurrency: succeeds only when the stored
 * revision equals `expectedRevision`, then increments it.
 */
export async function saveDraft(
  workspaceId: ObjectId,
  userId: string,
  id: string,
  expectedRevision: number,
  graph: WorkflowGraph,
): Promise<{ revision: number; updatedAt: string }> {
  const _id = oid(id);
  const now = new Date();
  const doc = (await coll().findOneAndUpdate(
    { _id, workspaceId, revision: expectedRevision },
    { $set: { draft: graph, updatedAt: now, updatedBy: userId }, $inc: { revision: 1 } },
    { returnDocument: "after", projection: { revision: 1, updatedAt: 1 } },
  )) as Pick<WorkflowDoc, "revision" | "updatedAt"> | null;
  if (doc) return { revision: doc.revision, updatedAt: doc.updatedAt.toISOString() };

  const current = (await coll().findOne({ _id, workspaceId }, { projection: { revision: 1 } })) as Pick<
    WorkflowDoc,
    "revision"
  > | null;
  if (!current) throw new ApiError(404, "not_found", "Workflow not found");
  const err = new ApiError(
    409,
    "revision_conflict",
    "This workflow was changed somewhere else since you opened it.",
  );
  err.issues = [{ path: "currentRevision", message: String(current.revision) }];
  throw err;
}

export async function duplicateWorkflow(workspaceId: ObjectId, userId: string, id: string): Promise<WorkflowDetail> {
  const source = await getWorkflow(workspaceId, id);
  const suffix = " (copy)";
  const base = source.name.slice(0, 150 - suffix.length);
  const { workflow } = await createWorkflow(
    workspaceId,
    userId,
    { name: base + suffix, description: source.description },
    source.draft,
  );
  return workflow;
}

export async function deleteWorkflow(workspaceId: ObjectId, id: string): Promise<void> {
  const _id = oid(id);
  const res = await coll().deleteOne({ _id, workspaceId });
  if (res.deletedCount === 0) throw new ApiError(404, "not_found", "Workflow not found");
  // Stop anything that could still start it. Past run logs expire on their own.
  await Promise.all([
    db.collection("triggers").deleteMany({ workflowId: _id }),
    db.collection("workflow_versions").deleteMany({ workflowId: _id }),
  ]);
}

export type { WithId };

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export interface VersionSummary {
  id: string;
  revision: number;
  publishedAt: string;
  publishedBy: string | null;
  stepCount: number;
  live: boolean;
}

/** Every publish of a workflow, newest first. */
export async function listVersions(workspaceId: ObjectId, id: string, limit = 50): Promise<VersionSummary[]> {
  const wf = await getWorkflow(workspaceId, id);
  const _id = oid(id);
  const docs = await db
    .collection("workflow_versions")
    .find({ workflowId: _id, workspaceId }, { projection: { revision: 1, publishedAt: 1, publishedBy: 1, "graph.nodes.id": 1 } })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .toArray();
  const userIds = [...new Set(docs.map((d) => String(d.publishedBy ?? "")).filter((u) => ObjectId.isValid(u)))];
  const users = userIds.length
    ? await db
        .collection("user")
        .find({ _id: { $in: userIds.map((u) => new ObjectId(u)) } }, { projection: { name: 1, email: 1 } })
        .toArray()
    : [];
  const names = new Map(users.map((u) => [u._id.toHexString(), String(u.name || u.email || "")]));
  const liveId = wf.status === "published" ? await coll().findOne({ _id }, { projection: { publishedVersionId: 1 } }) : null;
  return docs.map((d) => ({
    id: d._id.toHexString(),
    revision: Number(d.revision ?? 0),
    publishedAt: (d.publishedAt as Date).toISOString(),
    publishedBy: names.get(String(d.publishedBy)) ?? null,
    stepCount: Array.isArray(d.graph?.nodes) ? d.graph.nodes.length : 0,
    live: Boolean(liveId?.publishedVersionId && String(liveId.publishedVersionId) === d._id.toHexString()),
  }));
}

/**
 * Puts an old published version back into the editor. The live version doesn't
 * change until you publish again, so a restore can't break anything that's running.
 */
export async function restoreVersion(workspaceId: ObjectId, userId: string, id: string, versionId: string): Promise<WorkflowDetail> {
  const _id = oid(id);
  if (!ObjectId.isValid(versionId)) throw new ApiError(404, "not_found", "Version not found");
  const version = await db.collection("workflow_versions").findOne({ _id: new ObjectId(versionId), workflowId: _id, workspaceId });
  if (!version) throw new ApiError(404, "not_found", "Version not found");
  const graph = workflowGraphSchema.parse(version.graph);
  const doc = (await coll().findOneAndUpdate(
    { _id, workspaceId },
    { $set: { draft: graph, updatedAt: new Date(), updatedBy: userId }, $inc: { revision: 1 } },
    { returnDocument: "after" },
  )) as WorkflowDoc | null;
  if (!doc) throw new ApiError(404, "not_found", "Workflow not found");
  return toDetail(doc);
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = "conduit-workflow";

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey)$|token|secret|password/i;

/** A value that only points somewhere (a variable or another step) holds no secret itself. */
const onlyReferences = (v: unknown) => typeof v === "string" && /^\s*(\$\{\[[^}]*\]\}\s*)+$/.test(v);

/**
 * Clears what shouldn't travel in a shared file: the accounts picked in each
 * step, secrets typed into fields marked sensitive, and auth-looking HTTP
 * headers. References like ${['$vars']['TOKEN']} are kept, since they hold no secret.
 */
export function stripCredentials(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const fields = getDefinition(n.type)?.fields ?? [];
      const parameters = { ...n.parameters };
      for (const f of fields) {
        if (!(f.name in parameters)) continue;
        if (f.kind === "credential") parameters[f.name] = "";
        else if (f.kind === "string" && f.sensitive && !onlyReferences(parameters[f.name])) parameters[f.name] = "";
        else if (f.kind === "keyValue" && Array.isArray(parameters[f.name])) {
          parameters[f.name] = (parameters[f.name] as Array<{ key?: unknown; value?: unknown }>).map((h) =>
            SECRET_HEADER.test(String(h?.key ?? "")) && !onlyReferences(h?.value) ? { ...h, value: "" } : h,
          );
        }
      }
      return { ...n, parameters };
    }),
  };
}

export async function exportWorkflow(workspaceId: ObjectId, id: string) {
  const wf = await getWorkflow(workspaceId, id);
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    name: wf.name,
    description: wf.description,
    graph: stripCredentials(wf.draft),
  };
}

/**
 * Creates a workflow from an exported file. Steps whose app has exactly one
 * connected account in this workspace get that account; the rest are left for you to pick.
 */
export async function importWorkflow(workspaceId: ObjectId, userId: string, file: unknown): Promise<{ workflow: WorkflowDetail; needsAccounts: number }> {
  const f = file as { format?: unknown; name?: unknown; description?: unknown; graph?: unknown } | null;
  if (!f || typeof f !== "object" || f.format !== EXPORT_FORMAT) {
    throw new ApiError(400, "validation_failed", "That isn't a Conduit workflow file");
  }
  const parsed = workflowGraphSchema.safeParse(f.graph);
  if (!parsed.success) throw new ApiError(400, "validation_failed", "The workflow in this file is damaged or from a newer version");
  const unknown = [...new Set(parsed.data.nodes.filter((n) => !getDefinition(n.type)).map((n) => n.type))];
  if (unknown.length) throw new ApiError(400, "validation_failed", `This file uses steps this version doesn't have: ${unknown.slice(0, 5).join(", ")}`);

  const graph = stripCredentials(parsed.data);
  const creds = await db.collection("credentials").find({ workspaceId }, { projection: { app: 1 } }).toArray();
  const byApp = new Map<string, string[]>();
  for (const c of creds) byApp.set(String(c.app), [...(byApp.get(String(c.app)) ?? []), c._id.toHexString()]);
  let needsAccounts = 0;
  for (const n of graph.nodes) {
    for (const field of getDefinition(n.type)?.fields ?? []) {
      if (field.kind !== "credential" || !(field.name in n.parameters)) continue;
      const options = byApp.get(field.app) ?? [];
      if (options.length === 1) n.parameters[field.name] = options[0];
      else if (field.required) needsAccounts++;
    }
  }
  const rawName = typeof f.name === "string" && f.name.trim() ? f.name.trim() : "Imported workflow";
  const name = rawName.slice(0, 150);
  const description = typeof f.description === "string" ? f.description.slice(0, WORKFLOW_DESCRIPTION_MAX) : null;
  const { workflow } = await createWorkflow(workspaceId, userId, { name, description }, graph);
  return { workflow, needsAccounts };
}
