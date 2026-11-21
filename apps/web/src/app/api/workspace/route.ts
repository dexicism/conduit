import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { renameWorkspace } from "@/lib/teams";
import { canManage } from "@/lib/workspaces";

export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  return json({
    id: workspace.workspaceId.toHexString(),
    name: workspace.workspaceName,
    role: workspace.role,
    plan: workspace.plan,
    personal: workspace.personal,
  });
});

const patchSchema = z.object({ name: z.string().trim().min(1, "Name the workspace").max(80, "Keep the name under 80 characters") });

export const PATCH = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can rename the workspace");
  const { name } = parse(patchSchema, await readJson(req));
  await renameWorkspace(workspace.workspaceId, name);
  return json({ id: workspace.workspaceId.toHexString(), name });
});
