import { ApiError, json, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

type Ctx = RouteContext<"/api/credentials/[id]/test">;

/** Health check: tries the account and records the result. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const view = await rt().integrations.test(workspace.workspaceId, id);
  if (!view) throw new ApiError(404, "not_found", "Account not found");
  return json(view);
});
