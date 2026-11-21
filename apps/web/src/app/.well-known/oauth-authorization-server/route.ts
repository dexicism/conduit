import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { "access-control-allow-origin": "*" } });
}
