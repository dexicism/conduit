import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import type { LlmRequest, LlmResult, LlmService } from "@conduit/engine";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIntegrations, redactValue, resolveSafeHost, runPostgres, sendSmtp, type Integrations } from "./integrations";
import { createHttpClient } from "./net";
import { createRuntime, type Runtime } from "./runtime";
import { FAKE, startFakeApis, type FakeApis } from "./testing/fake-apis";
import { telegramModeFromEnv } from "./integrations-env";
import { startTelegramPoller } from "./telegram-poll";
import { createTriggerService } from "./triggers";
import { createVault, parseMasterKeys, VaultError } from "./vault";

let rs: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let fake: FakeApis;
let integ: Integrations;
let rt: Runtime;
let llmScript: LlmResult[] = [];
const llmRequests: LlmRequest[] = [];
const userId = "user-1";

const scriptedLlm: LlmService = {
  async chat(req) {
    llmRequests.push(req);
    const next = llmScript.shift();
    if (!next) return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
    return next;
  },
};

function makeIntegrations(allowPrivateNetwork = true) {
  return createIntegrations(db, {
    vault: createVault(new Map([[1, randomBytes(32)]])),
    http: createHttpClient({ allowPrivateNetwork }),
    allowPrivateNetwork,
    apiBaseOverride: fake.url,
    oauthClients: { google: { clientId: FAKE.googleClientId, clientSecret: FAKE.googleClientSecret } },
  });
}

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ launchTimeout: 60_000 }] });
  client = new MongoClient(rs.getUri());
  await client.connect();
  db = client.db("integrations_test");
  fake = await startFakeApis();
  integ = makeIntegrations();
  rt = createRuntime(db, { allowPrivateNetwork: true }, { llm: scriptedLlm }, { integrations: integ });
}, 120_000);

afterAll(async () => {
  await client?.close();
  await rs?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

type N = { id: string; type: string; parameters?: Record<string, unknown>; to?: Record<string, Array<string | { targetId: string; targetHandle: string }>> };
function graph(nodes: N[]): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: Object.fromEntries(
        Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => (typeof t === "string" ? { targetId: t } : t))]),
      ),
    })),
  });
}

