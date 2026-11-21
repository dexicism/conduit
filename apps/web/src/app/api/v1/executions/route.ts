import { listExecutionsQuerySchema } from "@conduit/core";
import { ApiError, json, parse, route, searchParamsObject } from "@/lib/api";
import { requireApiKey } from "@/lib/api-keys";
import { rt } from "@/lib/runtime";

/** Public API: list runs (`executions:read`). */
export const GET = route(async (req) => {
  const { workspace } = await requireApiKey(req, "executions:read");
  const page = await rt().executions.list(workspace.workspaceId, parse(listExecutionsQuerySchema, searchParamsObject(req)));
  if (!page) throw new ApiError(400, "invalid_request", "Invalid pagination cursor");
  return json(page);
});
