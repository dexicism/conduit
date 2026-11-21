import { ApiError, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/webhooks/[id]">;

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage webhooks");
  const { id } = await ctx.params;
  if (!(await rt().runtime.outbound?.remove(workspace.workspaceId, id))) throw new ApiError(404, "not_found", "Webhook not found");
  return new Response(null, { status: 204 });
});
