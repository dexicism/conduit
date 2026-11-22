import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { variableCall, variables } from "@/lib/variables";
import { canEdit } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/variables/[id]">;

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't change variables");
  const { id } = await ctx.params;
  const { value } = parse(z.object({ value: z.string() }), await readJson(req));
  return json(await variableCall(() => variables().update(workspace.workspaceId, user.id, id, { value })));
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't remove variables");
  const { id } = await ctx.params;
  if (!(await variables().remove(workspace.workspaceId, id))) throw new ApiError(404, "not_found", "Variable not found");
  return new Response(null, { status: 204 });
});
