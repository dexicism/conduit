import { OUTBOUND_EVENTS } from "@conduit/runtime";
import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canManage } from "@/lib/workspaces";

function outbound() {
  const o = rt().runtime.outbound;
  if (!o) throw new ApiError(400, "invalid_request", "Webhooks aren't available on this server");
  return o;
}

export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage webhooks");
  return json({ webhooks: await outbound().list(workspace.workspaceId), events: OUTBOUND_EVENTS });
});

const schema = z.object({
  url: z.string().trim().url("Enter a full URL").refine((u) => /^https?:\/\//i.test(u), "Use an http or https URL"),
  events: z.array(z.enum(OUTBOUND_EVENTS)).min(1, "Choose at least one event"),
});

/** Adds an endpoint. The signing secret is in this response only. */
export const POST = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  if (!canManage(workspace.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage webhooks");
  const { url, events } = parse(schema, await readJson(req));
  return json(await outbound().create(workspace.workspaceId, url, [...new Set(events)]), 201);
});
