import { createHash, randomBytes } from "node:crypto";
import { StepError, type HttpRequest, type HttpResponse } from "@conduit/engine";
import type { OAuthProviderId } from "@conduit/nodes";

/** OAuth 2.0 authorization-code flow with PKCE (RFC 7636) for connected apps. */

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  extraParams: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, ProviderSpec> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // offline + consent: Google returns a refresh token on every connect.
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
};

export function newPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeUrl(
  provider: OAuthProviderId,
  input: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes: readonly string[] },
  apiUrl: (u: string) => string,
): string {
  const spec = OAUTH_PROVIDERS[provider];
  const u = new URL(apiUrl(spec.authorizeUrl));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("scope", input.scopes.join(" "));
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(spec.extraParams)) u.searchParams.set(k, v);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch, or null when the provider gives no expiry. */
  expiresAt: number | null;
  scope?: string;
}

type Http = (req: HttpRequest) => Promise<HttpResponse>;

async function tokenRequest(http: Http, url: string, form: Record<string, string>): Promise<TokenSet> {
  const res = await http({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 20_000,
  });
  const b = (typeof res.body === "object" && res.body ? res.body : {}) as Record<string, unknown>;
  if (res.status >= 400 || typeof b.access_token !== "string") {
    const reason = String(b.error_description ?? b.error ?? `status ${res.status}`);
    throw new StepError(`Sign-in with the app failed: ${reason}`);
  }
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
    expiresAt: typeof b.expires_in === "number" ? Date.now() + b.expires_in * 1000 : null,
    scope: typeof b.scope === "string" ? b.scope : undefined,
  };
}

export function exchangeCode(
  http: Http,
  apiUrl: (u: string) => string,
  provider: OAuthProviderId,
  client: OAuthClient,
  input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenSet> {
  return tokenRequest(http, apiUrl(OAUTH_PROVIDERS[provider].tokenUrl), {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

export function refreshTokens(
  http: Http,
  apiUrl: (u: string) => string,
  provider: OAuthProviderId,
  client: OAuthClient,
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(http, apiUrl(OAUTH_PROVIDERS[provider].tokenUrl), {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

export async function fetchAccountEmail(http: Http, apiUrl: (u: string) => string, provider: OAuthProviderId, accessToken: string): Promise<string | null> {
  const res = await http({
    method: "GET",
    url: apiUrl(OAUTH_PROVIDERS[provider].userInfoUrl),
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    timeoutMs: 15_000,
  });
  const email = (res.body as { email?: unknown } | null)?.email;
  return res.status < 400 && typeof email === "string" ? email : null;
}
