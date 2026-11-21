import { toCredentialView } from "@conduit/runtime";
import { z } from "zod";
import { ApiError, json, parse, readJson, route, searchParamsObject } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/credentials/[id]">;

async function load(req: Request, ctx: Ctx) {
  const ctxs = await requireApiContext(req);
  const { id } = await ctx.params;
  const doc = await rt().integrations.find(ctxs.workspace.workspaceId, id);
  if (!doc) throw new ApiError(404, "not_found", "Account not found");
  return { ...ctxs, id, doc };
}

/** One account, with the workflows that use it. */
export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace, id, doc } = await load(req, ctx);
  return json({ ...toCredentialView(doc), usage: await rt().integrations.usage(workspace.workspaceId, id) });
});

const patchSchema = z.object({ label: z.string().trim().min(1, "Give the account a name").max(80, "Keep the name under 80 characters") });

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { workspace, id } = await load(req, ctx);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't change accounts");
  const { label } = parse(patchSchema, await readJson(req));
  return json(await rt().integrations.rename(workspace.workspaceId, id, label));
});

/** Refused while a published workflow uses the account, unless `?force=1`. */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace, id } = await load(req, ctx);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't remove accounts");
  const usage = await rt().integrations.usage(workspace.workspaceId, id);
  if (usage.published.length && searchParamsObject(req).force !== "1") {
    const names = usage.published.map((w) => `"${w.name}"`).join(", ");
    throw new ApiError(409, "in_use", `Published workflows use this account: ${names}. They'll fail until you choose another account.`, [
      ...usage.published.map((w) => ({ path: w.id, message: w.name })),
    ]);
  }
  await rt().integrations.remove(workspace.workspaceId, id);
  return new Response(null, { status: 204 });
});
