import { getApp } from "@conduit/nodes";
import { exchangeCode, fetchAccountEmail } from "@conduit/runtime";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rt } from "@/lib/runtime";
import { getSession } from "@/lib/session";

/** Where the provider sends the user back. Finishes the sign-in and saves the account. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const done = (params: Record<string, string>) => {
    const to = new URL("/app/connections/done", env.APP_URL);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    return NextResponse.redirect(to, 302);
  };

  const session = await getSession();
  if (!session) return done({ error: "Sign in to Conduit first, then connect the account again." });
  const state = url.searchParams.get("state") ?? "";
  const { integrations } = rt();
  // Single use, and only for the user who started it.
  const pending = state ? await integrations.collections.oauthStates.findOneAndDelete({ _id: state, userId: session.user.id }) : null;
  if (!pending || pending.expiresAt < new Date()) return done({ error: "This sign-in link expired or wasn't started here. Try connecting again." });

  const providerError = url.searchParams.get("error");
  if (providerError) {
    return done({ error: providerError === "access_denied" ? "You cancelled the sign-in." : `The sign-in failed (${providerError.slice(0, 60)}).` });
  }
  const code = url.searchParams.get("code");
  const app = getApp(pending.app);
  if (!code || !app || app.auth.kind !== "oauth2") return done({ error: "The sign-in didn't return a code. Try again." });
  const client = integrations.oauthClients[app.auth.provider];
  if (!client) return done({ error: `${app.name} sign-in isn't set up on this server.` });

  try {
    const tokens = await exchangeCode(integrations.http, integrations.apiUrl, app.auth.provider, client, {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
    if (!tokens.refreshToken) return done({ error: `${app.name} didn't grant offline access. Remove Conduit from your account's connected apps and try again.` });
    const email = await fetchAccountEmail(integrations.http, integrations.apiUrl, app.auth.provider, tokens.accessToken);
    if (pending.reconnectId) {
      const existing = await integrations.find(pending.workspaceId, pending.reconnectId);
      if (existing?.account && email && existing.account.toLowerCase() !== email.toLowerCase()) {
        return done({ error: `You signed in as ${email}, but this connection is for ${existing.account}. Reconnect with that account, or add ${email} as a new connection.` });
      }
      const renewed = await integrations.replaceTokens(pending.workspaceId, pending.reconnectId, {
        values: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
        account: email,
        expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      });
      if (!renewed) return done({ error: "That account was removed while you were signing in. Connect it again." });
      return done({ id: renewed._id.toHexString(), app: app.id });
    }
    const doc = await integrations.create({
      workspaceId: pending.workspaceId,
      userId: session.user.id,
      app: app.id,
      label: pending.label,
      values: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      account: email,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
    });
    return done({ id: doc._id.toHexString(), app: app.id });
  } catch (err) {
    console.error("[oauth] callback failed", (err as Error).message);
    return done({ error: (err as Error).message.slice(0, 200) });
  }
}
