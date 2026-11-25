import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrations, type Integrations } from "./integrations";
import { createHttpClient } from "./net";
import { createRuntime, type Runtime } from "./runtime";
import { createTriggerService } from "./triggers";
import { createVault } from "./vault";
import {
  messageText,
  phoneOf,
  requestWhatsappWebLink,
  requestWhatsappWebUnlink,
  sendWhatsappWeb,
  startWhatsappWeb,
  toJid,
  unwrapMessage,
  whatsappWebStatus,
  type WaMessage,
  type WaSocket,
} from "./whatsapp-web";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let integ: Integrations;
let rt: Runtime;
let authRoot: string;
const userId = "user-1";

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ launchTimeout: 60_000 }] });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("whatsapp_web_test");
  integ = createIntegrations(db, { vault: createVault(new Map([[1, randomBytes(32)]])), http: createHttpClient({ allowPrivateNetwork: true }), allowPrivateNetwork: true, oauthClients: {} });
  rt = createRuntime(db, { allowPrivateNetwork: true }, {}, { integrations: integ });
  authRoot = await mkdtemp(join(tmpdir(), "conduit-wa-"));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
  if (authRoot) await rm(authRoot, { recursive: true, force: true });
});

/** A pretend WhatsApp connection: tests push events in and read what was sent. */
class FakeSocket extends EventEmitter {
  user = { id: "919900011122:7@s.whatsapp.net", lid: "55500011122@lid", name: "Shop bot" };
  sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  read: string[] = [];
  loggedOut = false;
  ended = false;
  get ev() {
    return this;
  }
  async sendMessage(jid: string, content: Record<string, unknown>) {
    this.sent.push({ jid, content });
    return { key: { id: `SENT${this.sent.length}`, remoteJid: jid, fromMe: true } };
  }
  async sendPresenceUpdate() {}
  async readMessages(keys: Array<{ id?: string | null }>) {
    this.read.push(...keys.map((k) => k.id ?? ""));
  }
  async groupMetadata(jid: string) {
    return { id: jid, subject: "Sales team", participants: [{ id: "a" }, { id: "b" }] };
  }
  async groupFetchAllParticipating() {
    return { "120363000000000001@g.us": { id: "120363000000000001@g.us", subject: "Sales team", participants: [{ id: "a" }, { id: "b" }, { id: "c" }] } };
  }
  async downloadMedia() {
    return Buffer.from("fake-jpeg-bytes");
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

function graph(nodes: Array<{ id: string; type: string; parameters?: Record<string, unknown>; to?: string[] }>): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: n.to ? { main: n.to.map((t) => ({ targetId: t })) } : {},
    })),
  });
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};

const msg = (over: Partial<WaMessage> & { text?: string; id: string }): WaMessage => ({
  key: { id: over.id, remoteJid: "77700011122@lid", remoteJidAlt: "919812345678@s.whatsapp.net", fromMe: false, ...over.key },
  message: over.message ?? { conversation: over.text ?? "hi" },
  pushName: over.pushName ?? "Ravi",
  messageTimestamp: 1767258000,
});

describe("message parsing helpers", () => {
  it("finds phone numbers behind @lid ids, unwraps wrappers, and reads captions", () => {
    expect(phoneOf("77700011122@lid", "919812345678@s.whatsapp.net")).toBe("919812345678");
    expect(phoneOf("919812345678:3@s.whatsapp.net")).toBe("919812345678");
    expect(phoneOf("77700011122@lid")).toBeNull();
    expect(toJid("+91 98123-45678")).toBe("919812345678@s.whatsapp.net");
    expect(toJid("120363000000000001@g.us")).toBe("120363000000000001@g.us");
    expect(() => toJid("hello")).toThrow(/isn't a phone number/);
    const inner = unwrapMessage({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: "bill" } } } } } });
    expect(messageText(inner)).toBe("bill");
    expect(messageText({ locationMessage: { name: "Shop", address: "MG Road" } })).toBe("Shop, MG Road");
  });
});

