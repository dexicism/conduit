import { ApiError, json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { restoreVersion } from "@/lib/workflows-repo";

/** Copies an old version into the draft. What's live stays live until the next publish. */
export const POST = route<RouteContext<"/api/workflows/[id]/versions/[versionId]/restore">>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't restore versions");
  const { id, versionId } = await ctx.params;
  return json(await restoreVersion(workspace.workspaceId, user.id, id, versionId));
});
