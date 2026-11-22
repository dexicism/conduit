import { getTemplate, templateGraph } from "@conduit/nodes";
import { workflowGraphSchema } from "@conduit/core";
import { ApiError, json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { createWorkflow } from "@/lib/workflows-repo";

type Ctx = RouteContext<"/api/templates/[id]">;

/** Creates a new workflow from a template. You still pick your accounts in the editor. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot create workflows");
  const t = getTemplate((await ctx.params).id);
  if (!t) throw new ApiError(404, "not_found", "Template not found");
  const graph = workflowGraphSchema.parse(templateGraph(t));
  const { workflow } = await createWorkflow(workspace.workspaceId, user.id, { name: t.name, description: t.description }, graph);
  return json(workflow, 201);
});
