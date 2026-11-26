import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import type { LlmRequest, LlmResult, LlmService } from "@conduit/engine";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { createHmac, randomBytes } from "node:crypto";
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
import { createVariables } from "./variables";
import { createWhatsappReceiver, whatsappMessages } from "./whatsapp";

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
      { value: "Team", label: "Team" },
      { value: "Tasks", label: "Tasks" },
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

describe("more apps", () => {
  it("account checks show who you're connected as, and reject bad keys", async () => {
    const ok: Array<[string, Record<string, string>, string | null]> = [
      ["notion", { token: FAKE.notionToken }, "Conduit"],
      ["airtable", { token: FAKE.airtableToken }, "tester@example.com"],
      ["discord", { webhookUrl: `https://discord.com/api/webhooks/${FAKE.discordWebhook}` }, 'webhook "Conduit alerts"'],
      ["github", { token: FAKE.githubToken }, "@conduit-tester"],
      ["trello", { apiKey: FAKE.trelloKey, token: FAKE.trelloToken }, "@conduittester"],
      ["todoist", { token: FAKE.todoistToken }, "tester@example.com"],
      ["mailchimp", { apiKey: FAKE.mailchimpKey }, "Acme"],
      ["ntfy", { server: "https://ntfy.sh" }, "ntfy.sh"],
    ];
    for (const [app, values, who] of ok) expect(await integ.check(app, values), app).toBe(who);
    await expect(integ.check("notion", { token: "nope" })).rejects.toThrow("Notion: API token is invalid.");
    await expect(integ.check("github", { token: "nope" })).rejects.toThrow("GitHub: Bad credentials");
    await expect(integ.check("mailchimp", { apiKey: "no-datacenter" })).rejects.toThrow(/end with a data center/);
    await expect(integ.check("discord", { webhookUrl: "https://example.com/hook" })).rejects.toThrow(/isn't a webhook URL/);
    expect(integ.availableApps()).toEqual(expect.arrayContaining(["notion", "airtable", "discord", "github", "trello", "todoist", "mailchimp", "ntfy"]));
  });

  it("Notion: matches columns by name and type, then reads pages back as plain values", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "notion", { token: FAKE.notionToken });
    const dbLink = `https://www.notion.so/acme/${FAKE.notionDatabase}?v=1`;
    const add = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      {
        id: "add",
        type: "app.notion.addPage",
        parameters: {
          credential: id,
          database: dbLink,
          columns: [
            { key: "name", value: "Ana" },
            { key: "Email", value: "${['$input']['email']}" },
            { key: "Score", value: "42" },
            { key: "Tags", value: "vip, beta" },
            { key: "VIP", value: "yes" },
          ],
          content: "First paragraph\n\nSecond one",
        },
      },
    ]);
    expect(add.done.status).toBe("success");
    const page = fake.state.notionPages[0]!;
    expect(page.properties).toMatchObject({
      Name: { type: "title" },
      Email: { email: "ana@example.com" },
      Score: { number: 42 },
      Tags: { multi_select: [{ name: "vip" }, { name: "beta" }] },
      VIP: { checkbox: true },
    });
    expect(page.children).toHaveLength(2);

    const read = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["q"] } },
      { id: "q", type: "app.notion.query", parameters: { credential: id, database: FAKE.notionDatabase } },
    ]);
    expect(read.output("q")).toEqual([expect.objectContaining({ Name: "Ana", Email: "ana@example.com", Score: 42, Tags: ["vip", "beta"], VIP: true })]);

    const bad = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      { id: "add", type: "app.notion.addPage", parameters: { credential: id, database: FAKE.notionDatabase, columns: [{ key: "Score", value: "lots" }] } },
    ]);
    expect(bad.done.error?.message).toBe('Notion: "Score" needs a number');
    const people = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      { id: "add", type: "app.notion.addPage", parameters: { credential: id, database: FAKE.notionDatabase, columns: [{ key: "Owner", value: "Ana" }] } },
    ]);
    expect(people.done.error?.message).toMatch(/"Owner" column is a people column/);
    const notShared = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["add"] } },
      { id: "add", type: "app.notion.addPage", parameters: { credential: id, database: "f".repeat(32), columns: [{ key: "Name", value: "x" }] } },
    ]);
    expect(notShared.done.error?.message).toMatch(/share the database with your integration/);
  });

  it("Airtable: adds with typecast and lists with a filter", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "airtable", { token: FAKE.airtableToken });
    const base = `https://airtable.com/${FAKE.airtableBase}/tblX/viwY`;
    for (const [name, status] of [
      ["Ana", "Open"],
      ["Ben", "Closed"],
    ]) {
      const r = await run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["add"] } },
        { id: "add", type: "app.airtable.add", parameters: { credential: id, base, table: "Leads", fields: [{ key: "Name", value: name }, { key: "Status", value: status }] } },
      ]);
      expect(r.done.status).toBe("success");
    }
    const post = fake.calls.find((c) => c.host === "api.airtable.com" && c.method === "POST");
    expect(post?.body).toMatchObject({ typecast: true, records: [{ fields: { Name: "Ana", Status: "Open" } }] });
    const list = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["l"] } },
      { id: "l", type: "app.airtable.list", parameters: { credential: id, base: FAKE.airtableBase, table: "Leads", filter: "{Status} = 'Open'" } },
    ]);
    expect(list.output("l")!.map((r) => (r as { Name: string }).Name)).toEqual(["Ana"]);
    const missing = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["l"] } },
      { id: "l", type: "app.airtable.list", parameters: { credential: id, base: FAKE.airtableBase, table: "Nope" } },
    ]);
    expect(missing.done.error?.message).toBe("Airtable: Could not find table Nope (check the base ID and table name)");
  });

  it("Discord, GitHub, Trello and Todoist send what you'd expect", async () => {
    const ws = new ObjectId();
    const discord = await cred(ws, "discord", { webhookUrl: `https://discord.com/api/webhooks/${FAKE.discordWebhook}` });
    const github = await cred(ws, "github", { token: FAKE.githubToken });
    const trello = await cred(ws, "trello", { apiKey: FAKE.trelloKey, token: FAKE.trelloToken });
    const todoist = await cred(ws, "todoist", { token: FAKE.todoistToken });
    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["d", "g", "tr", "td"] } },
      { id: "d", type: "app.discord.send", parameters: { credential: discord, content: "New lead @everyone: ${['$input']['email']}", username: "Conduit" } },
      { id: "g", type: "app.github.issue", parameters: { credential: github, repo: "https://github.com/acme/site", title: "Form error", body: "From ${['$input']['email']}", labels: "bug, from-form" } },
      { id: "tr", type: "app.trello.card", parameters: { credential: trello, list: FAKE.trelloList, name: "Call ${['$input']['email']}", due: "2026-01-15T17:00:00Z" } },
      { id: "td", type: "app.todoist.task", parameters: { credential: todoist, content: "Follow up", due: "tomorrow 5pm", priority: "4", labels: "work" } },
    ]);
    expect(r.done.status).toBe("success");
    expect(fake.state.discordMessages[0]).toEqual({ content: "New lead @everyone: ana@example.com", username: "Conduit", allowed_mentions: { parse: [] } });
    expect(r.output("g")).toEqual([{ number: 1, url: "https://github.com/acme/site/issues/1", id: 3000000001 }]);
    expect(fake.state.githubIssues[0]).toEqual({ title: "Form error", body: "From ana@example.com", labels: ["bug", "from-form"] });
    expect(fake.state.trelloCards[0]).toMatchObject({ idList: FAKE.trelloList, name: "Call ana@example.com", due: "2026-01-15T17:00:00Z" });
    expect(r.output("tr")).toEqual([{ id: "600000000000000000000000", url: "https://trello.com/c/AbCd1234" }]);
    expect(fake.state.todoistTasks[0]).toEqual({ content: "Follow up", priority: 4, due_string: "tomorrow 5pm", labels: ["work"] });
    expect(r.output("td")![0]).toMatchObject({ id: "6Jf8VQXxpwv56VQ7", due: "2026-01-02" });

    const errs = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["g"] } },
      { id: "g", type: "app.github.issue", parameters: { credential: github, repo: "acme/private", title: "x" } },
    ]);
    expect(errs.done.error?.message).toBe("GitHub: Not Found (check the repository name, and that the token can see it)");
    const list = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["tr"] } },
      { id: "tr", type: "app.trello.card", parameters: { credential: trello, list: "not-a-list", name: "x" } },
    ]);
    expect(list.done.error?.message).toMatch(/the list ID is 24 letters and numbers/);
  });

  it("Mailchimp upserts by email and adds tags; ntfy sends and explains locked topics", async () => {
    const ws = new ObjectId();
    const mc = await cred(ws, "mailchimp", { apiKey: FAKE.mailchimpKey });
    const nt = await cred(ws, "ntfy", { server: "https://ntfy.sh" });
    const sub = (email: string) =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["m"] } },
        { id: "m", type: "app.mailchimp.subscribe", parameters: { credential: mc, audience: FAKE.mailchimpList, email, status: "pending", mergeFields: [{ key: "fname", value: "Ana" }], tags: "website" } },
      ]);
    const first = await sub("Ana@Example.com");
    expect(first.output("m")).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{32}$/), email: "ana@example.com", status: "pending" }]);
    await sub("ana@example.com");
    expect(fake.state.mailchimpMembers).toHaveLength(1);
    expect(fake.state.mailchimpMembers[0]).toMatchObject({ merge: { FNAME: "Ana" }, tags: ["website"] });
    expect((await sub("not-an-email")).done.error?.message).toMatch(/isn't a valid email address/);

    const sent = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["n"] } },
      { id: "n", type: "app.ntfy.send", parameters: { credential: nt, topic: "my-alerts", title: "New lead", message: "${['$input']['email']}", priority: "4", tags: "tada", click: "https://acme.test" } },
    ]);
    expect(sent.done.status).toBe("success");
    expect(fake.state.ntfyMessages[0]).toEqual({ topic: "my-alerts", message: "ana@example.com", title: "New lead", priority: 4, tags: ["tada"], click: "https://acme.test" });
    const locked = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["n"] } },
      { id: "n", type: "app.ntfy.send", parameters: { credential: nt, topic: "locked-alerts", message: "x" } },
    ]);
    expect(locked.done.error?.message).toBe("ntfy: forbidden (the token can't write to this topic)");
  });

  it("RSS: reads RSS and Atom feeds, and says when a URL isn't a feed", async () => {
    const ws = new ObjectId();
    const rss = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["r"] } },
      { id: "r", type: "app.rss.read", parameters: { url: "https://feeds.test/rss.xml", limit: 5 } },
    ]);
    expect(rss.output("r")).toEqual([
      { title: "Hello <world>", link: "https://acme.test/hello", id: "post-1", published: "2026-01-01T09:00:00.000Z", summary: "First & best", author: "Ana", feed: "Acme & Co blog" },
      { title: "Second", link: "https://acme.test/second", id: "https://acme.test/second", published: "not a date", summary: null, author: null, feed: "Acme & Co blog" },
    ]);
    const atom = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["r"] } },
      { id: "r", type: "app.rss.read", parameters: { url: "https://feeds.test/atom.xml" } },
    ]);
    expect(atom.output("r")).toEqual([
      { title: "Atom post", link: "https://acme.test/atom-post", id: "urn:1", published: "2026-01-02T10:00:00.000Z", summary: "Short – sweet", author: "Ben", feed: "Atom news" },
    ]);
    const html = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["r"] } },
      { id: "r", type: "app.rss.read", parameters: { url: "https://feeds.test/page.html" } },
    ]);
    expect(html.done.error?.message).toBe("RSS: that URL didn't return an RSS or Atom feed");
  });
});

