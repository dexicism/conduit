import { ApiError, json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { duplicateWorkflow } from "@/lib/workflows-repo";

export const POST = route<RouteContext<"/api/workflows/[id]/duplicate">>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot duplicate workflows");
  const { id } = await ctx.params;
  return json(await duplicateWorkflow(workspace.workspaceId, user.id, id), 201);
});
