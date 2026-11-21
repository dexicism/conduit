import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { setWorkspaceCookie } from "@/lib/workspace-cookie";
import { findMemberWorkspace } from "@/lib/workspaces";

const schema = z.object({ workspaceId: z.string().min(1) });

export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const { workspaceId } = parse(schema, await readJson(req));
  const ws = await findMemberWorkspace(user.id, workspaceId);
  if (!ws) throw new ApiError(403, "forbidden", "You are not a member of that workspace");
  return setWorkspaceCookie(json({ id: workspaceId, name: ws.workspaceName, role: ws.role }), workspaceId);
});