async function run(workspaceId: ObjectId, nodes: N[]) {
  const g = graph(nodes);
  const workflowId = new ObjectId();
  await db.collection("workflows").insertOne({ _id: workflowId, workspaceId, name: "t", revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
  const id = await rt.createExecution(
    { workspaceId, workflowId, workflowName: "t", versionId: null, mode: "test", graph: g, triggerNodeId: nodes[0]!.id, triggerItems: [{ json: { email: "ana@example.com" } }] },
    false,
  );
  const done = await rt.processExecution(id);
  const steps = await rt.collections.steps.find({ executionId: id }).sort({ index: 1 }).toArray();
  return { done, steps, output: (nodeId: string) => steps.find((s) => s.nodeId === nodeId)?.output.main?.map((i) => i.json) };
}

async function cred(workspaceId: ObjectId, app: string, values: Record<string, string>, extra: { expiresAt?: Date | null } = {}) {
  return (await integ.create({ workspaceId, userId, app, label: app, values, ...extra }))._id.toHexString();
}

describe("vault", () => {
  const vault = createVault(new Map([[1, randomBytes(32)]]));
  const ws = new ObjectId();
  const id = new ObjectId();

  it("round-trips and binds the ciphertext to its workspace and credential", () => {
    const sealed = vault.seal(ws, id, { token: "s3cret" });
    expect(JSON.stringify(sealed)).not.toContain("s3cret");
    expect(vault.open(ws, id, sealed)).toEqual({ token: "s3cret" });
    expect(() => vault.open(new ObjectId(), id, sealed)).toThrow(VaultError);
    expect(() => vault.open(ws, new ObjectId(), sealed)).toThrow(VaultError);
  });

  it("detects tampering and supports key rotation", () => {
    const sealed = vault.seal(ws, id, { token: "x" });
    const bytes = Buffer.from(sealed.data, "base64");
    bytes[bytes.length - 1]! ^= 1;
    expect(() => vault.open(ws, id, { ...sealed, data: bytes.toString("base64") })).toThrow(VaultError);

    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    const old = createVault(parseMasterKeys(`v1:${k1}`));
    const rotated = createVault(parseMasterKeys(`v1:${k1},v2:${k2}`));
    const s1 = old.seal(ws, id, { a: "1" });
    expect(rotated.currentVersion).toBe(2);
    expect(rotated.open(ws, id, s1)).toEqual({ a: "1" });
    expect(rotated.seal(ws, id, { a: "1" }).keyVersion).toBe(2);
    expect(() => parseMasterKeys("short")).toThrow(/32 bytes/);
  });
});

describe("credentials in runs", () => {
  it("can't use another workspace's credential", async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const id = await cred(a, "telegram", { botToken: FAKE.telegramToken });
    const r = await run(b, [
      { id: "t", type: "trigger.manual", to: { main: ["send"] } },
      { id: "send", type: "app.telegram.send", parameters: { credential: id, chatId: "1", text: "hi" } },
    ]);
    expect(r.done.status).toBe("failed");
    expect(r.done.error?.message).toMatch(/doesn't exist in this workspace/);
    expect(fake.calls).toHaveLength(0);
  });

  it("masks secret values everywhere a run is stored", async () => {
    const ws = new ObjectId();
    const secret = `Bearer sk-${randomBytes(12).toString("hex")}`;
    const id = await cred(ws, "httpHeader", { headerName: "Authorization", headerValue: secret });
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["http"] } },
      { id: "http", type: "core.http", parameters: { url: `${fake.url}/echo.test/x`, authentication: "credential", credential: id }, to: { main: ["code"] } },
      // Copies the echoed header into its own output and fails with it in the message.
      { id: "code", type: "core.code", parameters: { mode: "all", code: "throw new Error('leak ' + items[0].body.headers.authorization)" } },
    ]);
    // The real header reached the server.
    expect(fake.calls[0]?.headers.authorization).toBe(secret);
    expect(r.done.status).toBe("failed");
    const stored = JSON.stringify([await rt.collections.executions.findOne({ _id: r.done._id }), r.steps]);
    expect(stored).not.toContain(secret.slice(7));
    expect(stored).toContain("[hidden]");
  });

  it("redacts nested and URL-encoded copies", () => {
    const s = new Set(["abc/def=="]);
    expect(redactValue({ a: ["x abc/def== y"], b: "abc%2Fdef%3D%3D" }, s)).toEqual({ a: ["x [hidden] y"], b: "[hidden]" });
  });
});

