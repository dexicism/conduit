import { DEFAULT_MODEL } from "@conduit/nodes";
import { runBuilder } from "@conduit/runtime";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { db } from "@/lib/db";
import { aiStatus, rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";
import { getWorkflow, saveDraft } from "@/lib/workflows-repo";

type Ctx = RouteContext<"/api/workflows/[id]/builder">;

export interface BuilderMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  summary?: { added: string[]; updated: string[]; deleted: string[] };
}

interface ConversationDoc {
  workflowId: ObjectId;
  workspaceId: ObjectId;
  messages: Array<Omit<BuilderMessage, "at"> & { at: Date }>;
  updatedAt: Date;
}

const conversations = () => db.collection<ConversationDoc>("builder_conversations");
const bodySchema = z.object({
  message: z.string().trim().min(1, "Describe what you want to build").max(4000, "Keep requests under 4,000 characters"),
  expectedRevision: z.number().int().min(0),
});

function toView(m: ConversationDoc["messages"][number]): BuilderMessage {
  return { role: m.role, text: m.text, at: m.at.toISOString(), ...(m.summary ? { summary: m.summary } : {}) };
}

export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  const doc = await conversations().findOne({ workflowId: new ObjectId(wf.id), workspaceId: workspace.workspaceId });
  return json({ messages: (doc?.messages ?? []).map(toView) });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { workspace } = await requireApiContext(req);
  const { id } = await ctx.params;
  const wf = await getWorkflow(workspace.workspaceId, id);
  await conversations().deleteOne({ workflowId: new ObjectId(wf.id), workspaceId: workspace.workspaceId });
  return new Response(null, { status: 204 });
});

/** One builder turn: the model edits the saved draft; the result is saved as a new revision. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers cannot edit workflows");
  if (!aiStatus().enabled) throw new ApiError(400, "invalid_request", "AI isn't configured on this server");
  const { id } = await ctx.params;
  const { message, expectedRevision } = parse(bodySchema, await readJson(req));
  const wf = await getWorkflow(workspace.workspaceId, id);
  if (wf.revision !== expectedRevision) {
    throw new ApiError(409, "revision_conflict", "This workflow changed since you opened it. Reload, then ask again.");
  }

  const workflowId = new ObjectId(wf.id);
  const convo = await conversations().findOne({ workflowId, workspaceId: workspace.workspaceId });
  const history = (convo?.messages ?? []).map((m) => ({ role: m.role, text: m.text }));

  // One Builder credit per message on a paid model; refunded if the model call fails.
  const { runtime, ai } = rt();
  const billable = ai.provider === "anthropic";
  if (billable && !(await runtime.credits.debit(workspace.workspaceId, 1, { reason: "AI Builder message", builder: true }))) {
    throw new ApiError(402, "insufficient_credits", "You've used this period's AI Builder credits. Upgrade your plan for more.");
  }
  let result: Awaited<ReturnType<typeof runBuilder>>;
  try {
    result = await runBuilder({ llm: ai.llm!, model: DEFAULT_MODEL, graph: wf.draft, history, message });
  } catch (err) {
    if (billable) await runtime.credits.refund(workspace.workspaceId, 1, "builder", "AI Builder message failed");
    throw err;
  }

  let saved: { revision: number; updatedAt: string } | null = null;
  if (result.applied) {
    saved = await saveDraft(workspace.workspaceId, user.id, wf.id, expectedRevision, result.applied.graph);
  }

  const now = new Date();
  const turns: ConversationDoc["messages"] = [
    { role: "user", text: message, at: now },
    { role: "assistant", text: result.response, at: now, ...(result.applied ? { summary: result.applied.summary } : {}) },
  ];
  await conversations().updateOne(
    { workflowId, workspaceId: workspace.workspaceId },
    { $push: { messages: { $each: turns, $slice: -40 } }, $set: { updatedAt: now } },
    { upsert: true },
  );

  return json({
    message: toView(turns[1]!),
    steps: result.steps,
    applied: result.applied && saved ? { graph: result.applied.graph, summary: result.applied.summary, revision: saved.revision } : null,
  });
});
