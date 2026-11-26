import { usageSummary } from "@conduit/runtime";
import { json, route, searchParamsObject } from "@/lib/api";
import { db } from "@/lib/db";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

/** Numbers for the home page. */
export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const ws = workspace.workspaceId;
  const workflows = db.collection("workflows");
  const [runs, total, live, connections, nextRun, ai] = await Promise.all([
    rt().executions.overview(ws, 7, new Date(), searchParamsObject(req).tz),
    workflows.countDocuments({ workspaceId: ws, archivedAt: null }),
    workflows.countDocuments({ workspaceId: ws, archivedAt: null, publishedVersionId: { $ne: null } }),
    rt().integrations.collections.credentials.countDocuments({ workspaceId: ws }),
    db.collection("triggers").findOne({ workspaceId: ws, kind: "schedule", nextRunAt: { $ne: null } }, { sort: { nextRunAt: 1 }, projection: { nextRunAt: 1, workflowId: 1 } }),
    usageSummary(db, ws, 7),
  ]);
  const nextWf = nextRun ? await workflows.findOne({ _id: nextRun.workflowId }, { projection: { name: 1 } }) : null;
  return json({
    runs,
    workflows: { total, live },
    connections,
    ai,
    nextScheduled: nextRun && nextWf ? { workflowId: String(nextRun.workflowId), name: String(nextWf.name), at: (nextRun.nextRunAt as Date).toISOString() } : null,
  });
});
