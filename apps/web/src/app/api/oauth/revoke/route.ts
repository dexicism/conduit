import { revokeToken } from "@/lib/mcp-oauth";

/** RFC 7009: always 200, whether or not the token existed. */
export async function POST(req: Request) {
  const form = new URLSearchParams(await req.text());
  const token = form.get("token");
  if (token) await revokeToken(token);
  return new Response(null, { status: 200 });
}
