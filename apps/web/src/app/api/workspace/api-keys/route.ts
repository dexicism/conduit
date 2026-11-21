import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { API_SCOPES, createApiKey, listApiKeys } from "@/lib/api-keys";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can see API keys");
  return json({ keys: await listApiKeys(workspace.workspaceId), scopes: API_SCOPES });
});

const schema = z.object({
  name: z.string().trim().min(1, "Name the key").max(80, "Keep the name under 80 characters"),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Choose at least one permission"),
});

/** Creates a key. The response is the only time the full key is shown. */
export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can create API keys");
  const { name, scopes } = parse(schema, await readJson(req));
  return json(await createApiKey(workspace.workspaceId, user.id, name, [...new Set(scopes)]), 201);
});
