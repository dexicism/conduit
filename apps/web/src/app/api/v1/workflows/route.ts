import { listWorkflowsQuerySchema } from "@conduit/core";
import { json, parse, route, searchParamsObject } from "@/lib/api";
import { requireApiKey } from "@/lib/api-keys";
import { listWorkflows } from "@/lib/workflows-repo";

/** Public API: list workflows (`workflows:read`). */
export const GET = route(async (req) => {
  const { workspace } = await requireApiKey(req, "workflows:read");
  return json(await listWorkflows(workspace.workspaceId, parse(listWorkflowsQuerySchema, searchParamsObject(req))));
});
