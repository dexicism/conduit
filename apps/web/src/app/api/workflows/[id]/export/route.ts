import { route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { exportWorkflow } from "@/lib/workflows-repo";

/** The workflow as a JSON file, with connected accounts left out. */
export const GET = route<RouteContext<"/api/workflows/[id]/export">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const file = await exportWorkflow(workspace.workspaceId, id);
  const slug = file.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workflow";
  return new Response(JSON.stringify(file, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${slug}.conduit.json"`, "cache-control": "no-store" },
  });
});
