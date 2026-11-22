import { json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { listVersions } from "@/lib/workflows-repo";

/** Every published version, newest first. */
export const GET = route<RouteContext<"/api/workflows/[id]/versions">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  return json({ versions: await listVersions(workspace.workspaceId, id) });
});
