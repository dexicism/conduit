import { createWorkflowInputSchema, listWorkflowsQuerySchema } from "@conduit/core";
import { ApiError, json, parse, readJson, route, searchParamsObject } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { createWorkflow, listWorkflows } from "@/lib/workflows-repo";

export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const query = parse(listWorkflowsQuerySchema, searchParamsObject(req));
  return json(await listWorkflows(workspace.workspaceId, query));
});

export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot create workflows");
  const input = parse(createWorkflowInputSchema, await readJson(req));
  const { workflow, created } = await createWorkflow(workspace.workspaceId, user.id, input);
  return json(workflow, created ? 201 : 200);
});
