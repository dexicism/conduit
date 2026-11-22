import { ObjectId, type Db } from "mongodb";
import type { SealedSecret, Vault } from "./vault";

/**
 * Workspace variables: values every workflow can use as ${['$vars']['NAME']}.
 * Handy for things you'd otherwise paste into ten steps (a phone number, a
 * sheet link, a base URL). Secret ones are encrypted and masked in run logs.
 */

export interface VariableDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  name: string;
  secret: boolean;
  /** Plain value, for non-secret variables. */
  value?: string;
  /** Encrypted value, for secret ones. */
  sealed?: SealedSecret;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariableView {
  id: string;
  name: string;
  secret: boolean;
  /** Null for secrets: they're never sent back. */
  value: string | null;
  updatedAt: string;
}

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_VARIABLES = 200;
export const MAX_VARIABLE_VALUE = 10_000;

export class VariableError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "exists" | "limit" | "not_found" | "no_vault" = "invalid",
  ) {
    super(message);
    this.name = "VariableError";
  }
}

export function isVariableError(e: unknown): e is VariableError {
  return e instanceof Error && e.name === "VariableError";
}

function toView(d: VariableDoc): VariableView {
  return { id: d._id.toHexString(), name: d.name, secret: d.secret, value: d.secret ? null : (d.value ?? ""), updatedAt: d.updatedAt.toISOString() };
}

export async function ensureVariableIndexes(db: Db) {
  await db.collection("variables").createIndex({ workspaceId: 1, name: 1 }, { unique: true });
}

export function createVariables(db: Db, vault?: Vault) {
  const col = db.collection<VariableDoc>("variables");

  function check(name: string, value: string) {
    if (!VARIABLE_NAME.test(name)) throw new VariableError("Use letters, numbers and _ only, starting with a letter (e.g. SUPPORT_PHONE)");
    if (value.length > MAX_VARIABLE_VALUE) throw new VariableError(`Keep the value under ${MAX_VARIABLE_VALUE.toLocaleString()} characters`);
  }

  function seal(workspaceId: ObjectId, id: ObjectId, value: string) {
    if (!vault) throw new VariableError("Secret variables need an encryption key on this server", "no_vault");
    return vault.seal(workspaceId, id, { value });
  }

  async function list(workspaceId: ObjectId): Promise<VariableView[]> {
    return (await col.find({ workspaceId }).sort({ name: 1 }).limit(MAX_VARIABLES).toArray()).map(toView);
  }

  async function create(workspaceId: ObjectId, userId: string, input: { name: string; value: string; secret: boolean }): Promise<VariableView> {
    check(input.name, input.value);
    await ensureVariableIndexes(db);
    if ((await col.countDocuments({ workspaceId })) >= MAX_VARIABLES) throw new VariableError(`A workspace can have up to ${MAX_VARIABLES} variables`, "limit");
    const _id = new ObjectId();
    const now = new Date();
    const doc: VariableDoc = {
      _id,
      workspaceId,
      name: input.name,
      secret: input.secret,
      ...(input.secret ? { sealed: seal(workspaceId, _id, input.value) } : { value: input.value }),
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await col.insertOne(doc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new VariableError(`There's already a variable called ${input.name}`, "exists");
      throw e;
    }
    return toView(doc);
  }

  /** A secret's value only changes when a new one is given. */
  async function update(workspaceId: ObjectId, userId: string, id: string, input: { value?: string }): Promise<VariableView> {
    if (!ObjectId.isValid(id)) throw new VariableError("Variable not found", "not_found");
    const _id = new ObjectId(id);
    const doc = await col.findOne({ _id, workspaceId });
    if (!doc) throw new VariableError("Variable not found", "not_found");
    if (input.value === undefined) return toView(doc);
    check(doc.name, input.value);
    const set = doc.secret ? { sealed: seal(workspaceId, _id, input.value) } : { value: input.value };
    const after = await col.findOneAndUpdate({ _id, workspaceId }, { $set: { ...set, updatedBy: userId, updatedAt: new Date() } }, { returnDocument: "after" });
    return toView(after!);
  }

  async function remove(workspaceId: ObjectId, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    return (await col.deleteOne({ _id: new ObjectId(id), workspaceId })).deletedCount === 1;
  }

  /** Every variable's value for a run, plus the secret values so they can be masked. */
  async function load(workspaceId: ObjectId): Promise<{ vars: Record<string, string>; secrets: string[] }> {
    const vars: Record<string, string> = {};
    const secrets: string[] = [];
    for (const d of await col.find({ workspaceId }).limit(MAX_VARIABLES).toArray()) {
      if (!d.secret) vars[d.name] = d.value ?? "";
      else if (vault && d.sealed) {
        try {
          const v = vault.open(workspaceId, d._id, d.sealed).value ?? "";
          vars[d.name] = v;
          if (v) secrets.push(v);
        } catch {
          // A key that no longer opens it: leave the variable out, so steps using it say it's missing.
        }
      }
    }
    return { vars, secrets };
  }

  return { list, create, update, remove, load };
}

export type Variables = ReturnType<typeof createVariables>;
