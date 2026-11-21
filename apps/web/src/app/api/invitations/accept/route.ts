import { z } from "zod";
import { json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { acceptInvitation } from "@/lib/teams";
import { setWorkspaceCookie } from "@/lib/workspace-cookie";

const schema = z.object({ token: z.string().min(20).max(200) });

/** Joins the workspace and switches to it. */
export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const { token } = parse(schema, await readJson(req));
  const workspaceId = await acceptInvitation(token, user);
  return setWorkspaceCookie(json({ workspaceId }), workspaceId);
});
