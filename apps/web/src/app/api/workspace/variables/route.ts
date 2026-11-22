import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { variableCall, variables } from "@/lib/variables";
import { canEdit } from "@/lib/workspaces";

/** Workspace variables. Secret values are never sent back. */
export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  return json({ variables: await variables().list(workspace.workspaceId) });
});

const schema = z.object({
  name: z.string().trim().min(1, "Name the variable"),
  value: z.string(),
  secret: z.boolean().default(false),
});

export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't add variables");
  const input = parse(schema, await readJson(req));
  return json(await variableCall(() => variables().create(workspace.workspaceId, user.id, input)), 201);
});
