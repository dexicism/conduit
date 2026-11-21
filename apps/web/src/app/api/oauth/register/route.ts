import { NextResponse } from "next/server";
import { OAuthError, registerClient } from "@/lib/mcp-oauth";

/** Dynamic client registration (RFC 7591) for MCP clients. Public clients only. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await registerClient(body), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.code, error_description: err.message }, { status: err.status });
    throw err;
  }
}
