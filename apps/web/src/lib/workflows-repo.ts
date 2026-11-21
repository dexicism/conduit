import "server-only";
import { ObjectId, type Filter, type WithId, type Document, MongoServerError } from "mongodb";
import {
  emptyGraph,
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
