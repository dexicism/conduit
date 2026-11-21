import type { ExecutionDetail, ExecutionSummary, ListExecutionsQuery, Page, StepSummary } from "@conduit/core";
import { ObjectId, type Db, type Filter } from "mongodb";
import { collections, toDetail, toStepSummary, toSummary, type ExecutionDoc } from "./store";

function encodeCursor(d: ExecutionDoc): string {
  return Buffer.from(`${d.startedAt.getTime()}.${d._id.toHexString()}`).toString("base64url");
}

function decodeCursor(cursor: string): { t: Date; id: ObjectId } | null {
  try {
    const [ms, hex] = Buffer.from(cursor, "base64url").toString("utf8").split(".");
    if (!hex || !ObjectId.isValid(hex) || !Number.isFinite(Number(ms))) return null;
    return { t: new Date(Number(ms)), id: new ObjectId(hex) };
  } catch {
    return null;
  }
}

export function createExecutionQueries(db: Db) {
  const c = collections(db);

  async function list(workspaceId: ObjectId, q: ListExecutionsQuery): Promise<Page<ExecutionSummary> | null> {
    const and: Filter<ExecutionDoc>[] = [{ workspaceId }];
    if (q.workflowId) and.push({ workflowId: new ObjectId(q.workflowId) });
    if (q.status) and.push({ status: q.status });
    if (q.mode) and.push({ mode: q.mode });
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) return null;
      and.push({ $or: [{ startedAt: { $lt: cur.t } }, { startedAt: cur.t, _id: { $lt: cur.id } }] });
    }
    const docs = await c.executions
      .find({ $and: and }, { projection: { graph: 0, state: 0, triggerItems: 0 } })
      .sort({ startedAt: -1, _id: -1 })
      .limit(q.limit + 1)
      .toArray();
    const more = docs.length > q.limit;
    const page = more ? docs.slice(0, q.limit) : docs;
    return { data: page.map(toSummary), nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
  }

  async function get(workspaceId: ObjectId, id: string): Promise<ExecutionDetail | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    const doc = await c.executions.findOne({ _id: new ObjectId(id), workspaceId }, { projection: { state: 0 } });
    if (!doc) return null;
    const steps = await c.steps.find({ executionId: doc._id }).sort({ index: 1 }).toArray();
    return toDetail(doc as ExecutionDoc, steps);
  }

  /** Steps recorded after `afterIndex`, plus the current summary. Used by the live stream. */
  async function poll(workspaceId: ObjectId, id: ObjectId, afterIndex: number): Promise<{ summary: ExecutionSummary; steps: StepSummary[] } | null> {
    const doc = await c.executions.findOne({ _id: id, workspaceId }, { projection: { graph: 0, state: 0, triggerItems: 0 } });
    if (!doc) return null;
    const steps = await c.steps.find({ executionId: id, index: { $gt: afterIndex } }).sort({ index: 1 }).toArray();
    return { summary: toSummary(doc as ExecutionDoc), steps: steps.map(toStepSummary) };
  }

  async function cancel(workspaceId: ObjectId, id: string): Promise<ExecutionSummary | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    const _id = new ObjectId(id);
    const now = new Date();
    const doc = await c.executions.findOneAndUpdate(
      { _id, workspaceId, status: { $in: ["queued", "waiting", "running"] } },
      { $set: { status: "canceled", finishedAt: now, error: { message: "Canceled" } } },
      { returnDocument: "after", projection: { graph: 0, state: 0, triggerItems: 0 } },
    );
    if (doc) await c.jobs.deleteMany({ executionId: _id });
    const current = doc ?? (await c.executions.findOne({ _id, workspaceId }, { projection: { graph: 0, state: 0, triggerItems: 0 } }));
    if (current && current.startedAt && !current.durationMs && current.finishedAt) {
      await c.executions.updateOne({ _id }, { $set: { durationMs: current.finishedAt.getTime() - current.startedAt.getTime() } });
    }
    return current ? toSummary(current as ExecutionDoc) : null;
  }

  async function getRaw(workspaceId: ObjectId, id: string): Promise<ExecutionDoc | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    return c.executions.findOne({ _id: new ObjectId(id), workspaceId });
  }

  return { list, get, poll, cancel, getRaw };
}
