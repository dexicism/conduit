import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { changeRole, removeMember } from "@/lib/teams";
import { canManage, type Role } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/members/[userId]">;
const patchSchema = z.object({ role: z.enum(["owner", "admin", "editor", "viewer"]) });

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can change roles");
  const { userId } = await ctx.params;
  const { role } = parse(patchSchema, await readJson(req));
  await changeRole(workspace, user.id, userId, role as Role);
  return json({ userId, role });
});

/** Removes a member. Anyone can remove themselves (leave). */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  const { userId } = await ctx.params;
  if (userId !== user.id && !canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can remove members");
  await removeMember(workspace, user.id, userId);
  return new Response(null, { status: 204 });
});
