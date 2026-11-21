import { NextResponse } from "next/server";
import { exchangeCode, OAuthError, refreshGrant } from "@/lib/mcp-oauth";

export async function POST(req: Request) {
  const form = new URLSearchParams(await req.text());
  try {
    const grant = form.get("grant_type");
    const body =
      grant === "authorization_code" ? await exchangeCode(form) : grant === "refresh_token" ? await refreshGrant(form) : null;
    if (!body) return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
    return NextResponse.json(body, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.code, error_description: err.message }, { status: err.status });
    throw err;
  }
}