describe("WhatsApp on a linked phone", () => {
  it("links by QR, starts runs for messages (private, group, photo), replies with text and files, and stays one-owner", async () => {
    const ws = new ObjectId();
    const cred = (await integ.create({ workspaceId: ws, userId, app: "whatsappWeb", label: "Shop phone", values: {} }))._id.toHexString();
    const sockets: FakeSocket[] = [];
    const factory = async (dir: string) => {
      await writeFile(join(dir, "creds.json"), "{}");
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WaSocket;
    };
    const wa = startWhatsappWeb(db, rt, { authRoot, socketFactory: factory, syncMs: 60_000, outboxMs: 20, typingDelayMs: [0, 0] });
    const other = startWhatsappWeb(db, rt, { authRoot, socketFactory: factory, syncMs: 60_000, outboxMs: 20, typingDelayMs: [0, 0] });
    try {
      // Nothing happens until someone asks to link.
      await wa.tick();
      expect(sockets).toHaveLength(0);
      await expect(sendWhatsappWeb(db, ws, cred, { to: "+919812345678", text: "hi" })).rejects.toThrow(/isn't linked/);

      await requestWhatsappWebLink(db, ws, cred);
      await wa.tick();
      await other.tick(); // the lease keeps the second worker out
      await until(() => sockets.length === 1);
      const sock = sockets[0]!;
      sock.emit("connection.update", { qr: "2@fake-qr-payload" });
      await until(async () => (await whatsappWebStatus(db, ws, cred)).status === "qr");
      expect((await whatsappWebStatus(db, ws, cred)).qr).toBe("2@fake-qr-payload");
      sock.emit("connection.update", { connection: "open" });
      await until(async () => (await whatsappWebStatus(db, ws, cred)).status === "open");
      const status = await whatsappWebStatus(db, ws, cred);
      expect(status).toMatchObject({ phone: "919900011122", name: "Shop bot", workerRunning: true });
      expect(status.groups).toEqual([{ id: "120363000000000001@g.us", name: "Sales team", members: 3 }]);
      expect((await integ.test(ws, cred))?.account).toBe("+919900011122");
      expect(sockets).toHaveLength(1);

      // Publish: reply to everything; photos get sent back as files.
      const triggers = createTriggerService(db, client);
      const wf = new ObjectId();
      await db.collection("workflows").insertOne({
        _id: wf,
        workspaceId: ws,
        name: "shop bot",
        revision: 1,
        draft: graph([
          { id: "wa", type: "trigger.whatsappWeb", parameters: { credential: cred, groupMode: "mentioned", allowedNumbers: "" }, to: ["reply"] },
          {
            id: "reply",
            type: "app.whatsappWeb.send",
            parameters: {
              credential: cred,
              to: "${['wa']['chatId']}",
              text: "Got from ${['wa']['fromName']}: ${['wa']['text']}",
            },
          },
        ]),
        publishedVersionId: null,
        archivedAt: null,
      });
      await triggers.publish(ws, wf, userId);

      const runs = () => rt.collections.executions.find({ workflowId: wf }).sort({ _id: 1 }).toArray();
      const runAll = async () => {
        for (const e of await runs()) if (e.status === "queued") await rt.processExecution(e._id);
      };

      // A private message (the sender's number hides behind an @lid id).
      sock.emit("messages.upsert", { type: "notify", messages: [msg({ id: "M1", text: "price of 50 units?" })] });
      await until(async () => (await runs()).length === 1);
      // WhatsApp delivers it again, plus our own message and a status update: none of those start runs.
      sock.emit("messages.upsert", {
        type: "notify",
        messages: [msg({ id: "M1" }), msg({ id: "M2", key: { fromMe: true } }), msg({ id: "M3", key: { remoteJid: "status@broadcast" } })],
      });
      // History sync isn't new messages either.
      sock.emit("messages.upsert", { type: "append", messages: [msg({ id: "M4" })] });
      await runAll();
      await until(() => sock.sent.length === 1);
      expect(sock.sent[0]).toEqual({ jid: "77700011122@lid", content: { text: "Got from Ravi: price of 50 units?" } });
      expect(sock.read).toContain("M1");
      const first = (await runs())[0]!;
      const trig = await rt.collections.steps.findOne({ executionId: first._id, nodeId: "wa" });
      expect(trig?.output.main?.[0]?.json).toMatchObject({ from: "919812345678", fromName: "Ravi", isGroup: false, type: "text", text: "price of 50 units?" });

      // Groups: only when mentioned (that's this trigger's setting).
      const group = (id: string, text: string, mentioned: string[] = []) =>
        msg({
          id,
          key: { remoteJid: "120363000000000001@g.us", participant: "66600011122@lid", participantAlt: "919811112222@s.whatsapp.net" },
          message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentioned } } },
          pushName: "Asha",
        });
      sock.emit("messages.upsert", { type: "notify", messages: [group("G1", "lunch?"), group("G2", "@bot who has the Mehta order?", ["55500011122@lid"])] });
      await until(async () => (await runs()).length === 2);
      await runAll();
      await until(() => sock.sent.length === 2);
      expect(sock.sent[1]).toEqual({ jid: "120363000000000001@g.us", content: { text: "Got from Asha: @bot who has the Mehta order?" } });
      const g = await rt.collections.steps.findOne({ executionId: (await runs())[1]!._id, nodeId: "wa" });
      expect(g?.output.main?.[0]?.json).toMatchObject({ isGroup: true, groupName: "Sales team", from: "919811112222", mentionsMe: true });

      // A photo: stored, and its media id works in a send step.
      sock.emit("messages.upsert", { type: "notify", messages: [msg({ id: "P1", message: { imageMessage: { caption: "today's bill", mimetype: "image/jpeg", fileLength: 15 } } })] });
      await until(async () => (await runs()).length === 3);
      const photoRun = (await runs())[2]!;
      await rt.processExecution(photoRun._id);
      const photo = (await rt.collections.steps.findOne({ executionId: photoRun._id, nodeId: "wa" }))?.output.main?.[0]?.json as { media: { id: string; size: number }; text: string };
      expect(photo).toMatchObject({ type: "image", text: "today's bill", media: { size: 15 } });
      const fileBack = await sendWhatsappWeb(db, ws, cred, { to: "+919812345678", text: "Here it is", file: { base64: Buffer.from("fake-jpeg-bytes").toString("base64"), mimetype: "image/jpeg" } });
      expect(fileBack.chatId).toBe("919812345678@s.whatsapp.net");
      const lastSent = sock.sent.at(-1)!;
      expect(lastSent.jid).toBe("919812345678@s.whatsapp.net");
      expect(Buffer.isBuffer(lastSent.content.image)).toBe(true);
      expect(lastSent.content.caption).toBe("Here it is");
      expect((await integ.servicesFor(ws, new Set()).whatsappWeb!.readMedia(photo.media.id))?.base64).toBe(Buffer.from("fake-jpeg-bytes").toString("base64"));
      expect(await integ.servicesFor(new ObjectId(), new Set()).whatsappWeb!.readMedia(photo.media.id)).toBeNull();

      // Logged out on the phone: the saved login is wiped and it says so.
      sock.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
      await until(async () => (await whatsappWebStatus(db, ws, cred)).status === "logged_out");
      expect(await readdir(authRoot)).not.toContain(cred);
      expect((await integ.test(ws, cred))?.status).toBe("error");
      await expect(sendWhatsappWeb(db, ws, cred, { to: "+919812345678", text: "hi" })).rejects.toThrow(/isn't linked/);
    } finally {
      await wa.stop();
      await other.stop();
    }
  }, 120_000);

  it("only listens to the allowed numbers, and unlinking logs the phone out", async () => {
    const ws = new ObjectId();
    const cred = (await integ.create({ workspaceId: ws, userId, app: "whatsappWeb", label: "Team phone", values: {} }))._id.toHexString();
    const sockets: FakeSocket[] = [];
    const wa = startWhatsappWeb(db, rt, {
      authRoot,
      syncMs: 60_000,
      outboxMs: 20,
      typingDelayMs: [0, 0],
      socketFactory: async (dir) => {
        await writeFile(join(dir, "creds.json"), "{}");
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WaSocket;
      },
    });
    try {
      await requestWhatsappWebLink(db, ws, cred);
      await wa.tick();
      await until(() => sockets.length === 1);
      sockets[0]!.emit("connection.update", { connection: "open" });
      await until(async () => (await whatsappWebStatus(db, ws, cred)).status === "open");

      const wf = new ObjectId();
      await db.collection("workflows").insertOne({
        _id: wf,
        workspaceId: ws,
        name: "owner only",
        revision: 1,
        draft: graph([{ id: "wa", type: "trigger.whatsappWeb", parameters: { credential: cred, allowedNumbers: "+91 98123 45678" } }]),
        publishedVersionId: null,
        archivedAt: null,
      });
      await createTriggerService(db, client).publish(ws, wf, userId);
      sockets[0]!.emit("messages.upsert", {
        type: "notify",
        messages: [msg({ id: "A1", key: { remoteJidAlt: "919800000000@s.whatsapp.net" } }), msg({ id: "A2", text: "boss here" })],
      });
      await until(async () => (await rt.collections.executions.countDocuments({ workflowId: wf })) === 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(await rt.collections.executions.countDocuments({ workflowId: wf })).toBe(1);

      await requestWhatsappWebUnlink(db, cred);
      await wa.tick();
      expect(sockets[0]!.loggedOut).toBe(true);
      expect((await whatsappWebStatus(db, ws, cred)).status).toBe("idle");
    } finally {
      await wa.stop();
    }
  }, 120_000);
});

