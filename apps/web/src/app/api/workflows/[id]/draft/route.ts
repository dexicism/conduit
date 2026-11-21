import { saveDraftInputSchema, validateGraphStructure } from "@conduit/core";
import { validateGraphWithRegistry } from "@conduit/nodes";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { saveDraft } from "@/lib/workflows-repo";

const MAX_BODY_BYTES = 2_000_000;

export const PUT = route<RouteContext<"/api/workflows/[id]/draft">>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot edit workflows");
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(400, "invalid_request", "Workflow is too large to save");

  const { id } = await ctx.params;
  const input = parse(saveDraftInputSchema, await readJson(req));

  // Drafts may be incomplete (missing parameters are fine), but must be structurally sound.
  const issues = [...validateGraphStructure(input.graph), ...validateGraphWithRegistry(input.graph)];
  if (issues.length) {
    throw new ApiError(
      400,
      "validation_failed",
      issues[0]!.message,
      issues.map((i) => ({ path: i.nodeId ?? "graph", message: i.message })),
    );
  }

  return json(await saveDraft(workspace.workspaceId, user.id, id, input.expectedRevision, input.graph));
});
