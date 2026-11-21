import { z } from "zod";
import { json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { setWorkspaceCookie } from "@/lib/workspace-cookie";
import { createTeamWorkspace, listUserWorkspaces } from "@/lib/workspaces";

/** Workspaces the user belongs to, and which one is current. */
export const GET = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  return json({ current: workspace.workspaceId.toHexString(), workspaces: await listUserWorkspaces(user.id) });
});

const createSchema = z.object({ name: z.string().trim().min(1, "Name the team").max(80, "Keep the name under 80 characters") });

/** Creates a team workspace (the caller is its owner) and switches to it. */
export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const { name } = parse(createSchema, await readJson(req));
  const ws = await createTeamWorkspace(user.id, name);
  return setWorkspaceCookie(json(ws, 201), ws.id);
});
