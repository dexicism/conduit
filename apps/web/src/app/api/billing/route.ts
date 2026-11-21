import { PLANS } from "@conduit/core";
import { json, route } from "@/lib/api";
import { billingEnabled, listInvoices } from "@/lib/billing";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

/** Plan, credit balances, recent credit activity and (for managers) invoices. */
export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const { credits } = rt().runtime;
  const manage = canManage(workspace.role);
  return json({
    plan: workspace.plan,
    plans: Object.values(PLANS),
    balance: await credits.view(workspace.workspaceId),
    history: await credits.history(workspace.workspaceId, 30),
    canManage: manage,
    billingEnabled: billingEnabled(),
    invoices: manage ? await listInvoices(workspace.workspaceId) : [],
  });
});
