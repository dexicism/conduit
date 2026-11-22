import { NextResponse } from "next/server";
import { chatReply, loadPublishedChat, MAX_CHAT_MESSAGE, overLimit, SESSION_ID, startChatRun } from "@/lib/chat";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "not_found", message: "This chat isn't available" }, { status: 404 });
const bad = (message: string, status = 400) => NextResponse.json({ error: "invalid_request", message }, { status });

// Only trust the forwarded IP behind a proxy you control (it sets the header); otherwise anyone can fake it.
function clientIp(req: Request): string | null {
  if (process.env.TRUST_PROXY !== "1") return null;
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

/** A visitor's message to a published chat. Public: no sign-in. Starts one live run. */
export async function POST(req: Request, ctx: RouteContext<"/api/chat/[path]">) {
  const { path } = await ctx.params;
  const chat = await loadPublishedChat(path);
  if (!chat) return notFound();
  const raw = await req.text();
  if (raw.length > MAX_CHAT_MESSAGE * 2 + 1000) return bad("That message is too long", 413);
  let body: { sessionId?: unknown; message?: unknown; website?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("Invalid message");
  }
  const sessionId = String(body.sessionId ?? "");
  if (!SESSION_ID.test(sessionId)) return bad("Invalid session");
  const message = String(body.message ?? "").trim();
  if (!message) return bad("Write a message first");
  if (message.length > MAX_CHAT_MESSAGE) return bad(`Keep messages under ${MAX_CHAT_MESSAGE} characters`, 413);
  // Honeypot: people never see the "website" field, bots fill it.
  if (body.website) return NextResponse.json({ runId: null });
  const ip = clientIp(req);
  // Session ids are made up by the browser, so the per-chat cap is the one a script can't dodge.
  if (overLimit(`s:${sessionId}`, 10) || (ip && overLimit(`ip:${ip}`, 30)) || overLimit(`chat:${path}`, 60)) {
    return NextResponse.json({ error: "rate_limited", message: "You're sending messages too fast. Wait a minute and try again." }, { status: 429 });
  }
  try {
    const id = await startChatRun(chat, sessionId, message);
    return NextResponse.json({ runId: id.toHexString() }, { status: 202 });
  } catch (err) {
    console.error("[chat] failed to start run", err);
    return NextResponse.json({ error: "internal_error", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}

/** The reply to one message: ?run=<runId>&session=<sessionId>. */
export async function GET(req: Request, ctx: RouteContext<"/api/chat/[path]">) {
  const { path } = await ctx.params;
  const chat = await loadPublishedChat(path);
  if (!chat) return notFound();
  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_ID.test(session)) return bad("Invalid session");
  const r = await chatReply(chat, url.searchParams.get("run") ?? "", session);
  if (!r) return notFound();
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}
