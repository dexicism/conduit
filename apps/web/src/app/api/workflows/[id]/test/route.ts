import { testRunInputSchema } from "@conduit/core";
import { getDefinition } from "@conduit/nodes";
import { triggerItemsFor } from "@conduit/runtime";
import { ObjectId } from "mongodb";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { getWorkflow } from "@/lib/workflows-repo";

/** Runs the saved draft once from the chosen trigger, in test mode. */
export const POST = route<RouteContext<"/api/workflows/[id]/test">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot run workflows");
  const { id } = await ctx.params;
  const input = parse(testRunInputSchema, await readJson(req));
  const wf = await getWorkflow(workspace.workspaceId, id);
  if (input.expectedRevision !== undefined && input.expectedRevision !== wf.revision) {
    throw new ApiError(409, "revision_conflict", "Save your latest changes before running");
  }

  const triggers = wf.draft.nodes.filter((n) => getDefinition(n.type)?.category === "trigger" && !n.disabled);
  const trigger = input.triggerNodeId
    ? triggers.find((n) => n.id === input.triggerNodeId)
    : (triggers.find((n) => n.type === "trigger.manual") ?? triggers[0]);
  if (!trigger) throw new ApiError(400, "invalid_request", "Add a trigger to run this workflow");
  if (trigger.type === "trigger.webhook") {
    throw new ApiError(400, "invalid_request", "Webhook triggers run when a request arrives. Use “Listen for a test request”.");
  }

  const executionId = await rt().runtime.createExecution(
    {
      workspaceId: workspace.workspaceId,
      workflowId: new ObjectId(wf.id),
      workflowName: wf.name,
      versionId: null,
      mode: "test",
      graph: wf.draft,
      triggerNodeId: trigger.id,
      triggerItems: triggerItemsFor(trigger.type, new Date(), trigger.parameters),
    },
    true,
  );
  return json({ executionId: executionId.toHexString() }, 202);
});
