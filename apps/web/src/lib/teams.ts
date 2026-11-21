import "server-only";
import { planOf } from "@conduit/core";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { ApiError } from "./api";
import { collections, db, mongoClient } from "./db";
import { sendEmail } from "./email";
import { env } from "./env";
import type { Role, WorkspaceContext } from "./workspaces";

export const ROLES: Role[] = ["owner", "admin", "editor", "viewer"];
export const INVITE_ROLES: Role[] = ["admin", "editor", "viewer"];
const INVITE_TTL_MS = 7 * 86_400_000;

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
}

interface InvitationDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  email: string;
  role: Role;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

const invitations = () => db.collection<InvitationDoc>("invitations");
const users = () => db.collection("user");
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

let indexes: Promise<unknown> | null = null;
function ensureTeamIndexes() {
  indexes ??= Promise.all([
    invitations().createIndex({ tokenHash: 1 }, { unique: true }),
    invitations().createIndex({ workspaceId: 1, email: 1 }),
    invitations().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 30 * 86_400 }),
  ]);
  return indexes;
}

function userIdQuery(id: string) {
  return ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
}

export async function listMembers(workspaceId: ObjectId): Promise<MemberView[]> {
  const ms = await collections.memberships().find({ workspaceId, status: "active" }).sort({ createdAt: 1 }).toArray();
  const ids = ms.map((m) => String(m.userId));
  const objectIds = ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
  const us = await users().find({ $or: [{ _id: { $in: objectIds } }, { id: { $in: ids } }] }).toArray();
  const byId = new Map(us.map((u) => [String(u.id ?? u._id), u]));
  return ms.map((m) => {
    const u = byId.get(String(m.userId));
    return {
      userId: String(m.userId),
      name: String(u?.name ?? ""),
      email: String(u?.email ?? ""),
      role: m.role as Role,
      joinedAt: (m.createdAt as Date).toISOString(),
    };
  });
}

export async function listInvitations(workspaceId: ObjectId): Promise<InvitationView[]> {
  const docs = await invitations()
    .find({ workspaceId, acceptedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({ id: d._id.toHexString(), email: d.email, role: d.role, expiresAt: d.expiresAt.toISOString(), createdAt: d.createdAt.toISOString() }));
}

/** Invites by email. Only a hash of the token is stored; the link is emailed. Re-inviting replaces the old link. */
export async function invite(ws: WorkspaceContext, inviter: { id: string; name: string }, email: string, role: Role): Promise<InvitationView> {
  await ensureTeamIndexes();
  if (ws.personal) throw new ApiError(400, "invalid_request", "Personal workspaces can't have members. Create a team first.");
  const addr = email.trim().toLowerCase();
  const members = await listMembers(ws.workspaceId);
  if (members.some((m) => m.email.toLowerCase() === addr)) throw new ApiError(400, "invalid_request", `${addr} is already a member`);
  const pending = (await listInvitations(ws.workspaceId)).filter((i) => i.email !== addr).length;
  const limit = planOf(ws.plan).members;
  if (members.length + pending + 1 > limit) {
    throw new ApiError(400, "invalid_request", `The ${planOf(ws.plan).name} plan allows ${limit} member${limit === 1 ? "" : "s"}. Upgrade to invite more.`);
  }
  await invitations().deleteMany({ workspaceId: ws.workspaceId, email: addr, acceptedAt: null });
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const doc: InvitationDoc = {
    _id: new ObjectId(),
    workspaceId: ws.workspaceId,
    email: addr,
    role,
    tokenHash: hashToken(token),
    invitedBy: inviter.id,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
    createdAt: now,
  };
  await invitations().insertOne(doc);
  const link = `${env.APP_URL}/invite/${token}`;
  const who = inviter.name || "A teammate";
  await sendEmail({
    to: addr,
    subject: `${who} invited you to ${ws.workspaceName} on Conduit`,
    text: `${who} invited you to join "${ws.workspaceName}" as ${role}.\n\nAccept: ${link}\n\nThe link works for 7 days. Sign in with ${addr} to accept.`,
    html: `<p>${escapeHtml(who)} invited you to join <strong>${escapeHtml(ws.workspaceName)}</strong> as ${role}.</p><p><a href="${link}">Accept the invitation</a></p><p>The link works for 7 days. Sign in with ${escapeHtml(addr)} to accept.</p>`,
  });
  return { id: doc._id.toHexString(), email: addr, role, expiresAt: doc.expiresAt.toISOString(), createdAt: now.toISOString() };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function revokeInvitation(workspaceId: ObjectId, id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  return (await invitations().deleteOne({ _id: new ObjectId(id), workspaceId, acceptedAt: null })).deletedCount === 1;
}

/** What the invite page shows before accepting. */
export async function describeInvitation(token: string) {
  const inv = await invitations().findOne({ tokenHash: hashToken(token) });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) return null;
  const ws = await collections.workspaces().findOne({ _id: inv.workspaceId });
  if (!ws) return null;
  return { email: inv.email, role: inv.role, workspaceName: String(ws.name), workspaceId: inv.workspaceId.toHexString() };
}

/** Accepts an invitation. The signed-in user's email must match the invited address. */
export async function acceptInvitation(token: string, user: { id: string; email: string }): Promise<string> {
  const inv = await invitations().findOne({ tokenHash: hashToken(token) });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new ApiError(404, "not_found", "This invitation expired or was already used");
  if (inv.email !== user.email.trim().toLowerCase()) {
    throw new ApiError(403, "forbidden", `This invitation is for ${inv.email}. Sign in with that address to accept it.`);
  }
  const session = mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      const used = await invitations().updateOne({ _id: inv._id, acceptedAt: null }, { $set: { acceptedAt: new Date() } }, { session });
      if (!used.modifiedCount) throw new ApiError(404, "not_found", "This invitation was already used");
      await collections.memberships().updateOne(
        { workspaceId: inv.workspaceId, userId: user.id },
        { $setOnInsert: { workspaceId: inv.workspaceId, userId: user.id, role: inv.role, status: "active", invitedBy: inv.invitedBy, createdAt: new Date() } },
        { upsert: true, session },
      );
    });
  } finally {
    await session.endSession();
  }
  return inv.workspaceId.toHexString();
}

