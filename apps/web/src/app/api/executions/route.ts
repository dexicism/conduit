import { listExecutionsQuerySchema } from "@conduit/core";
import { ApiError, json, parse, route, searchParamsObject } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const q = parse(listExecutionsQuerySchema, searchParamsObject(req));
  const page = await rt().executions.list(workspace.workspaceId, q);
  if (!page) throw new ApiError(400, "invalid_request", "Invalid pagination cursor");
  return json(page);
});
