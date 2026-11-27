import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryService, ensureMemoryIndexes } from "./llm";

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db("memory_test");
  await ensureMemoryIndexes(db);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});

const turn = (role: "user" | "assistant", text: string) => ({ role, text });

describe("chat memory", () => {
  it("keeps only the recent exchanges by default", async () => {
    const m = createMemoryService(db, new ObjectId());
    for (let i = 0; i < 15; i++) await m.append("agent", "c1", [turn("user", `q${i}`), turn("assistant", `a${i}`)], 10);
    const all = await m.load("agent", "c1");
    expect(all).toHaveLength(20);
    expect(all[0]!.text).toBe("q5");
    expect(all[0]!.at).toEqual(expect.any(String));
  });

  it("with days set, keeps the whole chat from those days, even when another step adds with a small keep, and drops older turns", async () => {
    const ws = new ObjectId();
    const m = createMemoryService(db, new ObjectId(), ws);
    for (let i = 0; i < 40; i++) await m.append("__shared", "9198", [turn("user", `message ${i}`), turn("assistant", `reply ${i}`)], 10, 30);
    // A checker adds its question with keep 10: the 30-day chat isn't cut.
    await m.append("__shared", "9198", [turn("assistant", "[Checker asked] Raghav quotation ready?")], 10);
    expect(await m.load("__shared", "9198")).toHaveLength(81);

    // Something said 40 days ago is gone after the next message.
    await db.collection("agent_memory").updateOne({ workflowId: ws, nodeId: "__shared", sessionKey: "9198" }, { $set: { "turns.0.at": new Date(Date.now() - 40 * 86_400_000), "turns.0.text": "very old" } });
    await m.append("__shared", "9198", [turn("user", "new")], 10);
    const after = await m.load("__shared", "9198");
    expect(after.map((t) => t.text)).not.toContain("very old");
    expect(after).toHaveLength(81);

    // Search: every word has to be there, newest last.
    expect((await m.search!("__shared", "9198", "RAGHAV quotation", 5)).map((t) => t.text)).toEqual(["[Checker asked] Raghav quotation ready?"]);
    expect((await m.search!("__shared", "9198", "message 3", 3)).map((t) => t.text)).toEqual(["message 37", "message 38", "message 39"]);
    expect(await m.search!("__shared", "nobody", "x y", 5)).toEqual([]);
  });
});
