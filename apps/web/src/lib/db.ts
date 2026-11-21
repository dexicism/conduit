import "server-only";
import { MongoClient, type Db } from "mongodb";
import { env } from "./env";

// One client per process. In dev, Next.js hot reload re-evaluates modules, so the
// client is cached on globalThis to avoid leaking connection pools.
interface Holder {
  client: MongoClient;
  indexes?: Promise<void>;
}

const globalForMongo = globalThis as unknown as { __conduitMongo?: Holder };

function create(): Holder {
  const client = new MongoClient(env.MONGODB_URI, {
    appName: "conduit-web",
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 8000,
  });
  return { client };
}

const holder = globalForMongo.__conduitMongo ?? create();
if (!env.isProd) globalForMongo.__conduitMongo = holder;

export const mongoClient = holder.client;
export const db: Db = mongoClient.db(env.MONGODB_DB);

/** Collections owned by Conduit (Better Auth manages user/session/account/verification). */
export const collections = {
  workspaces: () => db.collection("workspaces"),
  memberships: () => db.collection("memberships"),
  workflows: () => db.collection("workflows"),
};

async function createIndexes(): Promise<void> {
  await Promise.all([
    collections.memberships().createIndex({ workspaceId: 1, userId: 1 }, { unique: true }),
    collections.memberships().createIndex({ userId: 1, createdAt: 1 }),
    collections.workflows().createIndex({ workspaceId: 1, archivedAt: 1, updatedAt: -1, _id: -1 }),
    collections
      .workflows()
      .createIndex(
        { workspaceId: 1, requestId: 1 },
        { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
      ),
  ]);
}

/** Idempotent; runs once per process before the first data access that needs it. */
export function ensureIndexes(): Promise<void> {
  holder.indexes ??= createIndexes().catch((err) => {
    holder.indexes = undefined;
    throw err;
  });
  return holder.indexes;
}
