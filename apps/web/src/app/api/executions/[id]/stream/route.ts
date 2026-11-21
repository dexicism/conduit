import { FINAL_STATUSES } from "@conduit/core";
import { ObjectId } from "mongodb";
import { ApiError, route } from "@/lib/api";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

export const dynamic = "force-dynamic";

const POLL_MS = 300;
const MAX_MS = 10 * 60_000;

/**
 * Server-Sent Events: `step` for each recorded step (in order) and `status`
 * whenever the run's summary changes. Closes when the run finishes.
 */
export const GET = route<RouteContext<"/api/executions/[id]/stream">>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  if (!/^[a-f\d]{24}$/i.test(id)) throw new ApiError(404, "not_found", "Run not found");
  const execId = new ObjectId(id);
  const first = await rt().executions.poll(workspace.workspaceId, execId, -1);
  if (!first) throw new ApiError(404, "not_found", "Run not found");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let last = -1;
      let lastStatus = "";
      const started = Date.now();
      let snapshot: typeof first | null = first;
      try {
        while (!req.signal.aborted && Date.now() - started < MAX_MS) {
          const r = snapshot ?? (await rt().executions.poll(workspace.workspaceId, execId, last));
          snapshot = null;
          if (!r) break;
          for (const s of r.steps) {
            if (s.index <= last) continue;
            send("step", s);
            last = s.index;
          }
          const statusKey = JSON.stringify(r.summary);
          if (statusKey !== lastStatus) {
            send("status", r.summary);
            lastStatus = statusKey;
          }
          if (FINAL_STATUSES.includes(r.summary.status)) break;
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
      } catch (err) {
        if (!req.signal.aborted) send("error", { message: (err as Error).message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