describe("app actions", () => {
  it("Telegram: sends a message; a bad token fails clearly", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "telegram", { botToken: FAKE.telegramToken });
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["send"] } },
      { id: "send", type: "app.telegram.send", parameters: { credential: id, chatId: "777", text: "Hello ${['$input']['email']}" } },
    ]);
    expect(r.done.status).toBe("success");
    expect(r.output("send")).toEqual([{ messageId: 43, chatId: 777, date: "2026-01-01T09:00:01.000Z", text: "Hello ana@example.com" }]);

    const bad = await cred(ws, "telegram", { botToken: "999:not-a-real-token-zzzzzz" });
    const r2 = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["send"] } },
      { id: "send", type: "app.telegram.send", parameters: { credential: bad, chatId: "1", text: "x" } },
    ]);
    expect(r2.done.error?.message).toBe("Telegram: Unauthorized");
  });

  it("Slack: posts, explains not_in_channel, and lists channels", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "slack", { botToken: FAKE.slackToken });
    const ok = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["s"] } },
      { id: "s", type: "app.slack.send", parameters: { credential: id, channel: "#general", text: "hi" } },
    ]);
    expect(ok.output("s")).toEqual([{ ok: true, channel: "C0GENERAL", ts: "1767258000.000100" }]);
    const no = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["s"] } },
      { id: "s", type: "app.slack.send", parameters: { credential: id, channel: "C0RANDOM", text: "hi" } },
    ]);
    expect(no.done.error?.message).toMatch(/not_in_channel \(invite the bot/);
    const options = await integ.dynamicOptions(ws, "slack.channels", id, {});
    expect(options).toEqual([
      { value: "C0GENERAL", label: "#general" },
      { value: "C0RANDOM", label: "#random (bot not in channel)" },
    ]);
  });

  it("Google: Sheets header mapping, reading rows, and Gmail", async () => {
    const ws = new ObjectId();
    const tokens = await googleTokens();
    const id = await cred(ws, "google", tokens, { expiresAt: new Date(Date.now() + 3600_000) });
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${FAKE.spreadsheetId}/edit#gid=0`;

    const append = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      {
        id: "add",
        type: "app.sheets.append",
        parameters: { credential: id, spreadsheetId: sheetUrl, sheet: "Sheet1", columns: [{ key: "email", value: "${['$input']['email']}" }, { key: "Name", value: "Cy" }] },
      },
    ]);
    expect(append.done.status).toBe("success");
    expect(append.output("add")).toEqual([{ updatedRange: "Sheet1!A4:C4", row: 4, values: { Email: "ana@example.com", Name: "Cy" } }]);
    expect(fake.state.sheets[FAKE.spreadsheetId]!.Sheet1![3]).toEqual(["Cy", "ana@example.com", ""]);

    const unknown = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      { id: "add", type: "app.sheets.append", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Sheet1", columns: [{ key: "Phone", value: "1" }] } },
    ]);
    expect(unknown.done.error?.message).toBe('No column named "Phone". The sheet has: Name, Email, Plan');

    const read = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["rows"] } },
      { id: "rows", type: "app.sheets.read", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Sheet1", limit: 2 } },
    ]);
    expect(read.output("rows")).toEqual([
      { row: 2, Name: "Ana", Email: "ana@example.com", Plan: "pro" },
      { row: 3, Name: "Ben", Email: "ben@example.com", Plan: "free" },
    ]);
    expect(await integ.dynamicOptions(ws, "google.sheets", id, { spreadsheetId: sheetUrl })).toEqual([
      { value: "Sheet1", label: "Sheet1" },
      { value: "Archive", label: "Archive" },
    ]);

    const mail = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["m"] } },
      { id: "m", type: "app.gmail.send", parameters: { credential: id, to: "ana@example.com", subject: "Grüße\r\nBcc: evil@example.com", body: "Hi Ana" } },
    ]);
    expect(mail.done.status).toBe("success");
    const sent = fake.state.sentMail[0]!;
    expect(sent).toContain("To: ana@example.com");
    expect(sent).toContain("Subject: =?UTF-8?B?");
    expect(sent).not.toMatch(/^Bcc:/m); // CR/LF stripped: no header injection
    expect(Buffer.from(sent.split("\r\n\r\n")[1]!, "base64").toString()).toBe("Hi Ana");
  });

  it("WhatsApp: text and template messages, the 24-hour rule hint, and the account check", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "whatsapp", { phoneNumberId: FAKE.whatsappPhoneId, accessToken: FAKE.whatsappToken });
    expect(await integ.check("whatsapp", { phoneNumberId: FAKE.whatsappPhoneId, accessToken: FAKE.whatsappToken })).toBe("Conduit Test +62 811 0000 000");
    const text = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["wa"] } },
      { id: "wa", type: "app.whatsapp.send", parameters: { credential: id, to: "+62 812-3456-789", messageType: "text", text: "Your order shipped" } },
    ]);
    expect(text.done.status).toBe("success");
    expect(fake.calls.find((c) => c.path.endsWith("/messages"))?.body).toMatchObject({ messaging_product: "whatsapp", to: "628123456789", type: "text", text: { body: "Your order shipped" } });

    const tpl = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["wa"] } },
      {
        id: "wa",
        type: "app.whatsapp.send",
        parameters: { credential: id, to: "+6281112345", messageType: "template", templateName: "order_update", languageCode: "id", templateValues: [{ key: "1", value: "Ana" }] },
      },
    ]);
    expect(tpl.done.status).toBe("success");
    expect(fake.calls.at(-1)?.body).toMatchObject({ type: "template", template: { name: "order_update", language: { code: "id" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }] } });

    const late = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["wa"] } },
      { id: "wa", type: "app.whatsapp.send", parameters: { credential: id, to: "+62811000", messageType: "text", text: "hi" } },
    ]);
    expect(late.done.error?.message).toMatch(/use an approved template/);
  });

  it("Google Calendar: creates an event with invitees, validating dates", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const ok = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["ev"] } },
      { id: "ev", type: "app.calendar.create", parameters: { credential: id, summary: "Demo with ${['$input']['email']}", start: "2026-01-15T10:00", end: "2026-01-15T10:30", timeZone: "Asia/Jakarta", attendees: "ana@example.com" } },
    ]);
    expect(ok.done.status).toBe("success");
    const call = fake.calls.find((c) => c.host === "www.googleapis.com")!;
    expect(call.path).toBe("/calendar/v3/calendars/primary/events?sendUpdates=all");
    expect(call.body).toMatchObject({ summary: "Demo with ana@example.com", start: { dateTime: "2026-01-15T10:00:00", timeZone: "Asia/Jakarta" }, attendees: [{ email: "ana@example.com" }] });
    const bad = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["ev"] } },
      { id: "ev", type: "app.calendar.create", parameters: { credential: id, summary: "x", start: "tomorrow", end: "2026-01-15T10:30" } },
    ]);
    expect(bad.done.error?.message).toMatch(/Starts: use a date and time/);
  });

  it("an agent calls an app action as a tool, with the values it fills in", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "telegram", { botToken: FAKE.telegramToken });
    llmScript = [
      {
        content: [{ type: "tool_use", id: "tu1", name: "notify", input: { chatId: "555", text: "Order shipped" } }],
        stopReason: "tool_use",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { content: [{ type: "text", text: "Sent." }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    llmRequests.length = 0;
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["agent"] } },
      { id: "agent", type: "ai.agent", parameters: { prompt: "Tell the customer", memory: "none" }, to: { tool: [{ targetId: "tg", targetHandle: "agent" }] } },
      {
        id: "tg",
        type: "tool.app.telegram.send",
        parameters: {
          toolName: "notify",
          toolDescription: "Message the customer",
          credential: id,
          chatId: "={{AI('chatId', `Customer chat id`, 'string')}}",
          text: "={{AI('text', `Message`, 'string')}}",
        },
      },
    ]);
    expect(r.done.status).toBe("success");
    const tool = llmRequests[0]!.tools!.find((t) => t.name === "notify")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["chatId", "text"]);
    const sent = fake.calls.find((c) => c.path.endsWith("/sendMessage"));
    expect(sent?.body).toMatchObject({ chat_id: "555", text: "Order shipped" });
  });
});