describe("reminders and sending to many", () => {
  it("sends a reminder when it's due (not before), lists and cancels them, and spaces out a broadcast", async () => {
    const ws = new ObjectId();
    const cred = (await integ.create({ workspaceId: ws, userId, app: "whatsappWeb", label: "Office phone", values: {} }))._id.toHexString();
    const sockets: FakeSocket[] = [];
    const wa = startWhatsappWeb(db, rt, {
      authRoot,
      syncMs: 60_000,
      outboxMs: 20,
      typingDelayMs: [0, 0],
      socketFactory: async (dir) => {
        await writeFile(join(dir, "creds.json"), "{}");
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WaSocket;
      },
    });
    try {
      await requestWhatsappWebLink(db, ws, cred);
      await wa.tick();
      await until(() => sockets.length === 1);
      sockets[0]!.emit("connection.update", { connection: "open" });
      await until(async () => (await whatsappWebStatus(db, ws, cred)).status === "open");
      const services = integ.servicesFor(ws, new Set()).whatsappWeb!;

      const soon = await services.schedule(cred, { to: "+91 99000 11122", text: "GST is due today", dueAt: new Date(Date.now() - 1000), createdBy: "Shadab" });
      const later = await services.schedule(cred, { to: "+91 99000 11122", text: "Call Mehta", dueAt: new Date(Date.now() + 3_600_000) });
      const cancelMe = await services.schedule(cred, { to: "+91 98123 45678", text: "Ignore", dueAt: new Date(Date.now() + 7_200_000) });
      expect(soon).toMatchObject({ to: "919900011122@s.whatsapp.net" });
      expect((await services.reminders(cred, {})).map((r) => r.text)).toEqual(["GST is due today", "Call Mehta", "Ignore"]);
      expect(await services.cancelReminder(cancelMe.id)).toBe(true);
      expect(await services.cancelReminder(cancelMe.id)).toBe(false);
      // Another workspace can't see or cancel them.
      expect(await integ.servicesFor(new ObjectId(), new Set()).whatsappWeb!.cancelReminder(later.id)).toBe(false);

      await wa.tick();
      await until(() => sockets[0]!.sent.length === 1);
      expect(sockets[0]!.sent[0]).toEqual({ jid: "919900011122@s.whatsapp.net", content: { text: "GST is due today" } });
      expect((await services.reminders(cred, {})).map((r) => r.text)).toEqual(["Call Mehta"]);
      expect((await services.reminders(cred, { to: "9812345678" })).length).toBe(0);

      // Send to many: duplicates and bad numbers are dropped, and each waits its turn.
      const b = await services.broadcast(cred, { numbers: ["+91 98123 45678", "919812345678", "hello", "+91 98111 12222"], text: "Meeting at 5", spacingMs: [300, 400] });
      expect(b).toMatchObject({ queued: 2, invalid: ["hello"] });
      const start = Date.now();
      await until(() => sockets[0]!.sent.length === 3);
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
      expect(sockets[0]!.sent.slice(1).map((s) => s.jid)).toEqual(["919812345678@s.whatsapp.net", "919811112222@s.whatsapp.net"]);
      await expect(services.broadcast(cred, { numbers: Array.from({ length: 201 }, (_, i) => `9190000${String(i).padStart(5, "0")}`), text: "x" })).rejects.toThrow(/more than 200/);
    } finally {
      await wa.stop();
    }
  }, 120_000);
});
