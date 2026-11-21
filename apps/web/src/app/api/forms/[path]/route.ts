import { NextResponse } from "next/server";
import { loadPublishedForm, validateSubmission } from "@/lib/forms";
import { rt } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** A submission to a published form. Public: no sign-in. Starts one live run. */
export async function POST(req: Request, ctx: RouteContext<"/api/forms/[path]">) {
  const { path } = await ctx.params;
  const form = await loadPublishedForm(path);
  if (!form) return NextResponse.json({ error: "not_found", message: "This form isn't available" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "invalid_request", message: "That's too much text" }, { status: 413 });
  let body: { values?: Record<string, unknown>; website?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Invalid submission" }, { status: 400 });
  }
  // Honeypot: people never see the "website" field, bots fill it. Pretend success.
  if (body.website) return NextResponse.json({ ok: true, message: form.successMessage });

  const { values, errors } = validateSubmission(form.questions, body.values ?? {});
  if (Object.keys(errors).length) {
    return NextResponse.json({ error: "validation_failed", message: "Check the highlighted answers", fields: errors }, { status: 400 });
  }
  try {
    await rt().runtime.createExecution(
      {
        workspaceId: form.workspaceId,
        workflowId: form.workflowId,
        workflowName: form.workflowName,
        versionId: form.versionId,
        mode: "production",
        graph: form.graph,
        triggerNodeId: form.node.id,
        triggerItems: [{ json: { fields: values, submittedAt: new Date().toISOString() } }],
      },
      true,
    );
  } catch (err) {
    console.error("[form] failed to start run", err);
    return NextResponse.json({ error: "internal_error", message: "Something went wrong. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, message: form.successMessage });
}
