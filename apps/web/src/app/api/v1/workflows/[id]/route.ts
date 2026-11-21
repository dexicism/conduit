import { json, route } from "@/lib/api";
import { requireApiKey } from "@/lib/api-keys";
import { getWorkflow } from "@/lib/workflows-repo";

/** Public API: one workflow with its draft (`workflows:read`). */
export const GET = route<RouteContext<"/api/v1/workflows/[id]">>(async (req, ctx) => {
  const { workspace } = await requireApiKey(req, "workflows:read");
  const { id } = await ctx.params;
  return json(await getWorkflow(workspace.workspaceId, id));
});
