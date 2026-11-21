import { ApiError, json, route } from "@/lib/api";
import { requireApiKey } from "@/lib/api-keys";
import { rt } from "@/lib/runtime";

/** Public API: one run with its steps (`executions:read`). */
export const GET = route<RouteContext<"/api/v1/executions/[id]">>(async (req, ctx) => {
  const { workspace } = await requireApiKey(req, "executions:read");
  const { id } = await ctx.params;
  const detail = await rt().executions.get(workspace.workspaceId, id);
  if (!detail) throw new ApiError(404, "not_found", "Run not found");
  return json(detail);
});
