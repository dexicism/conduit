import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { createCheckout } from "@/lib/billing";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

const schema = z.object({ plan: z.enum(["starter", "pro", "max"]) });

/** Starts a Stripe Checkout for a paid plan. The plan changes when Stripe's webhook confirms payment. */
export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can change the plan");
  const { plan } = parse(schema, await readJson(req));
  return json({ url: await createCheckout(workspace.workspaceId, plan, user.email) });
});