async function ownerCount(workspaceId: ObjectId) {
  return collections.memberships().countDocuments({ workspaceId, role: "owner", status: "active" });
}

/** Changes a member's role. Only owners can create or demote owners; the last owner stays. */
export async function changeRole(ws: WorkspaceContext, actorId: string, userId: string, role: Role) {
  const m = await collections.memberships().findOne({ workspaceId: ws.workspaceId, userId, status: "active" });
  if (!m) throw new ApiError(404, "not_found", "Member not found");
  if ((role === "owner" || m.role === "owner") && ws.role !== "owner") throw new ApiError(403, "forbidden", "Only owners can change who is an owner");
  if (m.role === "owner" && role !== "owner" && (await ownerCount(ws.workspaceId)) <= 1) {
    throw new ApiError(400, "invalid_request", "A workspace needs at least one owner. Make someone else an owner first.");
  }
  void actorId;
  await collections.memberships().updateOne({ _id: m._id }, { $set: { role } });
}

/** Removes a member (or the actor leaving). The last owner can't leave. */
export async function removeMember(ws: WorkspaceContext, actorId: string, userId: string) {
  const m = await collections.memberships().findOne({ workspaceId: ws.workspaceId, userId, status: "active" });
  if (!m) throw new ApiError(404, "not_found", "Member not found");
  const self = actorId === userId;
  if (!self && m.role === "owner" && ws.role !== "owner") throw new ApiError(403, "forbidden", "Only owners can remove an owner");
  if (m.role === "owner" && (await ownerCount(ws.workspaceId)) <= 1) {
    throw new ApiError(400, "invalid_request", "A workspace needs at least one owner. Make someone else an owner first.");
  }
  await collections.memberships().deleteOne({ _id: m._id });
}

export async function renameWorkspace(workspaceId: ObjectId, name: string) {
  await collections.workspaces().updateOne({ _id: workspaceId }, { $set: { name, updatedAt: new Date() } });
}

export { userIdQuery };
