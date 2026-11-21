import { ApiError, json, route } from "@/lib/api";
import { createPortal } from "@/lib/billing";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

/** Stripe's customer portal: change or cancel the plan, update the card, download invoices. */
export const POST = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage billing");
  return json({ url: await createPortal(workspace.workspaceId) });
});