describe("Only new items", () => {
  async function liveRun(workspaceId: ObjectId, workflowId: ObjectId, nodes: N[], items: Array<Record<string, unknown>>, mode: "production" | "test" = "production") {
    const g = graph(nodes);
    const id = await rt.createExecution(
      { workspaceId, workflowId, workflowName: "feed", versionId: null, mode, graph: g, triggerNodeId: nodes[0]!.id, triggerItems: items.map((json) => ({ json })) },
      false,
    );
    await rt.processExecution(id);
    const step = await rt.collections.steps.findOne({ executionId: id, nodeId: "new" });
    return (step?.output.main ?? []).map((i) => (i.json as { link: string }).link);
  }

  it("remembers what it let through, skips the first live run by default, and test runs don't remember", async () => {
    const ws = new ObjectId();
    const wf = new ObjectId();
    const nodes: N[] = [
      { id: "t", type: "trigger.manual", to: { main: ["new"] } },
      { id: "new", type: "flow.onlyNew", parameters: { key: "${['$input']['link']}" } },
    ];
    const posts = (...ids: number[]) => ids.map((n) => ({ link: `https://blog.test/${n}` }));

    // A test run before going live shows everything that would count as new, and remembers nothing.
    expect(await liveRun(ws, wf, nodes, posts(1, 2), "test")).toEqual(["https://blog.test/1", "https://blog.test/2"]);
    // First live run: just learn what's already in the feed.
    expect(await liveRun(ws, wf, nodes, posts(1, 2))).toEqual([]);
    // Next run: only the new post, and a duplicate inside one run counts once.
    expect(await liveRun(ws, wf, nodes, [...posts(1, 2, 3), ...posts(3)])).toEqual(["https://blog.test/3"]);
    expect(await liveRun(ws, wf, nodes, posts(1, 2, 3))).toEqual([]);
    // Another workflow has its own memory.
    expect(await liveRun(ws, new ObjectId(), [nodes[0]!, { ...nodes[1]!, parameters: { ...nodes[1]!.parameters, firstRun: "pass" } }], posts(1))).toEqual(["https://blog.test/1"]);
    // An empty key is an error, not a silent drop.
    const g = graph([nodes[0]!, { id: "new", type: "flow.onlyNew", parameters: { key: "${['$input']['missing']}" } }]);
    const id = await rt.createExecution({ workspaceId: ws, workflowId: wf, workflowName: "feed", versionId: null, mode: "production", graph: g, triggerNodeId: "t", triggerItems: [{ json: {} }] }, false);
    expect((await rt.processExecution(id)).error?.message).toMatch(/Item 1 has an empty key/);
  });
});