/** Runs the real OAuth code flow against the fake Google: authorize → code → token exchange with PKCE. */
async function googleTokens(): Promise<Record<string, string>> {
  const { authorizeUrl, exchangeCode, newPkce, newState } = await import("./oauth");
  const pkce = newPkce();
  const state = newState();
  const redirectUri = "http://localhost:3000/api/credentials/oauth/callback";
  const url = authorizeUrl("google", { clientId: FAKE.googleClientId, redirectUri, state, codeChallenge: pkce.challenge, scopes: ["email"] }, integ.apiUrl);
  const res = await fetch(url, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  expect(back.searchParams.get("state")).toBe(state);
  const http = createHttpClient({ allowPrivateNetwork: true });
  const client = { clientId: FAKE.googleClientId, clientSecret: FAKE.googleClientSecret };
  await expect(exchangeCode(http, integ.apiUrl, "google", client, { code: back.searchParams.get("code")!, redirectUri, codeVerifier: "wrong" })).rejects.toThrow(
    /invalid|Bad code/,
  );
  // The failed attempt consumed that code; get a fresh one.
  const res2 = await fetch(authorizeUrl("google", { clientId: FAKE.googleClientId, redirectUri, state, codeChallenge: pkce.challenge, scopes: ["email"] }, integ.apiUrl), {
    redirect: "manual",
  });
  const code = new URL(res2.headers.get("location")!).searchParams.get("code")!;
  const t = await exchangeCode(http, integ.apiUrl, "google", client, { code, redirectUri, codeVerifier: pkce.verifier });
  return { accessToken: t.accessToken, refreshToken: t.refreshToken! };
}

describe("OAuth tokens", () => {
  it("refreshes an expiring token once, even with concurrent runs", async () => {
    const ws = new ObjectId();
    const tokens = await googleTokens();
    const id = await cred(ws, "google", tokens, { expiresAt: new Date(Date.now() - 1000) });
    const results = await Promise.all(Array.from({ length: 5 }, () => integ.resolve(ws, id, "google")));
    expect(fake.state.refreshCount).toBe(1);
    const fresh = results.map((r) => r.values.accessToken);
    expect(new Set(fresh).size).toBe(1);
    expect(fresh[0]).not.toBe(tokens.accessToken);
    const doc = await integ.collections.credentials.findOne({ _id: new ObjectId(id) });
    expect(doc!.version).toBe(2);
    expect(doc!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(await integ.check("google", results[0]!.values)).toBe(FAKE.googleEmail);
  });

  it("marks the account broken when the refresh token is revoked", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", { accessToken: "old", refreshToken: "1//revoked" }, { expiresAt: new Date(0) });
    await expect(integ.resolve(ws, id, "google")).rejects.toThrow(/expired or revoked/);
    const doc = await integ.collections.credentials.findOne({ _id: new ObjectId(id) });
    expect(doc!.status).toBe("error");
  });
});

describe("Telegram trigger publishing", () => {
  it("sets the bot's webhook with a secret, refuses a second workflow on the same bot, and removes it on unpublish", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "telegram", { botToken: FAKE.telegramToken });
    const triggers = createTriggerService(db, client, {
      telegram: {
        urlFor: (p) => `https://app.example.com/hook/telegram/${p}`,
        register: (w, c, url, secret) => integ.telegram.setWebhook(w, c, url, secret),
        unregister: (w, c) => integ.telegram.deleteWebhook(w, c),
      },
    });
    const g = graph([
      { id: "tg", type: "trigger.telegram", parameters: { credential: id }, to: { main: ["reply"] } },
      { id: "reply", type: "app.telegram.send", parameters: { credential: id, chatId: "${['$input']['message']['chat']['id']}", text: "Got it" } },
    ]);
    const wf1 = new ObjectId();
    const wf2 = new ObjectId();
    for (const _id of [wf1, wf2]) {
      await db.collection("workflows").insertOne({ _id, workspaceId: ws, name: `bot ${_id}`, revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
    }
    const pub = await triggers.publish(ws, wf1, userId);
    expect(pub.triggers).toMatchObject([{ kind: "telegram", nodeId: "tg" }]);
    const hook = fake.state.telegramWebhooks[FAKE.telegramToken]!;
    const doc = await triggers.findTelegram(hook.url.split("/").pop()!);
    expect(doc?.secretToken).toBe(hook.secretToken);
    expect(hook.secretToken!.length).toBeGreaterThanOrEqual(32);

    await expect(triggers.publish(ws, wf2, userId)).rejects.toThrow(/already starts the live workflow/);
    await triggers.unpublish(ws, wf1);
    expect(fake.state.telegramWebhooks[FAKE.telegramToken]).toBeUndefined();
    expect(await triggers.findTelegram(doc!.path!)).toBeNull();
  });
});

describe("drivers: PostgreSQL and SMTP", () => {
  let pgServer: PGLiteSocketServer;
  let smtp: SMTPServer;
  let smtpPort = 0;
  const received: string[] = [];
  const pgPort = 54000 + Math.floor(Math.random() * 900);

  beforeAll(async () => {
    // PGlite: real PostgreSQL compiled to WebAssembly, served over the wire protocol, so the `pg` driver is exercised for real.
    pgServer = new PGLiteSocketServer({ db: await PGlite.create(), port: pgPort, host: "127.0.0.1" });
    await pgServer.start();
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, _s, cb) {
        let data = "";
        stream.on("data", (c: Buffer) => (data += c.toString()));
        stream.on("end", () => {
          received.push(data);
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
    smtpPort = (smtp.server.address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await pgServer?.stop();
    await new Promise<void>((r) => (smtp ? smtp.close(() => r()) : r()));
  });

  const pgCfg = () => ({ host: "127.0.0.1", port: String(pgPort), database: "postgres", user: "postgres", password: "pg-pass-123", ssl: "disable" });

  it("runs parameterized queries and returns rows as items", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "postgres", pgCfg());
    await runPostgres(pgCfg(), "create table if not exists people (id serial primary key, email text, joined timestamptz default now())", [], 5000, true);
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["ins"] } },
      { id: "ins", type: "app.postgres.query", parameters: { credential: id, query: "insert into people(email) values ($1) returning id, email", values: '["${[\'$input\'][\'email\']}"]' }, to: { main: ["sel"] } },
      { id: "sel", type: "app.postgres.query", parameters: { credential: id, query: "select email, joined from people where email = $1", values: '["ana@example.com"]' } },
    ]);
    expect(r.done.status).toBe("success");
    expect(r.output("ins")).toEqual([{ id: 1, email: "ana@example.com" }]);
    expect(r.output("sel")![0]).toMatchObject({ email: "ana@example.com" });
    expect(typeof r.output("sel")![0]!.joined).toBe("string");
    // Injection attempt stays a value.
    const inj = await runPostgres(pgCfg(), "select $1::text as v", ["'; drop table people; --"], 5000, true);
    expect(inj.rows).toEqual([{ v: "'; drop table people; --" }]);
    expect((await runPostgres(pgCfg(), "select count(*)::int as n from people", [], 5000, true)).rows).toEqual([{ n: 1 }]);
    // Errors are clear and don't include the password.
    const bad = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["q"] } },
      { id: "q", type: "app.postgres.query", parameters: { credential: id, query: "select * from nope" } },
    ]);
    expect(bad.done.error?.message).toMatch(/PostgreSQL: relation "nope" does not exist/);
  }, 60_000);

  it("sends email through SMTP and verifies the account", async () => {
    const ws = new ObjectId();
    const cfg = { host: "127.0.0.1", port: String(smtpPort), security: "none", from: "Conduit <bot@example.com>" };
    const id = await cred(ws, "smtp", cfg);
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["mail"] } },
      { id: "mail", type: "app.smtp.send", parameters: { credential: id, to: "${['$input']['email']}", subject: "Welcome", text: "Hello!" } },
    ]);
    expect(r.done.status).toBe("success");
    expect(r.output("mail")![0]).toMatchObject({ accepted: ["ana@example.com"], rejected: [] });
    expect(received.at(-1)).toMatch(/Subject: Welcome/);
    expect(await integ.test(ws, id)).toMatchObject({ status: "ok" });
  });

  it("blocks private addresses unless allowed, for databases and SMTP too", async () => {
    await expect(resolveSafeHost("127.0.0.1", false)).rejects.toThrow(/private network/);
    await expect(resolveSafeHost("localhost", false)).rejects.toThrow(/private network/);
    await expect(runPostgres(pgCfg(), "select 1", [], 3000, false)).rejects.toThrow(/private network/);
    await expect(sendSmtp({ host: "10.0.0.5", port: "25", security: "none", from: "a@b.co" }, null, false)).rejects.toThrow(/private network/);
    const guarded = makeIntegrations(false);
    const ws = new ObjectId();
    const c = await guarded.create({ workspaceId: ws, userId, app: "postgres", label: "pg", values: pgCfg() });
    expect(await guarded.test(ws, c._id.toHexString())).toMatchObject({ status: "error", lastError: expect.stringMatching(/private network/) });
  });
});

