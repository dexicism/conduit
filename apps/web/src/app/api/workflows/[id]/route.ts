import { updateWorkflowInputSchema } from "@conduit/core";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { deleteWorkflow, getWorkflow, updateWorkflow } from "@/lib/workflows-repo";

type Ctx = RouteContext<"/api/workflows/[id]">;

export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  return json(await getWorkflow(workspace.workspaceId, id));
});

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot edit workflows");
  const { id } = await ctx.params;
  const input = parse(updateWorkflowInputSchema, await readJson(req));
  return json(await updateWorkflow(workspace.workspaceId, user.id, id, input));
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot delete workflows");
  const { id } = await ctx.params;
  await deleteWorkflow(workspace.workspaceId, id);
  return new Response(null, { status: 204 });
});
