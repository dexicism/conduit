import { isPublishError } from "@conduit/runtime";
import { ObjectId } from "mongodb";
import { ApiError, json, route } from "@/lib/api";
import { env } from "@/lib/env";
import { aiStatus, availableApps, rt } from "@/lib/runtime";
import { getApp, getDefinition } from "@conduit/nodes";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { getWorkflow } from "@/lib/workflows-repo";

type Ctx = RouteContext<"/api/workflows/[id]/publish">;

async function triggersView(workflowId: ObjectId) {
  const list = await rt().triggers.activeTriggers(workflowId);
  return list.map((t) => ({
    nodeId: t.nodeId,
    kind: t.kind,
    method: t.method,
    url: t.kind === "webhook" ? `${env.APP_URL}/hook/${t.path}` : t.kind === "form" ? `${env.APP_URL}/form/${t.path}` : undefined,
    nextRunAt: t.nextRunAt?.toISOString(),
  }));
}

/** Live triggers of the published version. */
export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  return json({ publishedRevision: wf.publishedRevision, publishedAt: wf.publishedAt, triggers: await triggersView(new ObjectId(wf.id)) });
});

export const POST = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot publish workflows");
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  if (wf.status === "archived") throw new ApiError(400, "invalid_request", "Restore the workflow before publishing it");
  if (!aiStatus().enabled) {
    const aiSteps = wf.draft.nodes.filter((n) => !n.disabled && getDefinition(n.type)?.requiresAi);
    if (aiSteps.length) {
      throw new ApiError(400, "validation_failed", "AI isn't configured on this server, so AI steps can't run live", [
        ...aiSteps.map((n) => ({ path: n.id, message: `${n.label}: needs an AI model` })),
      ]);
    }
  }
  // App steps need their app to be set up on this server (e.g. Google needs OAuth client keys).
  const available = new Set(availableApps());
  const unavailable = wf.draft.nodes.filter((n) => {
    const app = !n.disabled ? getDefinition(n.type)?.app : undefined;
    return app && !available.has(app);
  });
  if (unavailable.length) {
    throw new ApiError(400, "validation_failed", "Some steps use apps that aren't set up on this server", [
      ...unavailable.map((n) => ({ path: n.id, message: `${n.label}: ${getApp(getDefinition(n.type)!.app!)?.name ?? "This app"} isn't set up on this server` })),
    ]);
  }
  try {
    const result = await rt().triggers.publish(workspace.workspaceId, new ObjectId(wf.id), user.id);
    return json({ ...result, triggers: await triggersView(new ObjectId(wf.id)) });
  } catch (err) {
    if (isPublishError(err)) {
      throw new ApiError(
        err.conflict ? 409 : 400,
        err.conflict ? "revision_conflict" : "validation_failed",
        err.message,
        err.issues.map((i) => ({ path: i.nodeId ?? "graph", message: i.message })),
      );
    }
    throw err;
  }
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot unpublish workflows");
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  await rt().triggers.unpublish(workspace.workspaceId, new ObjectId(wf.id));
  return new Response(null, { status: 204 });
});
