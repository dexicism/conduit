import "server-only";
import { planOf, type PlanId } from "@conduit/core";
import { ObjectId } from "mongodb";
import { collections, ensureIndexes, mongoClient } from "./db";

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface WorkspaceContext {
  workspaceId: ObjectId;
  workspaceName: string;
  role: Role;
  plan: PlanId;
  /** A personal workspace was created for the user; teams are created explicitly. */
  personal: boolean;
}

/** Cookie holding the workspace the user is working in. Membership is re-checked on every request. */
export const WORKSPACE_COOKIE = "conduit_ws";

function toContext(ws: Record<string, unknown>, role: Role): WorkspaceContext {
  return {
    workspaceId: ws._id as ObjectId,
    workspaceName: String(ws.name),
    role,
    plan: planOf(ws.plan).id,
    personal: ws.personal !== false,
  };
}

function defaultName(user: { name?: string | null; email: string }): string {
  const first = user.name?.trim().split(/\s+/)[0];
  return first ? `${first}'s workspace` : "My workspace";
}

/**
 * Creates the user's first workspace if they have none. Called from the Better Auth
 * user-created hook and, defensively, on first access.
 */
export async function ensurePersonalWorkspace(user: {
  id: string;
  name?: string | null;
  email: string;
}): Promise<WorkspaceContext> {
  await ensureIndexes();
  const existing = await findDefaultWorkspace(user.id);
  if (existing) return existing;

  const session = mongoClient.startSession();
  try {
    let ctx: WorkspaceContext | undefined;
    await session.withTransaction(async () => {
      // Re-check inside the transaction to avoid two concurrent first requests creating two workspaces.
      const again = await collections.memberships().findOne({ userId: user.id }, { session });
      if (again) return;
      const now = new Date();
      const workspaceId = new ObjectId();
      const name = defaultName(user);
      await collections
        .workspaces()
        .insertOne({ _id: workspaceId, name, ownerId: user.id, plan: "free", createdAt: now, updatedAt: now }, { session });
      await collections
        .memberships()
        .insertOne({ workspaceId, userId: user.id, role: "owner", status: "active", createdAt: now }, { session });
      ctx = { workspaceId, workspaceName: name, role: "owner", plan: "free", personal: true };
    });
    return ctx ?? (await findDefaultWorkspace(user.id))!;
  } finally {
    await session.endSession();
  }
}

export async function findDefaultWorkspace(userId: string): Promise<WorkspaceContext | null> {
  const membership = await collections
    .memberships()
    .find({ userId, status: "active" })
    .sort({ createdAt: 1 })
    .limit(1)
    .next();
  if (!membership) return null;
  const ws = await collections.workspaces().findOne({ _id: membership.workspaceId });
  if (!ws) return null;
  return toContext(ws, membership.role as Role);
}

export async function findMemberWorkspace(userId: string, workspaceId: string): Promise<WorkspaceContext | null> {
  if (!ObjectId.isValid(workspaceId)) return null;
  const id = new ObjectId(workspaceId);
  const membership = await collections.memberships().findOne({ userId, workspaceId: id, status: "active" });
  if (!membership) return null;
  const ws = await collections.workspaces().findOne({ _id: id });
  if (!ws) return null;
  return toContext(ws, membership.role as Role);
}

/** The workspace to use: the requested one if the user is a member, else their first. */
export async function resolveWorkspace(user: { id: string; name?: string | null; email: string }, requested: string | null | undefined) {
  if (requested) {
    const ws = await findMemberWorkspace(user.id, requested);
    if (ws) return ws;
  }
  return ensurePersonalWorkspace(user);
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  plan: PlanId;
}

export async function listUserWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const ms = await collections.memberships().find({ userId, status: "active" }).sort({ createdAt: 1 }).toArray();
  const wss = await collections.workspaces().find({ _id: { $in: ms.map((m) => m.workspaceId) } }).toArray();
  const byId = new Map(wss.map((w) => [String(w._id), w]));
  return ms.flatMap((m) => {
    const w = byId.get(String(m.workspaceId));
    return w ? [{ id: String(w._id), name: String(w.name), role: m.role as Role, plan: planOf(w.plan).id }] : [];
  });
}

export async function createTeamWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
  await ensureIndexes();
  const now = new Date();
  const workspaceId = new ObjectId();
  const session = mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      await collections.workspaces().insertOne({ _id: workspaceId, name, ownerId: userId, plan: "free", personal: false, createdAt: now, updatedAt: now }, { session });
      await collections.memberships().insertOne({ workspaceId, userId, role: "owner", status: "active", createdAt: now }, { session });
    });
  } finally {
    await session.endSession();
  }
  return { id: workspaceId.toHexString(), name, role: "owner", plan: "free" };
}

export function canEdit(role: Role): boolean {
  return role !== "viewer";
}

/** Owners and admins manage members, billing and workspace settings. */
export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}
