/**
 * Puts a backup back into the database. Stop Conduit first (Stop Conduit), keep
 * the database running (npm run db), then:
 *
 *   npx tsx scripts/restore-backup.mts                  lists the backups
 *   npx tsx scripts/restore-backup.mts <backup folder>  restores that one
 *
 * Every collection in the backup replaces the current one. Saved accounts only
 * work again with the same encryption key (apps/web/.data/encryption.key).
 */
import { resolve } from "node:path";
import { listBackups, restoreDatabase } from "@conduit/runtime";
import { MongoClient } from "mongodb";

const dir = process.env.BACKUP_DIR ?? resolve("apps", "web", ".data", "backups");
const target = process.argv[2];
if (!target) {
  const all = await listBackups(dir);
  if (!all.length) console.log(`No backups in ${dir}`);
  for (const b of all) console.log(`${b.createdAt}  ${b.path}`);
  process.exit(0);
}
const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0");
try {
  const restored = await restoreDatabase(client.db(process.env.MONGODB_DB ?? "conduit"), resolve(target));
  for (const [name, n] of Object.entries(restored)) console.log(`${name}: ${n}`);
  console.log("Restored. Start Conduit again.");
} finally {
  await client.close();
}
