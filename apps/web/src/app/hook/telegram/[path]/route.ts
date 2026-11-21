import { workflowGraphSchema } from "@conduit/core";
import { telegramUpdateToItem } from "@conduit/runtime";
import { ObjectId } from "mongodb";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rt } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Updates from Telegram for a published workflow's bot. Telegram sends back the
 * secret we gave it in setWebhook; anything without it is rejected.
 */
export async function POST(req: Request, ctx: RouteContext<"/hook/telegram/[path]">) {
  const { path } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(path)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { triggers, runtime } = rt();
  const t = await triggers.findTelegram(path);
  if (!t?.secretToken) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!sameSecret(req.headers.get("x-telegram-bot-api-secret-token") ?? "", t.secretToken)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });
  let update: Record<string, unknown>;
  try {
    update = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // Only messages start runs; acknowledge anything else so Telegram doesn't retry it.
  if (!update.message && !update.edited_message) return NextResponse.json({ ok: true });

  try {
    const [wf, version] = await Promise.all([
      db.collection("workflows").findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
      db.collection("workflow_versions").findOne({ _id: t.versionId! }),
    ]);
    if (!wf || !version) return NextResponse.json({ ok: true });
    const graph = workflowGraphSchema.parse(version.graph);
    await runtime.createExecution(
      {
        workspaceId: t.workspaceId,
        workflowId: t.workflowId,
        workflowName: String(wf.name),
        versionId: version._id as ObjectId,
        mode: "production",
        graph,
        triggerNodeId: t.nodeId,
        triggerItems: [{ json: telegramUpdateToItem(update) }],
      },
      true,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telegram] failed to start run", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
