import { ApiError, route } from "@/lib/api";
import { revokeApiKey } from "@/lib/api-keys";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/api-keys/[id]">;

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can revoke API keys");
  const { id } = await ctx.params;
  if (!(await revokeApiKey(workspace.workspaceId, id))) throw new ApiError(404, "not_found", "API key not found");
  return new Response(null, { status: 204 });
});
