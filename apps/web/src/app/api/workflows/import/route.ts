import { ApiError, json, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { importWorkflow } from "@/lib/workflows-repo";

const MAX_BYTES = 2_000_000;

/** Creates a workflow from an exported file. */
export const POST = route(async (req) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot create workflows");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) throw new ApiError(413, "invalid_request", "That file is too big");
  const { workflow, needsAccounts } = await importWorkflow(workspace.workspaceId, user.id, await readJson(req));
  return json({ workflow, needsAccounts }, 201);
});
