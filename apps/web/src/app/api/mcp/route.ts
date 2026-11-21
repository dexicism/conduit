import { NextResponse } from "next/server";
import { bearerToken, resolveApiKey } from "@/lib/api-keys";
import { env } from "@/lib/env";
import { resolveAccessToken } from "@/lib/mcp-oauth";
import { handleMcp, type JsonRpcRequest } from "@/lib/mcp-server";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${env.APP_URL}/.well-known/oauth-protected-resource"` } },
  );
}

/** MCP over Streamable HTTP. Auth: an OAuth access token from /oauth/authorize, or a workspace API key. */
export async function POST(req: Request) {
  const token = bearerToken(req);
  const ctx = token ? ((await resolveAccessToken(token)) ?? (await resolveApiKey(token))) : null;
  if (!ctx) return unauthorized();

  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
  }
  const out = await handleMcp(msg, ctx);
  if (!out) return new Response(null, { status: 202 });
  return NextResponse.json({ jsonrpc: "2.0", id: msg.id ?? null, ...out });
}

/** No server-initiated stream: this server only answers requests. */
export async function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
