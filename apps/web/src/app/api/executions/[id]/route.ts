import { ApiError, json, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

export const GET = route<RouteContext<"/api/executions/[id]">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const detail = await rt().executions.get(workspace.workspaceId, id);
  if (!detail) throw new ApiError(404, "not_found", "Run not found");
  return json(detail);
});
