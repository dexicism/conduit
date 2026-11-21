import { ApiError, json, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

export const POST = route<RouteContext<"/api/executions/[id]/cancel">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot cancel runs");
  const { id } = await ctx.params;
  const summary = await rt().executions.cancel(workspace.workspaceId, id);
  if (!summary) throw new ApiError(404, "not_found", "Run not found");
  return json(summary);
});
