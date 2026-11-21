import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { ApiError } from "./api";
import { collections, db } from "./db";
import { planOf } from "@conduit/core";
import type { WorkspaceContext } from "./workspaces";

/**
 * Workspace API keys for the public API (v1) and MCP clients.
 * Format `cdt_<8-char prefix>_<secret>`. Only a SHA-256 hash is stored (the key is
 * 256 bits of randomness, so a slow hash adds nothing). Keys never reach member,
 * billing or credential routes: those use `requireApiContext`, which rejects keys.
 */

export const API_SCOPES = ["workflows:read", "workflows:write", "executions:read", "executions:run"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

interface ApiKeyDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  name: string;
  prefix: string;
  hash: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

const keys = () => db.collection<ApiKeyDoc>("api_keys");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let indexed: Promise<unknown> | null = null;
const ensureIndexes = () => (indexed ??= keys().createIndex({ prefix: 1 }, { unique: true }));

function view(d: ApiKeyDoc): ApiKeyView {
  return { id: d._id.toHexString(), name: d.name, prefix: d.prefix, scopes: d.scopes, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt?.toISOString() ?? null };
}

export async function listApiKeys(workspaceId: ObjectId): Promise<ApiKeyView[]> {
  return (await keys().find({ workspaceId, revokedAt: null }).sort({ createdAt: -1 }).toArray()).map(view);
}

/** Creates a key. The full key is returned once and never stored. */
export async function createApiKey(workspaceId: ObjectId, userId: string, name: string, scopes: ApiScope[]): Promise<ApiKeyView & { key: string }> {
  await ensureIndexes();
  const prefix = randomBytes(6).toString("base64url").slice(0, 8);
  const secret = randomBytes(32).toString("base64url");
  const key = `cdt_${prefix}_${secret}`;
  const doc: ApiKeyDoc = {
    _id: new ObjectId(),
    workspaceId,
    name,
    prefix,
    hash: sha(key),
    scopes,
    createdBy: userId,
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await keys().insertOne(doc);
  return { ...view(doc), key };
}

export async function revokeApiKey(workspaceId: ObjectId, id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  return (await keys().updateOne({ _id: new ObjectId(id), workspaceId, revokedAt: null }, { $set: { revokedAt: new Date() } })).modifiedCount === 1;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

export interface KeyContext {
  workspace: WorkspaceContext;
  scopes: ApiScope[];
  keyId: string;
  /** Recorded as the actor for anything the key creates. */
  actorId: string;
}

/** Resolves a `cdt_` key to its workspace, or null if it isn't one / isn't valid. */
export async function resolveApiKey(token: string): Promise<KeyContext | null> {
  const m = /^cdt_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m) return null;
  const doc = await keys().findOne({ prefix: m[1], revokedAt: null });
  if (!doc) return null;
  const a = Buffer.from(sha(token));
  const b = Buffer.from(doc.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const ws = await collections.workspaces().findOne({ _id: doc.workspaceId });
  if (!ws) return null;
  // Last-used is advisory: at most one write per minute per key.
  void keys().updateOne({ _id: doc._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: new Date(Date.now() - 60_000) } }] }, { $set: { lastUsedAt: new Date() } });
  return {
    workspace: { workspaceId: doc.workspaceId, workspaceName: String(ws.name), role: "editor", plan: planOf(ws.plan).id, personal: ws.personal !== false },
    scopes: doc.scopes,
    keyId: doc._id.toHexString(),
    actorId: `apikey:${doc._id.toHexString()}`,
  };
}

/** For public API routes: a valid key with the scope, else 401/403. */
export async function requireApiKey(req: Request, scope: ApiScope): Promise<KeyContext> {
  const token = bearerToken(req);
  if (!token) throw new ApiError(401, "unauthorized", "Send an API key: Authorization: Bearer cdt_…");
  const ctx = await resolveApiKey(token);
  if (!ctx) throw new ApiError(401, "unauthorized", "This API key is invalid or was revoked");
  if (!ctx.scopes.includes(scope)) throw new ApiError(403, "forbidden", `This API key doesn't have the ${scope} scope`);
  return ctx;
}
