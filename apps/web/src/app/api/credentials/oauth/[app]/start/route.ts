import { authorizeUrl, newPkce, newState } from "@conduit/runtime";
import { NextResponse } from "next/server";
import { ApiError, route, searchParamsObject } from "@/lib/api";
import { oauthRedirectUri, requireAvailableApp } from "@/lib/connections";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/credentials/oauth/[app]/start">;

/** Starts the OAuth sign-in for an app: stores state + PKCE verifier for this user, then redirects to the provider. */
export const GET = route<Ctx>(async (req, ctx) => {
  const { user, workspace } = await requireApiContext(req);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't connect accounts");
  const { app: appId } = await ctx.params;
  const app = requireAvailableApp(appId);
  if (app.auth.kind !== "oauth2") throw new ApiError(400, "invalid_request", `${app.name} connects with a form, not sign-in`);
  const params = searchParamsObject(req);
  const label = (params.label ?? "").trim().slice(0, 80) || app.name;

  const { integrations } = rt();
  // Reconnect: renew an existing account of this app in this workspace.
  const reconnectId = params.reconnect?.trim() || undefined;
  if (reconnectId) {
    const existing = await integrations.find(workspace.workspaceId, reconnectId);
    if (!existing || existing.app !== app.id) throw new ApiError(404, "not_found", "That account doesn't exist in this workspace");
  }
  const client = integrations.oauthClients[app.auth.provider]!;
  const pkce = newPkce();
  const state = newState();
  const redirectUri = oauthRedirectUri();
  await integrations.collections.oauthStates.insertOne({
    _id: state,
    userId: user.id,
    workspaceId: workspace.workspaceId,
    app: app.id,
    label,
    codeVerifier: pkce.verifier,
    redirectUri,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...(reconnectId ? { reconnectId } : {}),
  });
  const url = authorizeUrl(
    app.auth.provider,
    { clientId: client.clientId, redirectUri, state, codeChallenge: pkce.challenge, scopes: app.auth.scopes },
    integrations.apiUrl,
  );
  return NextResponse.redirect(url, 302);
});
