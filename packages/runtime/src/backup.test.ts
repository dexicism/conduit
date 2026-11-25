import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Binary, MongoClient, ObjectId, type Db } from "mongodb";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, listBackups, restoreDatabase, startBackups } from "./backup";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let dir: string;

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ launchTimeout: 60_000 }] });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("backup_test");
  dir = await mkdtemp(join(tmpdir(), "conduit-backups-"));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("backups", () => {
  it("restores everything exactly (ids, dates, binary), skips throwaway data, and keeps only the last N", async () => {
    const wf = { _id: new ObjectId(), name: "Bot", createdAt: new Date("2026-01-02T03:04:05.678Z"), draft: { nodes: [{ id: "a", parameters: { n: 1.5, big: 2 ** 40 } }] } };
    const file = { _id: new ObjectId(), data: new Binary(Buffer.from([0, 1, 2, 255])), mimetype: "image/jpeg" };
    await db.collection("workflows").insertOne(wf);
    await db.collection("media_files").insertOne(file);
    await db.collection("executions").insertMany(Array.from({ length: 1200 }, (_, i) => ({ i, at: new Date(i * 1000) })));
    await db.collection("jobs").insertOne({ junk: true });

    const r = await backupDatabase(db, dir, { keep: 2, now: new Date("2026-11-27T01:00:00Z") });
    expect(r.collections).toMatchObject({ workflows: 1, media_files: 1, executions: 1200 });
    expect(r.collections).not.toHaveProperty("jobs");

    await db.dropDatabase();
    const restored = await restoreDatabase(db, r.path);
    expect(restored).toMatchObject({ workflows: 1, media_files: 1, executions: 1200 });
    expect(await db.collection("workflows").findOne({ _id: wf._id })).toEqual(wf);
    const back = await db.collection("media_files").findOne({ _id: file._id });
    expect(Buffer.from(back!.data.buffer)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect((await db.collection("executions").findOne({ i: 5 }))?.at).toEqual(new Date(5000));

    // Restoring replaces a collection rather than adding to it.
    await restoreDatabase(db, r.path);
    expect(await db.collection("executions").countDocuments()).toBe(1200);

    await backupDatabase(db, dir, { keep: 2, now: new Date("2026-11-28T01:00:00Z") });
    await backupDatabase(db, dir, { keep: 2, now: new Date("2026-11-29T01:00:00Z") });
    const names = (await listBackups(dir)).map((b) => b.name);
    expect(names).toEqual(["conduit-backup-20261129-0100", "conduit-backup-20261128-0100"]);
    expect((await readdir(dir)).some((n) => n.endsWith(".partial"))).toBe(false);
    await expect(restoreDatabase(db, join(dir, "nope"))).rejects.toThrow();
  }, 120_000);

  it("the daily check only backs up when the newest backup is old enough", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "conduit-backups-"));
    try {
      const logs: string[] = [];
      const b = startBackups(db, { dir: fresh, everyHours: 24, keep: 3, log: (m) => logs.push(m) });
      await b.check();
      await b.check();
      b.stop();
      expect((await listBackups(fresh)).length).toBe(1);
      expect(logs[0]).toMatch(/\[backup\] saved \d+ records/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  }, 120_000);
});
