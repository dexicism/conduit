import { NextResponse } from "next/server";
import { rt } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;

/** Meta checks the callback URL once with a GET and expects the challenge echoed back. */
export async function GET(req: Request, ctx: RouteContext<"/hook/whatsapp/[id]">) {
  const { id } = await ctx.params;
  const challenge = await rt().whatsapp.verify(id, new URL(req.url).searchParams);
  if (challenge === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return new Response(challenge, { headers: { "content-type": "text/plain" } });
}

/** Incoming messages. Every request is signed with the app secret; unsigned ones are rejected. */
export async function POST(req: Request, ctx: RouteContext<"/hook/whatsapp/[id]">) {
  const { id } = await ctx.params;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });
  try {
    const result = await rt().whatsapp.receive(id, raw, req.headers.get("x-hub-signature-256"));
    if (result.status !== 200) return NextResponse.json({ error: result.status === 401 ? "unauthorized" : "not_found" }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // A 500 makes Meta retry later, which is what we want if the database hiccupped.
    console.error("[whatsapp] failed to start run", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
