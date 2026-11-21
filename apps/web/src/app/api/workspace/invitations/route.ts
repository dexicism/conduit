import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { invite } from "@/lib/teams";
import { canManage, type Role } from "@/lib/workspaces";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  role: z.enum(["admin", "editor", "viewer"]).default("editor"),
});

export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can invite people");
  const { email, role } = parse(schema, await readJson(req));
  if (role === "admin" && workspace.role !== "owner") throw new ApiError(403, "forbidden", "Only owners can invite admins");
  return json(await invite(workspace, user, email, role as Role), 201);
});