describe("HTTP redirects", () => {
  let a: Server;
  let b: Server;
  const seen: Array<string | undefined> = [];
  beforeAll(async () => {
    b = createServer((req, res) => {
      seen.push(req.headers.authorization ?? req.headers["x-api-key"]?.toString());
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const bPort = (b.address() as AddressInfo).port;
    a = createServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${bPort}/landing` }).end());
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    a?.close();
    b?.close();
  });

  it("drops credentials when a redirect changes origin", async () => {
    const http = createHttpClient({ allowPrivateNetwork: true });
    const aPort = (a.address() as AddressInfo).port;
    await http({ method: "GET", url: `http://127.0.0.1:${aPort}/`, headers: { authorization: "Bearer x", "x-api-key": "k" }, sensitiveHeaders: ["x-api-key"], timeoutMs: 3000 });
    expect(seen).toEqual([undefined]);
  });
});

describe("Telegram polling mode", () => {
  it("defaults to polling on localhost and webhooks on a public address", () => {
    expect(telegramModeFromEnv({} as NodeJS.ProcessEnv)).toBe("polling");
    expect(telegramModeFromEnv({ PUBLIC_URL: "http://127.0.0.1:3000" } as NodeJS.ProcessEnv)).toBe("polling");
    expect(telegramModeFromEnv({ PUBLIC_URL: "https://abc.trycloudflare.com" } as NodeJS.ProcessEnv)).toBe("webhook");
    expect(telegramModeFromEnv({ PUBLIC_URL: "https://abc.trycloudflare.com", TELEGRAM_MODE: "polling" } as NodeJS.ProcessEnv)).toBe("polling");
  });

  it("picks up a message without a webhook, runs the workflow once, and replies", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "telegram", { botToken: FAKE.telegramToken });
    // A webhook left over from webhook mode blocks polling; publishing removes it.
    fake.state.telegramWebhooks[FAKE.telegramToken] = { url: "https://old.example.com/hook" };
    fake.state.telegramUpdates.push({ update_id: 1, message: { message_id: 1, text: "old message", chat: { id: 9 } } });
    const triggers = createTriggerService(db, client, {
      telegram: { urlFor: (p) => p, register: (w, c) => integ.telegram.deleteWebhook(w, c, true), unregister: async () => {} },
    });
    const g = graph([
      { id: "tg", type: "trigger.telegram", parameters: { credential: id }, to: { main: ["reply"] } },
      { id: "reply", type: "app.telegram.send", parameters: { credential: id, chatId: "${['$input']['message']['chat']['id']}", text: "You said: ${['$input']['message']['text']}" } },
    ]);
    const wf = new ObjectId();
    await db.collection("workflows").insertOne({ _id: wf, workspaceId: ws, name: "echo bot", revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
    await triggers.publish(ws, wf, userId);
    expect(fake.state.telegramWebhooks[FAKE.telegramToken]).toBeUndefined();
    expect(fake.state.telegramUpdates).toEqual([]); // the old message was skipped

    const poller = startTelegramPoller(db, integ, rt, { timeoutSec: 0, idleMs: 50, errorBackoffMs: 50 });
    const worker = rt.startWorker({ pollMs: 50 });
    try {
      fake.state.telegramUpdates.push({
        update_id: 501,
        message: { message_id: 7, date: 1767258000, text: "hello bot", chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "Ana" } },
      });
      const deadline = Date.now() + 15_000;
      let done: { status: string; mode: string } | null = null;
      while (Date.now() < deadline) {
        done = await rt.collections.executions.findOne({ workflowId: wf, status: { $in: ["success", "failed"] } });
        if (done) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(done?.status).toBe("success");
      expect(done?.mode).toBe("production");
      const sent = fake.calls.filter((c) => c.path.endsWith("/sendMessage"));
      expect(sent.map((c) => c.body)).toEqual([{ chat_id: "4242", text: "You said: hello bot" }]);
      // A few more polls: the same message must not start a second run.
      await new Promise((r) => setTimeout(r, 1500));
      expect(await rt.collections.executions.countDocuments({ workflowId: wf })).toBe(1);
      expect((await triggers.activeTriggers(wf))[0]?.pollOffset).toBe(502);
      const polls = fake.calls.filter((c) => c.path.endsWith("/getUpdates"));
      expect(polls.at(-1)?.body).toMatchObject({ offset: 502 });
    } finally {
      await poller.stop();
      await worker.stop();
    }
  }, 30_000);
});

describe("Chat trigger publishing", () => {
  it("publishes a chat link, refuses the same link in another workflow, and removes it on unpublish", async () => {
    const ws = new ObjectId();
    const triggers = createTriggerService(db, client);
    const path = `chat-${Date.now()}`;
    const g = graph([
      { id: "chat", type: "trigger.chat", parameters: { path }, to: { main: ["set"] } },
      { id: "set", type: "core.set", parameters: { assignments: [{ id: "a", name: "reply", value: "hi", type: "string" }] } },
    ]);
    const [a, b] = [new ObjectId(), new ObjectId()];
    for (const _id of [a, b]) {
      await db.collection("workflows").insertOne({ _id, workspaceId: ws, name: `chat ${_id}`, revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
    }
    const pub = await triggers.publish(ws, a, userId);
    expect(pub.triggers).toMatchObject([{ kind: "chat", nodeId: "chat", path }]);
    expect((await triggers.findChat(path))?.workflowId).toEqual(a);
    await expect(triggers.publish(ws, b, userId)).rejects.toThrow(/already uses this chat link/);
    // Publishing again (a new version) keeps the same link.
    await triggers.publish(ws, a, userId);
    expect((await triggers.findChat(path))?.workflowId).toEqual(a);
    await triggers.unpublish(ws, a);
    expect(await triggers.findChat(path)).toBeNull();
  });
});

describe("Google Drive", () => {
  it("saves text and a CSV-as-Sheet, finds them by name, reads them back, and explains failures", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });

    const saved = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["note", "sheet"] } },
      { id: "note", type: "app.drive.save", parameters: { credential: id, fileName: "note.txt", content: "Hello ${['$input']['email']}\nline 2", fileType: "text" } },
      { id: "sheet", type: "app.drive.save", parameters: { credential: id, fileName: "leads", content: "Name,Email\nAna,ana@example.com", fileType: "csv", convert: "sheet" } },
    ]);
    expect(saved.done.status).toBe("success");
    const note = saved.output("note")![0] as { id: string; mimeType: string; link: string };
    expect(note).toMatchObject({ name: "note.txt", mimeType: "text/plain" });
    expect(note.link).toBe(`https://drive.google.com/file/d/${note.id}/view`);
    expect(saved.output("sheet")![0]).toMatchObject({ name: "leads", mimeType: "application/vnd.google-apps.spreadsheet" });
    expect(fake.state.driveFiles.find((f) => f.id === note.id)?.content).toBe("Hello ana@example.com\nline 2");

    const sheetId = (saved.output("sheet")![0] as { id: string }).id;
    const found = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["find"] } },
      { id: "find", type: "app.drive.find", parameters: { credential: id, nameContains: "note", limit: 5 } },
    ]);
    expect(found.output("find")!.map((f) => (f as { name: string }).name)).toEqual(["note.txt"]);
    const q = new URL(`http://x${fake.calls.find((c) => c.path.startsWith("/drive/v3/files?"))!.path}`).searchParams.get("q");
    expect(q).toBe("trashed = false and name contains 'note'");

    const read = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["a", "b"] } },
      { id: "a", type: "app.drive.read", parameters: { credential: id, file: `https://drive.google.com/file/d/${note.id}/view` } },
      { id: "b", type: "app.drive.read", parameters: { credential: id, file: sheetId } },
    ]);
    expect(read.output("a")![0]).toMatchObject({ name: "note.txt", content: "Hello ana@example.com\nline 2" });
    expect(read.output("b")![0]).toMatchObject({ name: "leads", content: "Name,Email\nAna,ana@example.com" });
    expect(fake.calls.some((c) => c.path.includes(`/files/${sheetId}/export?mimeType=text%2Fcsv`) || c.path.includes(`/files/${sheetId}/export?mimeType=text/csv`))).toBe(true);

    const missing = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["r"] } },
      { id: "r", type: "app.drive.read", parameters: { credential: id, file: "1MissingFileId_abcdef" } },
    ]);
    expect(missing.done.error?.message).toMatch(/file not found\. Conduit can only see files it created/);
    const badType = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["s"] } },
      { id: "s", type: "app.drive.save", parameters: { credential: id, fileName: "x", content: "{}", fileType: "json", convert: "sheet" } },
    ]);
    expect(badType.done.error?.message).toBe("Only CSV content can be saved as a Google Sheet");
    const badFolder = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["s"] } },
      { id: "s", type: "app.drive.save", parameters: { credential: id, fileName: "x", content: "x", folder: "not a folder!" } },
    ]);
    expect(badFolder.done.error?.message).toBe("Folder: paste a Google Drive link or ID");
  });
});

