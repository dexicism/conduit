import { ApiError, json, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspace/webhooks/[id]/test">;

/** Sends a test event right away and returns the endpoint's latest delivery. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage webhooks");
  const { id } = await ctx.params;
  const out = rt().runtime.outbound;
  if (!out || !(await out.sendTest(workspace.workspaceId, id))) throw new ApiError(404, "not_found", "Webhook not found");
  const hook = (await out.list(workspace.workspaceId)).find((h) => h.id === id);
  return json({ delivery: hook?.recent[0] ?? null });
});
