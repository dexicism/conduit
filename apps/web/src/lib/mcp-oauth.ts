import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { API_SCOPES, type ApiScope, type KeyContext } from "./api-keys";
import { db } from "./db";
import { env } from "./env";
import { canEdit, findMemberWorkspace } from "./workspaces";

/**
 * OAuth 2.1 authorization server for MCP clients:
 * dynamic client registration (RFC 7591), authorization code + PKCE S256 only,
 * public clients (no secret), short-lived access tokens, rotating refresh tokens
 * with reuse detection. Only SHA-256 hashes of codes and tokens are stored.
 */

export const MCP_RESOURCE = () => `${env.APP_URL}/api/mcp`;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 86_400_000;

interface ClientDoc {
  _id: string; // client_id
  name: string;
  redirectUris: string[];
  createdAt: Date;
}

interface CodeDoc {
  _id: string; // hash
  clientId: string;
  userId: string;
  workspaceId: ObjectId;
  redirectUri: string;
  scopes: ApiScope[];
  codeChallenge: string;
  expiresAt: Date;
}

interface GrantDoc {
  _id: ObjectId;
  clientId: string;
  userId: string;
  workspaceId: ObjectId;
  scopes: ApiScope[];
  accessHash: string;
  accessExpiresAt: Date;
  refreshHash: string;
  /** Previous refresh tokens: presenting one again means the token leaked; the grant is revoked. */
  usedRefreshHashes: string[];
  refreshExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

const clients = () => db.collection<ClientDoc>("mcp_oauth_clients");
const codes = () => db.collection<CodeDoc>("mcp_oauth_codes");
const grants = () => db.collection<GrantDoc>("mcp_oauth_grants");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

let indexed: Promise<unknown> | null = null;
function ensureIndexes() {
  indexed ??= Promise.all([
    codes().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    grants().createIndex({ accessHash: 1 }),
    grants().createIndex({ refreshHash: 1 }),
    grants().createIndex({ usedRefreshHashes: 1 }),
    grants().createIndex({ refreshExpiresAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
  ]);
  return indexed;
}

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function parseScopes(scope: string | null | undefined): ApiScope[] {
  const asked = (scope ?? "").split(/\s+/).filter(Boolean);
  const list = asked.length ? asked : [...API_SCOPES];
  const bad = list.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new OAuthError("invalid_scope", `Unknown scope: ${bad.join(", ")}`);
  return [...new Set(list)] as ApiScope[];
}

/** Redirect URIs: https anywhere, or http only to the local machine (desktop clients). */
function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(input: { redirect_uris?: unknown; client_name?: unknown }) {
  await ensureIndexes();
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    throw new OAuthError("invalid_redirect_uri", "Give 1–10 redirect URIs: https, or http on localhost");
  }
  const doc: ClientDoc = {
    _id: `mcp_${randomBytes(16).toString("hex")}`,
    name: String(input.client_name ?? "MCP client").slice(0, 100),
    redirectUris: uris,
    createdAt: new Date(),
  };
  await clients().insertOne(doc);
  return {
    client_id: doc._id,
    client_id_issued_at: Math.floor(doc.createdAt.getTime() / 1000),
    client_name: doc.name,
    redirect_uris: doc.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export async function getClient(id: string) {
  return clients().findOne({ _id: id });
}

export interface AuthorizeRequest {
  client: ClientDoc;
  redirectUri: string;
  state: string | null;
  scopes: ApiScope[];
  codeChallenge: string;
}

/** Validates an /authorize request. Errors that can't be sent to the redirect URI are thrown as `fatal`. */
export async function checkAuthorizeRequest(q: URLSearchParams): Promise<AuthorizeRequest> {
  const client = await getClient(q.get("client_id") ?? "");
  if (!client) throw new OAuthError("invalid_client", "Unknown client. Register it first.");
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request", "The redirect URI isn't registered for this client");
  if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const resource = q.get("resource");
  if (resource && resource !== MCP_RESOURCE()) throw new OAuthError("invalid_target", "Unknown resource");
  return { client, redirectUri, state: q.get("state"), scopes: parseScopes(q.get("scope")), codeChallenge: challenge };
}

export async function issueCode(req: AuthorizeRequest, userId: string, workspaceId: ObjectId): Promise<string> {
  await ensureIndexes();
  const code = token("mcp_c_");
  await codes().insertOne({
    _id: sha(code),
    clientId: req.client._id,
    userId,
    workspaceId,
    redirectUri: req.redirectUri,
    scopes: req.scopes,
    codeChallenge: req.codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

function tokenResponse(access: string, refresh: string, scopes: ApiScope[]) {
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
}

export async function exchangeCode(form: URLSearchParams) {
  await ensureIndexes();
  const code = form.get("code") ?? "";
  const doc = await codes().findOneAndDelete({ _id: sha(code) }); // single use
  if (!doc || doc.expiresAt < new Date()) throw new OAuthError("invalid_grant", "The code is invalid or expired");
  if (doc.clientId !== form.get("client_id") || doc.redirectUri !== form.get("redirect_uri")) {
    throw new OAuthError("invalid_grant", "The code was issued to another client or redirect URI");
  }
  const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
  const a = Buffer.from(challenge);
  const b = Buffer.from(doc.codeChallenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError("invalid_grant", "PKCE verification failed");
  const access = token("mcp_at_");
  const refresh = token("mcp_rt_");
  const now = Date.now();
  await grants().insertOne({
    _id: new ObjectId(),
    clientId: doc.clientId,
    userId: doc.userId,
    workspaceId: doc.workspaceId,
    scopes: doc.scopes,
    accessHash: sha(access),
    accessExpiresAt: new Date(now + ACCESS_TTL_MS),
    refreshHash: sha(refresh),
    usedRefreshHashes: [],
    refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
    revokedAt: null,
    createdAt: new Date(now),
  });
  return tokenResponse(access, refresh, doc.scopes);
}

export async function refreshGrant(form: URLSearchParams) {
  await ensureIndexes();
  const h = sha(form.get("refresh_token") ?? "");
  const reused = await grants().findOne({ usedRefreshHashes: h });
  if (reused) {
    await grants().updateOne({ _id: reused._id }, { $set: { revokedAt: new Date() } });
    throw new OAuthError("invalid_grant", "This refresh token was already used. Sign in again.");
  }
  const g = await grants().findOne({ refreshHash: h, revokedAt: null });
  if (!g || g.refreshExpiresAt < new Date() || g.clientId !== form.get("client_id")) throw new OAuthError("invalid_grant", "The refresh token is invalid or expired");
  const access = token("mcp_at_");
  const refresh = token("mcp_rt_");
  const now = Date.now();
  const r = await grants().updateOne(
    { _id: g._id, refreshHash: h },
    {
      $set: { accessHash: sha(access), accessExpiresAt: new Date(now + ACCESS_TTL_MS), refreshHash: sha(refresh), refreshExpiresAt: new Date(now + REFRESH_TTL_MS) },
      $push: { usedRefreshHashes: h },
    },
  );
  if (!r.modifiedCount) throw new OAuthError("invalid_grant", "The refresh token was just used");
  return tokenResponse(access, refresh, g.scopes);
}

export async function revokeToken(t: string) {
  const h = sha(t);
  await grants().updateMany({ $or: [{ accessHash: h }, { refreshHash: h }] }, { $set: { revokedAt: new Date() } });
}

/** Resolves an MCP access token. The user must still belong to the workspace; viewers lose write scopes. */
export async function resolveAccessToken(t: string): Promise<KeyContext | null> {
  if (!t.startsWith("mcp_at_")) return null;
  const g = await grants().findOne({ accessHash: sha(t), revokedAt: null });
  if (!g || g.accessExpiresAt < new Date()) return null;
  const ws = await findMemberWorkspace(g.userId, g.workspaceId.toHexString());
  if (!ws) return null;
  const scopes = canEdit(ws.role) ? g.scopes : g.scopes.filter((s) => s.endsWith(":read"));
  return { workspace: ws, scopes, keyId: g._id.toHexString(), actorId: g.userId };
}

export function authorizationServerMetadata() {
  const base = env.APP_URL;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...API_SCOPES],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE(),
    authorization_servers: [env.APP_URL],
    scopes_supported: [...API_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Conduit",
  };
}
