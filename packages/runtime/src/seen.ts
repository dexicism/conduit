import { createHash } from "node:crypto";
import type { SeenService } from "@conduit/engine";
import { MongoBulkWriteError, type Db, type ObjectId } from "mongodb";

interface SeenDoc {
  workflowId: ObjectId;
  nodeId: string;
  /** SHA-256 of the key, so long URLs don't bloat the index. */
  key: string;
  createdAt: Date;
}

/**
 * Memory for "Only new items". Live runs remember keys; test runs only look,
 * so trying a workflow in the editor never uses up real items.
 */
export function createSeenService(db: Db, workflowId: ObjectId, record: boolean): SeenService {
  const col = db.collection<SeenDoc>("seen_items");
  return {
    async filterNew(nodeId, keys) {
      const hashes = keys.map((k) => createHash("sha256").update(k).digest("base64url"));
      const firstRun = record && !(await col.findOne({ workflowId, nodeId }, { projection: { _id: 1 } }));
      const known = new Set(
        (await col.find({ workflowId, nodeId, key: { $in: [...new Set(hashes)] } }, { projection: { key: 1 } }).toArray()).map((d) => d.key),
      );
      const inThisRun = new Set<string>();
      const fresh = hashes.map((h) => {
        const isNew = !known.has(h) && !inThisRun.has(h);
        inThisRun.add(h);
        return isNew;
      });
      if (record) {
        const now = new Date();
        const docs = [...new Set(hashes.filter((_, i) => fresh[i]))].map((key) => ({ workflowId, nodeId, key, createdAt: now }));
        // Two runs at once can race; a duplicate just means the other run got there first.
        if (docs.length) {
          await col.insertMany(docs, { ordered: false }).catch((e: unknown) => {
            const errs = e instanceof MongoBulkWriteError ? [e.writeErrors].flat() : null;
            if (!errs || errs.some((w) => w.code !== 11000)) throw e;
          });
        }
      }
      return { fresh, firstRun };
    },
  };
}

export async function ensureSeenIndexes(db: Db): Promise<void> {
  const col = db.collection("seen_items");
  await Promise.all([
    col.createIndex({ workflowId: 1, nodeId: 1, key: 1 }, { unique: true }),
    // Forget keys after half a year, so the collection doesn't grow forever.
    col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 180 * 86_400 }),
  ]);
}
