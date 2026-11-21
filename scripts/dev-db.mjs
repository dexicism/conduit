// Local MongoDB for development: a single-node replica set (so transactions work)
// with data persisted in .data/mongo. Uses the official mongod binary that
// mongodb-memory-server downloads from fastdl.mongodb.org on first run.
//
//   npm run db            -> mongodb://127.0.0.1:27018/?replicaSet=rs0
//
// Stop with Ctrl+C. Data survives restarts; delete .data/mongo to reset.
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.DEV_DB_PORT ?? 27018);
const dbPath = resolve(process.cwd(), ".data", "mongo");
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: "rs0", storageEngine: "wiredTiger" },
  instanceOpts: [{ port, dbPath }],
});

const uri = `mongodb://127.0.0.1:${port}/?replicaSet=rs0`;
console.log(`\n  MongoDB ready at ${uri}`);
console.log(`  Data directory: ${dbPath}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log("\n  Stopping MongoDB...");
  // doCleanup:false keeps the user-provided dbPath on disk.
  await replSet.stop({ doCleanup: false });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