describe("Telegram polling, bad updates", () => {
  it("skips an update that keeps failing instead of blocking the bot", async () => {
    // Earlier tests leave bots live; one poller per bot, like in real life.
    await db.collection("triggers").deleteMany({ kind: "telegram" });
    const ws = new ObjectId();
    const id = await cred(ws, "telegram", { botToken: FAKE.telegramToken });
    const wf = new ObjectId();
    const g = graph([{ id: "tg", type: "trigger.telegram", parameters: { credential: id } }]);
    await db.collection("workflows").insertOne({ _id: wf, workspaceId: ws, name: "bad", revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
    const triggers = createTriggerService(db, client, {
      telegram: { urlFor: (p) => p, register: (w, c) => integ.telegram.deleteWebhook(w, c, true), unregister: async () => {} },
    });
    await triggers.publish(ws, wf, userId);
    fake.state.telegramUpdates.push({ update_id: 900, message: { message_id: 1, text: "boom", chat: { id: 1 } } });
    fake.state.telegramUpdates.push({ update_id: 901, message: { message_id: 2, text: "fine", chat: { id: 1 } } });
    const started: string[] = [];
    const flaky = {
      async createExecution(input: { triggerItems: Array<{ json: Record<string, unknown> }> }) {
        const text = (input.triggerItems[0]!.json.message as { text: string }).text;
        if (text === "boom") throw new Error("database hiccup");
        started.push(text);
        return new ObjectId();
      },
    } as unknown as Pick<Runtime, "createExecution">;
    const poller = startTelegramPoller(db, integ, flaky, { timeoutSec: 0, idleMs: 20, errorBackoffMs: 20 });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !started.includes("fine")) await new Promise((r) => setTimeout(r, 50));
      expect(started).toEqual(["fine"]);
      expect((await triggers.activeTriggers(wf))[0]?.pollOffset).toBe(902);
    } finally {
      await poller.stop();
      await triggers.unpublish(ws, wf);
    }
  }, 20_000);
});
