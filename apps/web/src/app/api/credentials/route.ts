import { validateAppFields } from "@conduit/nodes";
import { toCredentialView } from "@conduit/runtime";
import { z } from "zod";
import { ApiError, json, parse, readJson, route, searchParamsObject } from "@/lib/api";
import { appCall, appCatalog, requireAvailableApp } from "@/lib/connections";
import { env } from "@/lib/env";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

/** Connected accounts in the workspace (no secrets), plus the apps that can be connected. */
export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const { app } = searchParamsObject(req);
  const credentials = await rt().integrations.list(workspace.workspaceId, app || undefined);
  return json({ credentials, apps: appCatalog(), publicUrl: env.PUBLIC_URL });
});

const createSchema = z.object({
  app: z.string().min(1),
  label: z.string().trim().min(1, "Give the account a name").max(80, "Keep the name under 80 characters"),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
});

/** Saves a form-based account after checking it works. OAuth apps use /oauth/:app/start. */
export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't connect accounts");
  const body = parse(createSchema, await readJson(req));
  const app = requireAvailableApp(body.app);
  if (app.auth.kind !== "fields") throw new ApiError(400, "invalid_request", `${app.name} connects with sign-in`);
  const { values, errors } = validateAppFields(app, body.values);
  const issues = Object.entries(errors).map(([path, message]) => ({ path: `values.${path}`, message }));
  if (issues.length) throw new ApiError(400, "validation_failed", issues[0]!.message, issues);

  const { integrations } = rt();
  const account = await appCall(() => integrations.check(app.id, values)).catch((err: ApiError) => {
    throw new ApiError(400, "validation_failed", `Couldn't connect: ${err.message}`);
  });
  const doc = await integrations.create({ workspaceId: workspace.workspaceId, userId: user.id, app: app.id, label: body.label, values, account: account ?? undefined });
  await integrations.collections.credentials.updateOne({ _id: doc._id }, { $set: { testedAt: new Date() } });
  return json(toCredentialView({ ...doc, testedAt: new Date() }), 201);
});
