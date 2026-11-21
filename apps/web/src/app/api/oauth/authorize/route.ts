import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { checkAuthorizeRequest, issueCode, OAuthError } from "@/lib/mcp-oauth";
import { getSession } from "@/lib/session";
import { sessionNeedsTwoFactor } from "@/lib/two-factor";
import { findMemberWorkspace } from "@/lib/workspaces";

/** The consent form posts here. Same-origin only; the signed-in user chooses the workspace. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(env.APP_URL).origin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await getSession();
  if (!session || (await sessionNeedsTwoFactor(session.user.id, session.session.id))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = new URLSearchParams(await req.text());
  let request;
  try {
    request = await checkAuthorizeRequest(form);
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.code, error_description: err.message }, { status: 400 });
    throw err;
  }
  const back = new URL(request.redirectUri);
  if (request.state) back.searchParams.set("state", request.state);
  if (form.get("decision") !== "approve") {
    back.searchParams.set("error", "access_denied");
    return NextResponse.redirect(back, 303);
  }
  const ws = await findMemberWorkspace(session.user.id, form.get("workspaceId") ?? "");
  if (!ws) return NextResponse.json({ error: "forbidden", error_description: "Choose a workspace you belong to" }, { status: 403 });
  const code = await issueCode(request, session.user.id, ws.workspaceId as ObjectId);
  back.searchParams.set("code", code);
  back.searchParams.set("iss", env.APP_URL);
  return NextResponse.redirect(back, 303);
}
