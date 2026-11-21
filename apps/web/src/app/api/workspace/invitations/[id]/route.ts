import { ApiError, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { revokeInvitation } from "@/lib/teams";
import { canManage } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/invitations/[id]">;

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can cancel invitations");
  const { id } = await ctx.params;
  if (!(await revokeInvitation(workspace.workspaceId, id))) throw new ApiError(404, "not_found", "Invitation not found");
  return new Response(null, { status: 204 });
});
