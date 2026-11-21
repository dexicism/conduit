import { ObjectId } from "mongodb";
import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { env } from "@/lib/env";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { getWorkflow } from "@/lib/workflows-repo";

type Ctx = RouteContext<"/api/workflows/[id]/test/listen">;
const bodySchema = z.object({ triggerNodeId: z.string().min(1).max(150) });

/** Arms the test URL of a webhook trigger for one request (2 minutes). */
export const POST = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot run workflows");
  const { id } = await ctx.params;
  const { triggerNodeId } = parse(bodySchema, await readJson(req));
  const wf = await getWorkflow(workspace.workspaceId, id);
  const node = wf.draft.nodes.find((n) => n.id === triggerNodeId);
  if (!node || node.type !== "trigger.webhook") throw new ApiError(400, "invalid_request", "That step is not a webhook trigger");
  const path = String(node.parameters.path ?? "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(path)) throw new ApiError(400, "validation_failed", "Set a valid webhook path first");
  const { expiresAt } = await rt().triggers.listen(
    workspace.workspaceId,
    new ObjectId(wf.id),
    node.id,
    path,
    String(node.parameters.method ?? "POST"),
    user.id,
  );
  return json({ testUrl: `${env.PUBLIC_URL}/hook-test/${path}`, method: node.parameters.method ?? "POST", expiresAt: expiresAt.toISOString() });
});

/** Polled by the editor: tells it which execution the test request started. */
export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  const status = await rt().triggers.listenerStatus(new ObjectId(wf.id));
  return json(status ? { ...status, expiresAt: status.expiresAt.toISOString() } : null);
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  await rt().triggers.stopListening(new ObjectId(wf.id));
  return new Response(null, { status: 204 });
});
