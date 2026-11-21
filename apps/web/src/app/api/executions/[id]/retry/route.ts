import { FINAL_STATUSES } from "@conduit/core";
import { ApiError, json, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

/** Starts a new run with the same trigger data and the same workflow version as the original. */
export const POST = route<RouteContext<"/api/executions/[id]/retry">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot retry runs");
  const { id } = await ctx.params;
  const doc = await rt().executions.getRaw(workspace.workspaceId, id);
  if (!doc) throw new ApiError(404, "not_found", "Run not found");
  if (!FINAL_STATUSES.includes(doc.status)) throw new ApiError(400, "invalid_request", "This run hasn't finished yet");
  const executionId = await rt().runtime.createExecution(
    {
      workspaceId: doc.workspaceId,
      workflowId: doc.workflowId,
      workflowName: doc.workflowName,
      versionId: doc.versionId,
      mode: doc.mode === "subworkflow" ? "test" : doc.mode,
      graph: doc.graph,
      triggerNodeId: doc.triggerNodeId,
      triggerItems: doc.triggerItems,
      isTest: doc.isTest,
    },
    true,
  );
  return json({ executionId: executionId.toHexString() }, 202);
});
