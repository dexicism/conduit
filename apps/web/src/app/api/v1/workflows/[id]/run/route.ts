import { getDefinition } from "@conduit/nodes";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { ApiError, json, parse, route } from "@/lib/api";
import { requireApiKey } from "@/lib/api-keys";
import { rt } from "@/lib/runtime";

const schema = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

/**
 * Public API: runs the published version (`executions:run`). Starts from its Manual
 * trigger (or the first trigger) with `input` as the trigger's item.
 */
export const POST = route<RouteContext<"/api/v1/workflows/[id]/run">>(async (req, ctx) => {
  const { workspace } = await requireApiKey(req, "executions:run");
  const { id } = await ctx.params;
  const raw = req.headers.get("content-type")?.includes("application/json") ? await req.json().catch(() => null) : {};
  if (raw === null) throw new ApiError(400, "invalid_request", "Request body is not valid JSON");
  const { input } = parse(schema, raw);
  const { runtime } = rt();
  let target: Awaited<ReturnType<typeof runtime.loadRunnable>>;
  try {
    target = await runtime.loadRunnable(workspace.workspaceId, id, false);
  } catch (err) {
    const msg = (err as Error).message;
    throw new ApiError(/isn't published/.test(msg) ? 409 : 404, /isn't published/.test(msg) ? "invalid_request" : "not_found", /isn't published/.test(msg) ? "Publish the workflow before running it through the API" : "Workflow not found");
  }
  const triggers = target.graph.nodes.filter((n) => getDefinition(n.type)?.category === "trigger" && !n.disabled);
  const trigger = triggers.find((n) => n.type === "trigger.manual") ?? triggers[0];
  if (!trigger) throw new ApiError(400, "invalid_request", "The published workflow has no trigger");
  const executionId = await runtime.createExecution(
    {
      workspaceId: workspace.workspaceId,
      workflowId: target.wf._id as ObjectId,
      workflowName: String(target.wf.name),
      versionId: target.versionId,
      mode: "production",
      graph: target.graph,
      triggerNodeId: trigger.id,
      triggerItems: [{ json: input }],
    },
    true,
  );
  return json({ executionId: executionId.toHexString(), status: "queued" }, 202);
});