describe("WhatsApp incoming messages", () => {
  const appSecret = "fake-app-secret-123";
  const sign = (body: string) => `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  const payload = (messages: unknown[], statuses: unknown[] = []) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550001111", phone_number_id: FAKE.whatsappPhoneId },
                contacts: [{ wa_id: "6281234567890", profile: { name: "Ana" } }],
                messages,
                statuses,
              },
            },
          ],
        },
      ],
    });

  it("verifies the callback, checks signatures, ignores receipts and repeats, and replies", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "whatsapp", { phoneNumberId: FAKE.whatsappPhoneId, accessToken: FAKE.whatsappToken, appSecret, verifyToken: "my-verify-token" });
    const plain = await cred(ws, "whatsapp", { phoneNumberId: FAKE.whatsappPhoneId, accessToken: FAKE.whatsappToken });
    const receiver = createWhatsappReceiver(db, integ, rt);

    // Meta's handshake
    const q = (token: string) => new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "12345" });
    expect(await receiver.verify(id, q("my-verify-token"))).toBe("12345");
    expect(await receiver.verify(id, q("wrong"))).toBeNull();
    expect(await receiver.verify(plain, q(""))).toBeNull();
    expect(await receiver.verify("not-an-id", q("my-verify-token"))).toBeNull();

    const check = async (w: ObjectId, c: string) => {
      const { values } = await integ.resolve(w, c, "whatsapp");
      if (!values.appSecret || !values.verifyToken) throw new Error("add the app secret and a verify token");
    };
    const triggers = createTriggerService(db, client, { whatsapp: { check } });
    const g = (credential: string) =>
      graph([
        { id: "wa", type: "trigger.whatsapp", parameters: { credential }, to: { main: ["reply"] } },
        { id: "reply", type: "app.whatsapp.send", parameters: { credential, to: "${['wa']['from']}", text: "Hi ${['wa']['name']}, you said: ${['wa']['text']}" } },
      ]);
    const wf = new ObjectId();
    const wf2 = new ObjectId();
    const wf3 = new ObjectId();
    await db.collection("workflows").insertMany([
      { _id: wf, workspaceId: ws, name: "wa bot", revision: 1, draft: g(id), publishedVersionId: null, archivedAt: null },
      { _id: wf2, workspaceId: ws, name: "second", revision: 1, draft: g(id), publishedVersionId: null, archivedAt: null },
      { _id: wf3, workspaceId: ws, name: "no secret", revision: 1, draft: g(plain), publishedVersionId: null, archivedAt: null },
    ]);
    await expect(triggers.publish(ws, wf3, userId)).rejects.toThrow(/app secret/);
    const pub = await triggers.publish(ws, wf, userId);
    expect(pub.triggers).toMatchObject([{ kind: "whatsapp", nodeId: "wa" }]);
    await expect(triggers.publish(ws, wf2, userId)).rejects.toThrow(/already starts the live workflow "wa bot"/);

    const msg = { from: "6281234567890", id: "wamid.ONE", timestamp: "1767258000", type: "text", text: { body: "are you open?" } };
    const body = payload([msg]);
    expect(await receiver.receive(id, body, null)).toEqual({ status: 401 });
    expect(await receiver.receive(id, body, sign(body + " "))).toEqual({ status: 401 });
    expect(await receiver.receive(id, body, sign(body))).toEqual({ status: 200, started: 1 });
    // Meta retries: the same message id doesn't start a second run.
    expect(await receiver.receive(id, body, sign(body))).toEqual({ status: 200, started: 0 });
    // Delivery receipts only: nothing to do.
    const receipts = payload([], [{ id: "wamid.X", status: "delivered", recipient_id: "6281234567890" }]);
    expect(await receiver.receive(id, receipts, sign(receipts))).toEqual({ status: 200, started: 0 });

    const exec = await rt.collections.executions.findOne({ workflowId: wf });
    expect(exec?.mode).toBe("production");
    await rt.processExecution(exec!._id);
    const steps = await rt.collections.steps.find({ executionId: exec!._id }).toArray();
    expect(steps.find((s) => s.nodeId === "wa")?.output.main?.[0]?.json).toMatchObject({ from: "6281234567890", name: "Ana", text: "are you open?", type: "text" });
    expect(steps.find((s) => s.nodeId === "reply")?.status).toBe("success");
    const sent = fake.calls.filter((c) => c.host === "graph.facebook.com" && c.method === "POST");
    expect(sent.map((c) => c.body)).toMatchObject([{ to: "6281234567890", text: { body: "Hi Ana, you said: are you open?" } }]);

    // Unpublished: messages are accepted but start nothing.
    await triggers.unpublish(ws, wf);
    const later = payload([{ ...msg, id: "wamid.TWO" }]);
    expect(await receiver.receive(id, later, sign(later))).toEqual({ status: 200, started: 0 });
  });

  it("reads buttons, list picks, captions and locations as text", () => {
    const items = whatsappMessages(
      JSON.parse(
        payload([
          { from: "1", id: "a", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes please" } } },
          { from: "1", id: "b", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "m", title: "Medium" } } },
          { from: "1", id: "c", type: "image", image: { id: "MEDIA1", caption: "my receipt" } },
          { from: "1", id: "d", type: "location", location: { name: "Cafe", address: "Main St 1" } },
          { from: "1", id: "e", type: "button", button: { text: "Stop" } },
        ]),
      ),
    );
    expect(items.map((i) => i.text)).toEqual(["Yes please", "Medium", "my receipt", "Cafe, Main St 1", "Stop"]);
    expect(items[2]!.mediaId).toBe("MEDIA1");
    expect(whatsappMessages({ nonsense: true })).toEqual([]);
  });
});

describe("workspace variables", () => {
  it("fill in ${['$vars'][...]} in any step, hide secret values in run logs, and stay per workspace", async () => {
    const ws = new ObjectId();
    const vars = createVariables(db, integ.vault);
    await vars.create(ws, userId, { name: "GREETING", value: "Hello", secret: false });
    const token = await vars.create(ws, userId, { name: "API_TOKEN", value: "tok_super_secret_42", secret: true });
    expect(token.value).toBeNull();
    await expect(vars.create(ws, userId, { name: "GREETING", value: "x", secret: false })).rejects.toThrow(/already a variable/);
    await expect(vars.create(ws, userId, { name: "bad name", value: "x", secret: false })).rejects.toThrow(/letters, numbers/);
    await vars.create(new ObjectId(), userId, { name: "GREETING", value: "Other workspace", secret: false });

    const r = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["set"] } },
      {
        id: "set",
        type: "core.set",
        parameters: {
          assignments: [
            { id: "a", name: "text", value: "${['$vars']['GREETING']} ${['$input']['email']}", type: "string" },
            { id: "b", name: "auth", value: "Bearer ${['$vars']['API_TOKEN']}", type: "string" },
          ],
        },
      },
    ]);
    expect(r.done.status).toBe("success");
    expect(r.output("set")?.[0]).toMatchObject({ text: "Hello ana@example.com", auth: "Bearer [hidden]" });
    expect(JSON.stringify(r.steps)).not.toContain("tok_super_secret_42");

    await vars.update(ws, userId, token.id, { value: "tok_rotated_99" });
    const loaded = await vars.load(ws);
    expect(loaded.vars).toEqual({ GREETING: "Hello", API_TOKEN: "tok_rotated_99" });
    expect(loaded.secrets).toEqual(["tok_rotated_99"]);
    expect((await vars.list(ws)).map((v) => [v.name, v.value])).toEqual([
      ["API_TOKEN", null],
      ["GREETING", "Hello"],
    ]);
  });
});

describe("WhatsApp retries", () => {
  it("if starting the run fails, Meta's retry of the same message still gets through", async () => {
    const ws = new ObjectId();
    const appSecret = "retry-secret";
    const id = await cred(ws, "whatsapp", { phoneNumberId: FAKE.whatsappPhoneId, accessToken: FAKE.whatsappToken, appSecret, verifyToken: "v" });
    const wf = new ObjectId();
    const g = graph([{ id: "wa", type: "trigger.whatsapp", parameters: { credential: id } }]);
    await db.collection("workflows").insertOne({ _id: wf, workspaceId: ws, name: "retry", revision: 1, draft: g, publishedVersionId: null, archivedAt: null });
    await createTriggerService(db, client, {}).publish(ws, wf, userId);

    let fail = true;
    const flaky = {
      createExecution: async (input: Parameters<Runtime["createExecution"]>[0], enqueue: boolean) => {
        if (fail) {
          fail = false;
          throw new Error("database hiccup");
        }
        return rt.createExecution(input, enqueue);
      },
    };
    const receiver = createWhatsappReceiver(db, integ, flaky);
    const body = JSON.stringify({
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: FAKE.whatsappPhoneId }, messages: [{ from: "1", id: "wamid.RETRY", type: "text", text: { body: "hi" } }] } }] }],
    });
    const sig = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
    await expect(receiver.receive(id, body, sig)).rejects.toThrow("database hiccup");
    expect(await receiver.receive(id, body, sig)).toEqual({ status: 200, started: 1 });
    expect(await receiver.receive(id, body, sig)).toEqual({ status: 200, started: 0 });
  });
});

describe("Sheets find and update, and reading pictures", () => {
  it("finds rows, updates only the given cells, adds or refuses when nothing matches, and refuses ambiguous updates", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const sheet = { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Sheet1" };
    const rows = () => fake.state.sheets[FAKE.spreadsheetId]!.Sheet1!;
    const one = async (type: string, parameters: Record<string, unknown>) =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["s"] } },
        { id: "s", type, parameters: { ...sheet, ...parameters } },
      ]);

    const found = await one("app.sheets.find", { column: "email", value: "EXAMPLE.com", match: "contains" });
    expect(found.output("s")).toEqual([
      { found: true, row: 2, Name: "Ana", Email: "ana@example.com", Plan: "pro" },
      { found: true, row: 3, Name: "Ben", Email: "ben@example.com", Plan: "free" },
    ]);
    expect((await one("app.sheets.find", { column: "Name", value: "  ben " })).output("s")).toEqual([{ found: true, row: 3, Name: "Ben", Email: "ben@example.com", Plan: "free" }]);
    expect((await one("app.sheets.find", { column: "Name", value: "Zed" })).output("s")).toEqual([{ found: false, row: null }]);
    const badCol = await one("app.sheets.find", { column: "Phone", value: "1" });
    expect(badCol.done.error?.message).toMatch(/No column named "Phone". The sheet has: Name, Email, Plan/);

    const upd = await one("app.sheets.update", { findBy: "value", column: "Name", value: "ben", match: "equals", columns: [{ key: "plan", value: "pro" }] });
    expect(upd.output("s")?.[0]).toEqual({ action: "updated", changed: { Plan: { from: "free", to: "pro" } }, row: 3, Name: "Ben", Email: "ben@example.com", Plan: "pro" });
    expect(rows()[2]).toEqual(["Ben", "ben@example.com", "pro"]);
    expect(rows()[1]).toEqual(["Ana", "ana@example.com", "pro"]);

    const byRow = await one("app.sheets.update", { findBy: "row", rowNumber: "2", columns: [{ key: "Email", value: "ana@new.example" }] });
    expect(byRow.output("s")?.[0]).toMatchObject({ action: "updated", row: 2, Email: "ana@new.example" });
    expect(rows()[1]).toEqual(["Ana", "ana@new.example", "pro"]);

    const missing = await one("app.sheets.update", { findBy: "value", column: "Name", value: "Dee", columns: [{ key: "Plan", value: "free" }], ifMissing: "fail" });
    expect(missing.done.error?.message).toMatch(/No row where Name is "Dee"/);
    expect((await one("app.sheets.update", { findBy: "value", column: "Name", value: "Dee", columns: [{ key: "Plan", value: "free" }], ifMissing: "skip" })).output("s")).toEqual([{ action: "not_found", row: null }]);
    const added = await one("app.sheets.update", { findBy: "value", column: "Name", value: "Dee", columns: [{ key: "Plan", value: "free" }], ifMissing: "add" });
    expect(added.output("s")?.[0]).toMatchObject({ action: "added", Name: "Dee", Plan: "free", row: 4 });
    expect(rows()[3]).toEqual(["Dee", "", "free"]);

    rows().push(["Ana", "ana2@example.com", "free"]);
    const many = await one("app.sheets.update", { findBy: "value", column: "Name", value: "Ana", columns: [{ key: "Plan", value: "x" }], ifMany: "fail" });
    expect(many.done.error?.message).toMatch(/2 rows match "Ana" \(rows 2, 5\)/);
    expect(rows()[1]![2]).toBe("pro");
  });

  it("hands a stored WhatsApp photo to the model, and only from this workspace", async () => {
    const ws = new ObjectId();
    const { insertedId } = await db.collection("media_files").insertOne({ workspaceId: ws, mimetype: "image/jpeg", fileName: null, size: 4, data: Buffer.from("JPEG"), createdAt: new Date() });
    llmRequests.length = 0;
    llmScript = [{ content: [{ type: "text", text: '{"customer":"Mehta","amount":"4500"}' }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }];
    const extract = (workspaceId: ObjectId) =>
      run(workspaceId, [
        { id: "t", type: "trigger.manual", to: { main: ["x"] } },
        {
          id: "x",
          type: "ai.extract",
          parameters: {
            text: "",
            image: insertedId.toHexString(),
            fields: [
              { id: "a", name: "customer", value: "Customer name", type: "string" },
              { id: "b", name: "amount", value: "Amount", type: "string" },
            ],
          },
        },
      ]);
    const r = await extract(ws);
    expect(r.done.status).toBe("success");
    expect(r.output("x")?.[0]).toMatchObject({ ai: { customer: "Mehta", amount: "4500" } });
    const sent = llmRequests.at(-1)!.messages[0]!.content;
    expect(sent[0]).toEqual({ type: "image", mimetype: "image/jpeg", base64: Buffer.from("JPEG").toString("base64") });
    expect(sent[1]).toMatchObject({ type: "text", text: expect.stringContaining("Read the attached image") });

    const elsewhere = await extract(new ObjectId());
    expect(elsewhere.done.error?.message).toMatch(/isn't stored anymore|another workspace/);
  });
});

describe("team access and owner email", () => {
  it("matches senders to the Team tab by phone digits and routes them by role and access", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const check = (from: string, allow: string, roles = "") =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["set"] } },
        { id: "set", type: "core.set", parameters: { assignments: [{ id: "a", name: "from", value: from, type: "string" }], keepOthers: false }, to: { main: ["who"] } },
        { id: "who", type: "app.team.check", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Team", phone: "${['$input']['from']}", allow, roles } },
      ]);
    const route = async (from: string, allow: string, roles = "") => {
      const r = await check(from, allow, roles);
      expect(r.done.status).toBe("success");
      const out = r.steps.find((s) => s.nodeId === "who")!.output;
      const handle = out.allowed?.length ? "allowed" : "denied";
      return { handle, person: (out[handle]![0]!.json as { person: Record<string, unknown> }).person };
    };

    // The owner: no Access value, but Owner can edit. Matched from WhatsApp's 91... form.
    expect(await route("919900011122", "known")).toMatchObject({ handle: "allowed", person: { known: true, name: "Shadab", role: "Owner", canEdit: true, isOwner: true, row: 2 } });
    // A leading 0 in the sheet doesn't matter.
    expect(await route("919812345678", "edit")).toMatchObject({ handle: "allowed", person: { name: "Ravi", canEdit: true, isOwner: false, access: "edit" } });
    expect(await route("+91 98111 12222", "edit")).toMatchObject({ handle: "denied", person: { name: "Asha", canEdit: false, access: "view" } });
    expect(await route("9811112222", "known")).toMatchObject({ handle: "allowed" });
    expect(await route("919812345678", "owner")).toMatchObject({ handle: "denied" });
    expect(await route("919812345678", "roles", "Owner, sales")).toMatchObject({ handle: "allowed" });
    // Blocked people and strangers never get through.
    expect(await route("919800000000", "known")).toMatchObject({ handle: "denied", person: { known: true, access: "blocked" } });
    expect(await route("917777777777", "known")).toMatchObject({ handle: "denied", person: { known: false, name: null } });
    expect(await route("", "known")).toMatchObject({ handle: "denied", person: { known: false } });
  });

  it("searches Gmail and reads the text, and says how to fix a missing permission", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const search = (query: string) =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["mail"] } },
        { id: "mail", type: "app.gmail.search", parameters: { credential: id, query, limit: 5 } },
      ]);
    const r = await search("from:mehta is:unread");
    expect(r.output("mail")).toEqual([
      {
        id: "m1",
        threadId: "t-m1",
        from: "Mehta <mehta@example.com>",
        to: FAKE.googleEmail,
        subject: "Quote for 50 units",
        date: new Date(1767258000000).toISOString(),
        unread: true,
        snippet: "Please send the quote by Friday.",
        body: "Please send the quote by Friday.",
      },
    ]);
    expect((await search("from:nobody")).output("mail")).toEqual([{ found: false }]);
    expect((await search("")).output("mail")).toHaveLength(2);
    fake.state.gmailCanRead = false;
    expect((await search("x")).done.error?.message).toMatch(/press Reconnect on the Google account/);
  });
});

describe("task log", () => {
  it("adds tasks, and says who's already on a customer instead of doubling up", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const add = (parameters: Record<string, unknown>) =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["task"] } },
        { id: "task", type: "app.tasks.add", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Tasks", ...parameters } },
      ]);
    const tasks = () => fake.state.sheets[FAKE.spreadsheetId]!.Tasks!;

    const clash = await add({ task: "Follow up on quote", customer: "  mehta traders ", assignee: "Asha" });
    expect(clash.output("task")?.[0]).toMatchObject({
      status: "conflict",
      message: 'Ravi is already handling mehta traders ("Send quote"), due 2026-11-28.',
      existing: { row: 2, id: "T2", assignedTo: "Ravi", status: "Open" },
    });
    expect(tasks()).toHaveLength(3);

    // A finished task doesn't block a new one.
    const fresh = await add({ task: "New order", customer: "Old Client", assignee: "Asha", assigneePhone: "9811112222", due: "2026-12-01", createdBy: "Shadab" });
    expect(fresh.output("task")?.[0]).toMatchObject({ status: "added", id: "T3", row: 4, Task: "New order", Customer: "Old Client", "Assigned to": "Asha", Status: "Open", Due: "2026-12-01", "Created by": "Shadab" });
    expect(tasks()[3]![0]).toBe("T3");

    const forced = await add({ task: "Second look", customer: "Mehta Traders", onConflict: "add" });
    expect(forced.output("task")?.[0]).toMatchObject({ status: "added", Customer: "Mehta Traders" });

    const bad = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["task"] } },
      { id: "task", type: "app.tasks.add", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Sheet1", task: "x" } },
    ]);
    expect(bad.done.error?.message).toMatch(/needs at least Task and Status columns/);
  });
});

describe("due tasks", () => {
  it("finds overdue and due-today tasks (any common date format), per person or as one report", async () => {
    const ws = new ObjectId();
    const id = await cred(ws, "google", await googleTokens(), { expiresAt: new Date(Date.now() + 3600_000) });
    const day = (offset: number, fmt: "iso" | "dmy" = "iso") => {
      const d = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      if (fmt === "iso") return d;
      const [y, m, dd] = d.split("-");
      return `${dd}/${m}/${y}`;
    };
    const tasks = fake.state.sheets[FAKE.spreadsheetId]!.Tasks!;
    tasks.splice(1, tasks.length - 1,
      ["T1", "Send quote", "Mehta Traders", "Ravi", "9812345678", "Open", day(-3), "Shadab", ""],
      ["T2", "Call back", "Gupta", "Asha", "9811112222", "In progress", day(0, "dmy"), "Shadab", ""],
      ["T3", "Deliver", "Sharma", "Ravi", "9812345678", "Open", day(5), "Shadab", ""],
      ["T4", "Old one", "Old Client", "Asha", "9811112222", "Done", day(-10), "Shadab", ""],
      ["T5", "Someday", "", "Ravi", "", "Open", "", "Shadab", ""],
    );
    const due = (parameters: Record<string, unknown>) =>
      run(ws, [
        { id: "t", type: "trigger.manual", to: { main: ["due"] } },
        { id: "due", type: "app.tasks.due", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Tasks", timezone: "UTC", ...parameters } },
      ]);

    const each = (await due({ which: "due", daysAhead: 0, output: "each" })).output("due")!;
    expect(each.map((t) => [t.id, t.overdueDays, t.when])).toEqual([
      ["T1", 3, "3 days overdue"],
      ["T2", 0, "due today"],
    ]);
    expect(each[0]).toMatchObject({ assignedTo: "Ravi", phone: "9812345678", customer: "Mehta Traders" });
    expect((await due({ which: "due", daysAhead: 7, output: "each" })).output("due")!.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    expect((await due({ which: "overdue", output: "each" })).output("due")!.map((t) => t.id)).toEqual(["T1"]);
    expect((await due({ which: "open", assignee: "ravi", output: "each" })).output("due")!.map((t) => t.id)).toEqual(["T1", "T3", "T5"]);

    const report = (await due({ which: "open", output: "summary" })).output("due")![0]!;
    expect(report).toMatchObject({ count: 4, overdue: 1, dueToday: 1, byPerson: { Ravi: 3, Asha: 1 } });
    expect(report.text).toBe(
      ["4 tasks:", "• Ravi: Send quote (Mehta Traders), 3 days overdue [T1]", "• Asha: Call back (Gupta), due today [T2]", "• Ravi: Deliver (Sharma), due in 5 days [T3]", "• Ravi: Someday, no due date [T5]"].join("\n"),
    );
    tasks.splice(1);
    expect((await due({ which: "due", output: "each" })).output("due")).toEqual([{ none: true, today: day(0) }]);
    expect((await due({ which: "due", output: "summary" })).output("due")![0]).toMatchObject({ count: 0, text: "Nothing due. All clear." });

    // A leads list: no Task column, dates like 05-12-26, Won/Lost are finished, and staff phones come from the Team tab.
    const dmy2 = (offset: number) => {
      const [y, m, dd] = day(offset).split("-");
      return `${dd}-${m}-${y!.slice(2)}`;
    };
    fake.state.sheets[FAKE.spreadsheetId]!.Enquiries = [
      ["9", "Owner Name", "Phone No.", "Enquiry Type", "Assigned To", "Status", "Next Follow-up", "Follow-up Due", "Notes"],
      ["1", "Mohan", "9800000101", "AIS", "Ravi", "Line busy", dmy2(-2), "Overdue by 2 days", "will meet on saturday"],
      ["2", "Kiran", "9800000102", "AIS", "Asha", "Lost", dmy2(-5), "Closed", ""],
      ["3", "Vikas", "9800000103", "Kent", "Nobody", "Quotation Sent", dmy2(0), "Due today", ""],
      ["4", "Anil", "9800000104", "AIS", "Asha", "Contacted", "", "No date set", ""],
    ];
    const leads = (await due({ sheet: "Enquiries", which: "due", output: "each", phonesFrom: "Team" })).output("due")!;
    expect(leads.map((t) => [t.what, t.overdueDays, t.assignedTo, t.phone])).toEqual([
      ["Mohan", 2, "Ravi", "098123 45678"],
      ["Vikas", 0, "Nobody", null],
    ]);
    expect(leads[0]).toMatchObject({ customerPhone: "9800000101", notes: "will meet on saturday", status: "Line busy" });
    // "Lost" counts as open once it's not in the finished list.
    expect((await due({ sheet: "Enquiries", which: "due", output: "each", closedStatuses: "Won" })).output("due")!.map((t) => t.what)).toEqual(["Kiran", "Mohan", "Vikas"]);
    // Columns can be named in the step.
    expect((await due({ sheet: "Enquiries", which: "open", output: "each", nameColumn: "Enquiry Type" })).output("due")!.map((t) => t.what)).toEqual(["AIS", "Kent", "AIS"]);
    expect((await due({ sheet: "Enquiries", output: "each", dueColumn: "Nope" })).done.error?.message).toMatch(/No column named "Nope"/);
    // One message per person, with all their leads.
    const people = (await due({ sheet: "Enquiries", which: "due", output: "person", phonesFrom: "Team" })).output("due")!;
    expect(people.map((x) => [x.assignedTo, x.phone, x.count, x.text])).toEqual([
      ["Ravi", "098123 45678", 1, "• Mohan, 9800000101: 2 days overdue, Line busy"],
      ["Nobody", null, 1, "• Vikas, 9800000103: due today, Quotation Sent"],
    ]);

    // An AI-filled update that leaves a column empty doesn't wipe it.
    const upd = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["u"] } },
      {
        id: "u",
        type: "app.sheets.update",
        parameters: {
          credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries", findBy: "value", column: "Phone No.", value: "+91 98000 00101", match: "phone",
          columns: [{ key: "Status", value: "Contacted" }, { key: "Notes", value: "" }], emptyValues: "keep", ifMissing: "fail", ifMany: "fail",
        },
      },
    ]);
    expect(upd.output("u")![0]).toMatchObject({ action: "updated", changed: { Status: { from: "Line busy", to: "Contacted" } }, Notes: "will meet on saturday" });
    expect(fake.state.sheets[FAKE.spreadsheetId]!.Enquiries![1]![8]).toBe("will meet on saturday");
    // A cell with two numbers is found by either of them.
    fake.state.sheets[FAKE.spreadsheetId]!.Enquiries![4]![2] = "9800000105 | 9800000106";
    const second = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries", column: "Phone No.", value: "+91 98000 00106", match: "phone" } },
    ]);
    expect(second.output("f")!.map((r) => r["Owner Name"])).toEqual(["Anil"]);
    // One search over several tabs and every column: all the words must be in the row, any order.
    const everywhere = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "any", value: "saturday MOHAN", match: "contains" } },
    ]);
    expect(everywhere.output("f")!.map((r) => [r.tab, r["Owner Name"]])).toEqual([["Enquiries", "Mohan"]]);
    const ravi = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "any", value: "ravi", match: "contains" } },
    ]);
    expect(ravi.output("f")!.map((r) => r.tab)).toEqual(["Enquiries", "Team"]);
    const byPhone = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "any", value: "+91 98123 45678", match: "phone" } },
    ]);
    expect(byPhone.output("f")!.map((r) => [r.tab, r.Name])).toEqual([["Team", "Ravi"]]);
    // Nothing in the chosen column: it looks in every column, then for close spellings.
    const wide = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "Assigned To", value: "mohan", match: "contains", ifNothing: "widen" } },
    ]);
    expect(wide.output("f")!.map((r) => [r["Owner Name"], r.closeMatch])).toEqual([["Mohan", undefined]]);
    const close = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "Owner Name", value: "Mohn", match: "contains", ifNothing: "widen" } },
    ]);
    expect(close.output("f")!.map((r) => [r["Owner Name"], r.closeMatch])).toEqual([["Mohan", true]]);
    const glued = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "any", value: "Ki ran", match: "contains", ifNothing: "widen" } },
    ]);
    expect(glued.output("f")!.map((r) => r["Owner Name"])).toEqual(["Kiran"]);
    const none = await run(ws, [
      { id: "t", type: "trigger.manual", to: { main: ["f"] } },
      { id: "f", type: "app.sheets.find", parameters: { credential: id, spreadsheetId: FAKE.spreadsheetId, sheet: "Enquiries, Team", column: "any", value: "zzzzqq", match: "contains", ifNothing: "widen" } },
    ]);
    expect(none.output("f")).toEqual([{ found: false, row: null }]);
    delete fake.state.sheets[FAKE.spreadsheetId]!.Enquiries;
  });
});
