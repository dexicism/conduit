import type { ExecutionDetail, ExecutionSummary, RunOverview, ListExecutionsQuery, Page, StepSummary } from "@conduit/core";
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

  /**
   * Numbers for the home page: live runs per day for the last `days` days, the
   * busiest workflows and the latest failures. Test runs from the editor are left out.
   */
  async function overview(workspaceId: ObjectId, days = 7, now = new Date()): Promise<RunOverview> {
    const since = new Date(now);
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const match = { workspaceId, startedAt: { $gte: since }, mode: { $ne: "test" as const } };
    const [byDay, byWorkflow, failures, running] = await Promise.all([
      c.executions
        .aggregate<{ _id: { day: string; status: string }; n: number; ms: number }>([
          { $match: match },
          { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$startedAt" } }, status: "$status" }, n: { $sum: 1 }, ms: { $sum: { $ifNull: ["$durationMs", 0] } } } },
        ])
        .toArray(),
      c.executions
        .aggregate<{ _id: ObjectId; name: string; runs: number; failed: number; last: Date }>([
          { $match: match },
          {
            $group: {
              _id: "$workflowId",
              name: { $last: "$workflowName" },
              runs: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              last: { $max: "$startedAt" },
            },
          },
          { $sort: { runs: -1, last: -1 } },
          { $limit: 6 },
        ])
        .toArray(),
      c.executions
        .find({ ...match, status: "failed" }, { projection: { graph: 0, state: 0, triggerItems: 0 } })
        .sort({ startedAt: -1, _id: -1 })
        .limit(5)
        .toArray(),
      c.executions.countDocuments({ workspaceId, status: { $in: ["queued", "running", "waiting"] } }),
    ]);
    const daysOut: RunOverview["days"] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const rows = byDay.filter((r) => r._id.day === key);
      const count = (st: string) => rows.filter((r) => r._id.status === st).reduce((t, r) => t + r.n, 0);
      daysOut.push({ day: key, success: count("success"), failed: count("failed"), other: rows.reduce((t, r) => t + r.n, 0) - count("success") - count("failed") });
    }
    const total = byDay.reduce((t, r) => t + r.n, 0);
    const finished = byDay.filter((r) => r._id.status === "success" || r._id.status === "failed");
    const finishedRuns = finished.reduce((t, r) => t + r.n, 0);
    const succeeded = byDay.filter((r) => r._id.status === "success").reduce((t, r) => t + r.n, 0);
    return {
      since: since.toISOString(),
      total,
      succeeded,
      failed: byDay.filter((r) => r._id.status === "failed").reduce((t, r) => t + r.n, 0),
      running,
      successRate: finishedRuns ? succeeded / finishedRuns : null,
      avgDurationMs: finishedRuns ? Math.round(finished.reduce((t, r) => t + r.ms, 0) / finishedRuns) : null,
      days: daysOut,
      workflows: byWorkflow.map((w) => ({ id: w._id.toHexString(), name: w.name, runs: w.runs, failed: w.failed, lastRunAt: w.last.toISOString() })),
      recentFailures: failures.map((d) => toSummary(d as ExecutionDoc)),
    };
  }

  return { list, get, poll, cancel, getRaw, overview };
}
