import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Local stand-in for the Telegram Bot API, Slack Web API, Google OAuth, Gmail and
 * Google Sheets, used by tests through CONDUIT_FAKE_APIS_URL (`<base>/<host><path>`).
 * It checks what the real services check that matters to us (tokens, PKCE, scopes
 * of behavior) and records every call for assertions. It is not a full emulator.
 */

export interface FakeCall {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeApis {
  url: string;
  calls: FakeCall[];
  state: FakeState;
  reset(): void;
  close(): Promise<void>;
}

export interface FakeState {
  /** Seconds until issued Google access tokens expire. */
  googleTokenTtl: number;
  refreshCount: number;
  sheets: Record<string, Record<string, string[][]>>;
  sentMail: string[];
  /** Mailbox for Gmail search: subject and from are matched by a simple `q`. */
  inbox: Array<{ id: string; from: string; subject: string; text: string; unread: boolean; date: number }>;
  /** Gmail answers 403 (scope missing) when false. */
  gmailCanRead: boolean;
  telegramWebhooks: Record<string, { url: string; secretToken?: string }>;
  /** Updates waiting for getUpdates (polling mode). Push to simulate someone messaging the bot. */
  telegramUpdates: Array<Record<string, unknown>>;
  driveFiles: Array<{ id: string; name: string; mimeType: string; content: string; parents?: string[] }>;
  notionPages: Array<{ id: string; properties: Record<string, unknown>; children: unknown[] }>;
  airtableRecords: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
  discordMessages: Array<Record<string, unknown>>;
  githubIssues: Array<Record<string, unknown>>;
  trelloCards: Array<Record<string, unknown>>;
  todoistTasks: Array<Record<string, unknown>>;
  mailchimpMembers: Array<{ hash: string; email: string; status: string; merge: Record<string, string>; tags: string[] }>;
  ntfyMessages: Array<Record<string, unknown>>;
}

export const FAKE = {
  telegramToken: "123456:FAKE-telegram-token-abcdefghij",
  slackToken: "xoxb-fake-slack-token-123",
  spreadsheetId: "1FakeSpreadsheetId_abcdefghij",
  googleClientId: "fake-google-client-id",
  googleClientSecret: "fake-google-client-secret",
  googleEmail: "tester@example.com",
  whatsappToken: "EAAG-fake-whatsapp-token",
  whatsappPhoneId: "1098765432",
  notionToken: "ntn_fake_notion_token_123",
  notionDatabase: "0123456789abcdef0123456789abcdef",
  airtableToken: "patFakeAirtableToken.123",
  airtableBase: "appFAKEbase123456",
  discordWebhook: "1234567890/fake-webhook-token",
  githubToken: "github_pat_fake_token_123",
  trelloKey: "fake-trello-key",
  trelloToken: "fake-trello-token-abc",
  trelloList: "5f0c0c0c0c0c0c0c0c0c0c0c",
  todoistToken: "fake-todoist-token-0123",
  mailchimpKey: "fakemailchimpkey123-us21",
  mailchimpList: "a1b2c3d4e5",
  ntfyToken: "tk_fakentfytoken",
};

function freshState(): FakeState {
  return {
    googleTokenTtl: 3600,
    refreshCount: 0,
    sheets: {
      [FAKE.spreadsheetId]: {
        Sheet1: [
          ["Name", "Email", "Plan"],
          ["Ana", "ana@example.com", "pro"],
          ["Ben", "ben@example.com", "free"],
        ],
        Archive: [["Name"]],
        Team: [
          ["Name", "Phone", "Role", "Access"],
          ["Shadab", "+91 99000 11122", "Owner", ""],
          ["Ravi", "098123 45678", "Sales", "edit"],
          ["Asha", "9811112222", "Intern", "view"],
          ["Old hand", "9800000000", "Sales", "blocked"],
        ],
      },
    },
    sentMail: [],
    inbox: [
      { id: "m1", from: "Mehta <mehta@example.com>", subject: "Quote for 50 units", text: "Please send the quote by Friday.", unread: true, date: 1767258000000 },
      { id: "m2", from: "Bank <alerts@bank.example>", subject: "Statement", text: "Your statement is ready.", unread: false, date: 1767171600000 },
    ],
    gmailCanRead: true,
    telegramWebhooks: {},
    telegramUpdates: [],
    driveFiles: [],
    notionPages: [],
    airtableRecords: [],
    discordMessages: [],
    githubIssues: [],
    trelloCards: [],
    todoistTasks: [],
    mailchimpMembers: [],
    ntfyMessages: [],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Parses "'Sheet 1'!A1:ZZ5" or "Sheet1!1:1". */
function parseRange(range: string): { sheet: string; cells: string } {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(range);
  if (!m) return { sheet: range, cells: "" };
  return { sheet: (m[1] ?? m[2]!).replace(/''/g, "'"), cells: m[3]! };
}

export function startFakeApis(port = 0): Promise<FakeApis> {
  const calls: FakeCall[] = [];
  let state = freshState();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; scope: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const expiry = new Map<string, number>();

  const issue = () => {
    const access = `ya29.fake-${randomBytes(8).toString("hex")}`;
    accessTokens.add(access);
    expiry.set(access, Date.now() + state.googleTokenTtl * 1000);
    return access;
  };
  const googleAuthed = (req: IncomingMessage) => {
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    return accessTokens.has(tok) && (expiry.get(tok) ?? 0) > Date.now();
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname === "/__calls") return send(res, 200, calls);
      if (url.pathname === "/__state") return send(res, 200, state);
      if (url.pathname === "/__reset") {
        calls.length = 0;
        state = freshState();
        return send(res, 200, { ok: true });
      }
      const [, host = "", ...rest] = url.pathname.split("/");
      const path = "/" + rest.join("/");
      const raw = await readBody(req);
      let body: unknown = raw;
      const type = String(req.headers["content-type"] ?? "");
      if (type.includes("json") && raw) body = JSON.parse(raw);
      else if (type.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
      calls.push({ host, method: req.method ?? "GET", path: path + url.search, headers: req.headers, body });
      const b = (body ?? {}) as Record<string, any>;

      // Echo: returns the request headers (to check secrets are masked in run output).
      if (host === "echo.test") return send(res, 200, { headers: req.headers, path });

      // --- WhatsApp Cloud API ---------------------------------------------
      if (host === "graph.facebook.com") {
        const m = /^\/v\d+\.\d+\/(\d+)(\/messages)?$/.exec(path);
        if (req.headers.authorization !== `Bearer ${FAKE.whatsappToken}`) return send(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
        if (!m || m[1] !== FAKE.whatsappPhoneId) return send(res, 400, { error: { message: "Unsupported get request.", code: 100 } });
        if (!m[2]) return send(res, 200, { display_phone_number: "+62 811 0000 000", verified_name: "Conduit Test", id: m[1] });
        if (b.type === "text" && String(b.to).endsWith("000")) {
          return send(res, 400, { error: { message: "Re-engagement message", code: 131047 } });
        }
        return send(res, 200, { messaging_product: "whatsapp", contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.FAKE${Date.now()}` }] });
      }

      // --- Google Drive ---------------------------------------------------
      if (host === "www.googleapis.com" && (path.startsWith("/drive/v3/") || path.startsWith("/upload/drive/v3/"))) {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        const view = (f: FakeState["driveFiles"][number]) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
          size: f.mimeType.startsWith("application/vnd.google-apps") ? undefined : String(Buffer.byteLength(f.content)),
        });
        if (req.method === "POST" && path === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart") {
          const boundary = /boundary=([^;]+)/.exec(type)?.[1];
          const parts = boundary ? raw.split(`--${boundary}`).slice(1, -1) : [];
          if (parts.length !== 2) return send(res, 400, { error: { code: 400, message: "Malformed multipart body" } });
          const [metaPart, mediaPart] = parts.map((p) => {
            const i = p.indexOf("\r\n\r\n");
            return { head: p.slice(0, i), body: p.slice(i + 4).replace(/\r\n$/, "") };
          });
          const meta = JSON.parse(metaPart!.body) as { name: string; mimeType?: string; parents?: string[] };
          const mediaType = /Content-Type: ([^;\r\n]+)/i.exec(mediaPart!.head)?.[1] ?? "application/octet-stream";
          const f = { id: `drv${randomBytes(8).toString("hex")}`, name: meta.name, mimeType: meta.mimeType ?? mediaType, content: mediaPart!.body, parents: meta.parents };
          state.driveFiles.push(f);
          return send(res, 200, view(f));
        }
        if (req.method === "GET" && path === "/drive/v3/files") {
          const q = url.searchParams.get("q") ?? "";
          const name = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
          const list = state.driveFiles.filter((f) => !name || f.name.includes(name)).reverse().slice(0, Number(url.searchParams.get("pageSize") ?? 100));
          return send(res, 200, { files: list.map((f) => ({ ...view(f), modifiedTime: "2026-01-01T09:00:00.000Z" })) });
        }
        const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
        const f = m && state.driveFiles.find((x) => x.id === m[1]);
        if (!f) return send(res, 404, { error: { code: 404, message: `File not found: ${m?.[1] ?? ""}.` } });
        const google = f.mimeType.startsWith("application/vnd.google-apps");
        if (m![2]) {
          if (!google) return send(res, 403, { error: { code: 403, message: "Export only supports Docs Editors files." } });
          res.writeHead(200, { "content-type": url.searchParams.get("mimeType") ?? "text/plain" });
          return res.end(f.content);
        }
        if (url.searchParams.get("alt") === "media") {
          if (google) return send(res, 403, { error: { code: 403, message: "Only files with binary content can be downloaded. Use Export with Docs Editors files." } });
          res.writeHead(200, { "content-type": f.mimeType });
          return res.end(f.content);
        }
        return send(res, 200, view(f));
      }

      // --- Google Calendar ------------------------------------------------
      if (host === "www.googleapis.com" && path.startsWith("/calendar/v3/calendars/")) {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        const id = `evt${randomBytes(4).toString("hex")}`;
        return send(res, 200, { id, status: "confirmed", htmlLink: `https://www.google.com/calendar/event?eid=${id}`, start: b.start, end: b.end, attendees: b.attendees });
      }

      // --- Notion -----------------------------------------------------------
      if (host === "api.notion.com") {
        if (req.headers.authorization !== `Bearer ${FAKE.notionToken}`) return send(res, 401, { object: "error", code: "unauthorized", message: "API token is invalid." });
        if (req.headers["notion-version"] !== "2022-06-28") return send(res, 400, { object: "error", code: "missing_version", message: "Notion-Version header failed validation." });
        if (path === "/v1/users/me") return send(res, 200, { object: "user", type: "bot", name: "Conduit" });
        const db = /^\/v1\/databases\/([0-9a-f]{32})(\/query)?$/.exec(path);
        if (db) {
          if (db[1] !== FAKE.notionDatabase) return send(res, 404, { object: "error", code: "object_not_found", message: `Could not find database with ID: ${db[1]}.` });
          if (!db[2]) return send(res, 200, { id: db[1], properties: { Name: { type: "title" }, Email: { type: "email" }, Score: { type: "number" }, Tags: { type: "multi_select" }, VIP: { type: "checkbox" }, Owner: { type: "people" } } });
          return send(res, 200, { results: state.notionPages.slice(0, Number(b.page_size ?? 100)).map((pg) => ({ id: pg.id, url: `https://www.notion.so/${pg.id}`, properties: pg.properties })) });
        }
        if (req.method === "POST" && path === "/v1/pages") {
          const props = Object.fromEntries(
            Object.entries(b.properties as Record<string, Record<string, unknown>>).map(([k, v]) => {
              const type = Object.keys(v)[0]!;
              const val = v[type] as unknown;
              const plain = type === "title" || type === "rich_text" ? (val as Array<{ text: { content: string } }>).map((t) => ({ plain_text: t.text.content })) : val;
              return [k, { type, [type]: plain }];
            }),
          );
          const id = `${randomBytes(4).toString("hex")}-page`;
          state.notionPages.push({ id, properties: props, children: (b.children as unknown[]) ?? [] });
          return send(res, 200, { object: "page", id, url: `https://www.notion.so/${id}` });
        }
        return send(res, 404, { object: "error", code: "invalid_request_url", message: "Invalid request URL." });
      }

      // --- Airtable ---------------------------------------------------------
      if (host === "api.airtable.com") {
        if (req.headers.authorization !== `Bearer ${FAKE.airtableToken}`) return send(res, 401, { error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } });
        if (path === "/v0/meta/whoami") return send(res, 200, { id: "usrFake", email: "tester@example.com" });
        const m = /^\/v0\/(app[A-Za-z0-9]{14})\/([^/?]+)$/.exec(path);
        if (!m || m[1] !== FAKE.airtableBase) return send(res, 404, { error: "NOT_FOUND" });
        const table = decodeURIComponent(m[2]!);
        if (table !== "Leads") return send(res, 404, { error: { type: "TABLE_NOT_FOUND", message: `Could not find table ${table}` } });
        if (req.method === "POST") {
          const recs = (b.records as Array<{ fields: Record<string, unknown> }>).map((r) => ({ id: `rec${randomBytes(7).toString("hex")}`, createdTime: "2026-01-01T09:00:00.000Z", fields: r.fields }));
          state.airtableRecords.push(...recs);
          return send(res, 200, { records: recs });
        }
        const formula = url.searchParams.get("filterByFormula");
        const eq = formula ? /^\{(\w+)\} = '([^']*)'$/.exec(formula) : null;
        if (formula && !eq) return send(res, 422, { error: { type: "INVALID_FILTER_BY_FORMULA", message: "The formula for filtering records is invalid" } });
        const list = state.airtableRecords.filter((r) => !eq || String(r.fields[eq[1]!]) === eq[2]);
        return send(res, 200, { records: list.slice(0, Number(url.searchParams.get("maxRecords") ?? 100)) });
      }

      // --- Discord webhooks -------------------------------------------------
      if (host === "discord.com") {
        const m = /^\/api\/webhooks\/(\d+)\/([\w-]+)$/.exec(path);
        if (!m || `${m[1]}/${m[2]}` !== FAKE.discordWebhook) return send(res, 404, { message: "Unknown Webhook", code: 10015 });
        if (req.method === "GET") return send(res, 200, { id: m[1], name: "Conduit alerts", channel_id: "1200000000000000000" });
        state.discordMessages.push(b as Record<string, unknown>);
        return send(res, 200, { id: "1300000000000000001", channel_id: "1200000000000000000", timestamp: "2026-01-01T09:00:00.000Z", content: b.content });
      }

      // --- GitHub -----------------------------------------------------------
      if (host === "api.github.com") {
        if (req.headers.authorization !== `Bearer ${FAKE.githubToken}`) return send(res, 401, { message: "Bad credentials" });
        if (path === "/user") return send(res, 200, { login: "conduit-tester" });
        const m = /^\/repos\/([\w.-]+)\/([\w.-]+)\/issues$/.exec(path);
        if (!m || `${m[1]}/${m[2]}` !== "acme/site") return send(res, 404, { message: "Not Found" });
        state.githubIssues.push(b as Record<string, unknown>);
        const n = state.githubIssues.length;
        return send(res, 201, { id: 3000000000 + n, number: n, html_url: `https://github.com/acme/site/issues/${n}` });
      }

      // --- Trello -----------------------------------------------------------
      if (host === "api.trello.com") {
        if (url.searchParams.get("key") !== FAKE.trelloKey || url.searchParams.get("token") !== FAKE.trelloToken) {
          res.writeHead(401, { "content-type": "text/plain" });
          return res.end("invalid key");
        }
        if (path === "/1/members/me") return send(res, 200, { username: "conduittester", fullName: "Conduit Tester" });
        if (req.method === "POST" && path === "/1/cards") {
          if (b.idList !== FAKE.trelloList) {
            res.writeHead(404, { "content-type": "text/plain" });
            return res.end("could not find the list");
          }
          state.trelloCards.push(b as Record<string, unknown>);
          return send(res, 200, { id: "600000000000000000000000", shortUrl: "https://trello.com/c/AbCd1234", url: "https://trello.com/c/AbCd1234/1-card" });
        }
        return send(res, 404, "Cannot find");
      }

      // --- Todoist ----------------------------------------------------------
      if (host === "api.todoist.com") {
        if (req.headers.authorization !== `Bearer ${FAKE.todoistToken}`) return send(res, 401, "Unauthorized");
        if (path === "/api/v1/user") return send(res, 200, { id: "1", email: "tester@example.com", full_name: "Tester" });
        if (req.method === "POST" && path === "/api/v1/tasks") {
          state.todoistTasks.push(b as Record<string, unknown>);
          return send(res, 200, { id: "6Jf8VQXxpwv56VQ7", content: b.content, due: b.due_string ? { date: "2026-01-02", string: b.due_string } : null });
        }
        return send(res, 404, "Not found");
      }

      // --- Mailchimp --------------------------------------------------------
      if (host === "us21.api.mailchimp.com") {
        const expected = `Basic ${Buffer.from(`conduit:${FAKE.mailchimpKey}`).toString("base64")}`;
        if (req.headers.authorization !== expected) return send(res, 401, { title: "API Key Invalid", status: 401, detail: "Your API key may be invalid, or you've attempted to access the wrong datacenter." });
        if (path === "/3.0/") return send(res, 200, { account_name: "Acme", email: "owner@example.com" });
        const m = /^\/3\.0\/lists\/(\w+)\/members\/([0-9a-f]{32})(\/tags)?$/.exec(path);
        if (!m || m[1] !== FAKE.mailchimpList) return send(res, 404, { title: "Resource Not Found", status: 404, detail: "The requested resource could not be found." });
        if (m[3]) {
          const who = state.mailchimpMembers.find((x) => x.hash === m[2]);
          if (who) who.tags = (b.tags as Array<{ name: string }>).map((t) => t.name);
          res.writeHead(204);
          return res.end();
        }
        const existing = state.mailchimpMembers.find((x) => x.hash === m[2]);
        const member = existing ?? { hash: m[2]!, email: String(b.email_address), status: String(b.status_if_new), merge: {}, tags: [] as string[] };
        if (b.merge_fields) member.merge = b.merge_fields as Record<string, string>;
        if (!existing) state.mailchimpMembers.push(member);
        return send(res, 200, { id: member.hash, email_address: member.email, status: member.status });
      }

      // --- ntfy -------------------------------------------------------------
      if (host === "ntfy.sh") {
        if (path === "/v1/health") return send(res, 200, { healthy: true });
        if (req.method === "POST" && path === "/") {
          if (String(b.topic).startsWith("locked-") && req.headers.authorization !== `Bearer ${FAKE.ntfyToken}`) return send(res, 403, { code: 40301, http: 403, error: "forbidden" });
          state.ntfyMessages.push(b as Record<string, unknown>);
          return send(res, 200, { id: "sPs71M8A2T", time: 1767258000, event: "message", topic: b.topic, message: b.message });
        }
        return send(res, 404, { code: 40401, error: "page not found" });
      }

      // --- RSS / Atom test feeds -------------------------------------------
      if (host === "feeds.test") {
        const feeds: Record<string, string> = {
          "/rss.xml": `<?xml version="1.0"?><rss version="2.0"><channel><title>Acme &amp; Co blog</title>
            <item><title><![CDATA[Hello <world>]]></title><link>https://acme.test/hello</link><guid>post-1</guid><pubDate>Thu, 01 Jan 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;First &amp;amp; best&lt;/p&gt;</description><dc:creator>Ana</dc:creator></item>
            <item><title>Second</title><link>https://acme.test/second</link><pubDate>not a date</pubDate></item>
          </channel></rss>`,
          "/atom.xml": `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom news</title>
            <entry><title>Atom post</title><link rel="alternate" href="https://acme.test/atom-post"/><id>urn:1</id><updated>2026-01-02T10:00:00Z</updated><summary>Short &#8211; sweet</summary><author><name>Ben</name></author></entry>
          </feed>`,
          "/page.html": "<!doctype html><html><body>not a feed</body></html>",
        };
        const xml = feeds[path];
        if (!xml) return send(res, 404, "nope");
        res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : "application/rss+xml" });
        return res.end(xml);
      }

      // --- Telegram -------------------------------------------------------
      if (host === "api.telegram.org") {
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(path);
        if (!m || m[1] !== FAKE.telegramToken) return send(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
        switch (m[2]) {
          case "getMe":
            return send(res, 200, { ok: true, result: { id: 123456, is_bot: true, username: "conduit_test_bot" } });
          case "sendMessage":
            if (!b.chat_id) return send(res, 400, { ok: false, description: "Bad Request: chat not found" });
            return send(res, 200, { ok: true, result: { message_id: 43, date: 1767258001, text: b.text, chat: { id: Number(b.chat_id) } } });
          case "setWebhook":
            state.telegramWebhooks[m[1]!] = { url: String(b.url), secretToken: b.secret_token };
            return send(res, 200, { ok: true, result: true, description: "Webhook was set" });
          case "deleteWebhook":
            delete state.telegramWebhooks[m[1]!];
            if (b.drop_pending_updates) state.telegramUpdates = [];
            return send(res, 200, { ok: true, result: true });
          case "getUpdates": {
            if (state.telegramWebhooks[m[1]!]) {
              return send(res, 409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
            }
            // Like Telegram: asking for a later offset confirms (forgets) earlier updates.
            const offset = Number(b.offset ?? 0);
            if (offset) state.telegramUpdates = state.telegramUpdates.filter((u) => Number(u.update_id) >= offset);
            return send(res, 200, { ok: true, result: state.telegramUpdates });
          }
        }
        return send(res, 404, { ok: false, description: "Not Found" });
      }

      // --- Slack ----------------------------------------------------------
      if (host === "slack.com") {
        if (req.headers.authorization !== `Bearer ${FAKE.slackToken}`) return send(res, 200, { ok: false, error: "invalid_auth" });
        if (path === "/api/auth.test") return send(res, 200, { ok: true, team: "Test Team", user: "conduit" });
        if (path === "/api/conversations.list") {
          return send(res, 200, { ok: true, channels: [{ id: "C0GENERAL", name: "general", is_member: true }, { id: "C0RANDOM", name: "random", is_member: false }] });
        }
        if (path === "/api/chat.postMessage") {
          if (b.channel === "C0RANDOM") return send(res, 200, { ok: false, error: "not_in_channel" });
          return send(res, 200, { ok: true, channel: b.channel === "#general" ? "C0GENERAL" : b.channel, ts: "1767258000.000100" });
        }
        return send(res, 200, { ok: false, error: "unknown_method" });
      }

      // --- Google OAuth ---------------------------------------------------
      if (host === "accounts.google.com" && path === "/o/oauth2/v2/auth") {
        const q = url.searchParams;
        if (q.get("client_id") !== FAKE.googleClientId || q.get("code_challenge_method") !== "S256") {
          return send(res, 400, { error: "invalid_request" });
        }
        const code = randomBytes(12).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, clientId: q.get("client_id")!, scope: q.get("scope") ?? "" });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (host === "oauth2.googleapis.com" && path === "/token") {
        if (b.client_id !== FAKE.googleClientId || b.client_secret !== FAKE.googleClientSecret) return send(res, 401, { error: "invalid_client" });
        if (b.grant_type === "authorization_code") {
          const c = codes.get(b.code);
          codes.delete(b.code);
          const challenge = createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url");
          if (!c || c.redirectUri !== b.redirect_uri || c.challenge !== challenge) return send(res, 400, { error: "invalid_grant", error_description: "Bad code or verifier" });
          const refresh = `1//fake-refresh-${randomBytes(6).toString("hex")}`;
          refreshTokens.add(refresh);
          return send(res, 200, { access_token: issue(), refresh_token: refresh, expires_in: state.googleTokenTtl, scope: c.scope, token_type: "Bearer" });
        }
        if (b.grant_type === "refresh_token") {
          if (!refreshTokens.has(b.refresh_token)) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          state.refreshCount++;
          await new Promise((r) => setTimeout(r, 100)); // widen the race window for concurrency tests
          return send(res, 200, { access_token: issue(), expires_in: state.googleTokenTtl, token_type: "Bearer" });
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }
      if (host === "openidconnect.googleapis.com" && path === "/v1/userinfo") {
        if (!googleAuthed(req)) return send(res, 401, { error: "invalid_token" });
        return send(res, 200, { email: FAKE.googleEmail, email_verified: true });
      }

      // --- Gmail ----------------------------------------------------------
      if (host === "gmail.googleapis.com") {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        if (path === "/gmail/v1/users/me/messages/send" && typeof b.raw === "string") {
          state.sentMail.push(Buffer.from(b.raw, "base64url").toString("utf8"));
          return send(res, 200, { id: `msg${state.sentMail.length}`, threadId: `thr${state.sentMail.length}` });
        }
        if (path.startsWith("/gmail/v1/users/me/messages")) {
          if (!state.gmailCanRead) return send(res, 403, { error: { code: 403, message: "Request had insufficient authentication scopes." } });
          const one = /^\/gmail\/v1\/users\/me\/messages\/([^/?]+)$/.exec(path.split("?")[0]!);
          if (one) {
            const m = state.inbox.find((x) => x.id === one[1]);
            if (!m) return send(res, 404, { error: { message: "Not found" } });
            return send(res, 200, {
              id: m.id,
              threadId: `t-${m.id}`,
              snippet: m.text.slice(0, 40),
              internalDate: String(m.date),
              labelIds: m.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
              payload: {
                mimeType: "multipart/alternative",
                headers: [
                  { name: "From", value: m.from },
                  { name: "To", value: FAKE.googleEmail },
                  { name: "Subject", value: m.subject },
                ],
                parts: [
                  { mimeType: "text/plain", body: { data: Buffer.from(m.text).toString("base64url") } },
                  { mimeType: "text/html", body: { data: Buffer.from(`<p>${m.text}</p>`).toString("base64url") } },
                ],
              },
            });
          }
          const q = (url.searchParams.get("q") ?? "").toLowerCase();
          const max = Number(url.searchParams.get("maxResults") ?? 100);
          const words = q.split(/\s+/).filter(Boolean);
          const hits = state.inbox.filter((m) =>
            words.every((w) => (w === "is:unread" ? m.unread : w.startsWith("from:") ? m.from.toLowerCase().includes(w.slice(5)) : `${m.subject} ${m.text}`.toLowerCase().includes(w))),
          );
          return send(res, 200, hits.length ? { messages: hits.slice(0, max).map((m) => ({ id: m.id, threadId: `t-${m.id}` })) } : { resultSizeEstimate: 0 });
        }
        return send(res, 404, { error: { message: "Not found" } });
      }

      // --- Google Sheets --------------------------------------------------
      if (host === "sheets.googleapis.com") {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        const batch = /^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/.exec(path);
        if (batch) {
          const book = state.sheets[batch[1]!];
          if (!book) return send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
          for (const d of (b.data ?? []) as Array<{ range: string; values: unknown[][] }>) {
            const { sheet, cells } = parseRange(d.range);
            const cm = /^([A-Z]+)(\d+)$/.exec(cells);
            const rows = book[sheet];
            if (!rows || !cm) return send(res, 400, { error: { code: 400, message: `Unable to parse range: ${d.range}` } });
            const col = [...cm[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
            const r = Number(cm[2]) - 1;
            while (rows.length <= r) rows.push([]);
            const row = rows[r]!;
            while (row.length <= col) row.push("");
            row[col] = String(d.values?.[0]?.[0] ?? "");
          }
          return send(res, 200, { totalUpdatedCells: (b.data ?? []).length });
        }
        const m = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/([^:]+)(:append)?)?$/.exec(path);
        const book = m ? state.sheets[m[1]!] : undefined;
        if (!m || !book) return send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
        if (!m[2]) return send(res, 200, { sheets: Object.keys(book).map((title) => ({ properties: { title } })) });
        const { sheet, cells } = parseRange(decodeURIComponent(m[2]));
        const rows = book[sheet];
        if (!rows) return send(res, 400, { error: { code: 400, message: `Unable to parse range: ${sheet}` } });
        if (m[3]) {
          rows.push((b.values?.[0] ?? []).map(String));
          const n = rows.length;
          return send(res, 200, { updates: { updatedRange: `${sheet}!A${n}:${String.fromCharCode(64 + rows[0]!.length)}${n}`, updatedRows: 1 } });
        }
        if (cells === "1:1") return send(res, 200, { range: `${sheet}!1:1`, values: rows.slice(0, 1) });
        const max = Number(/(\d+)$/.exec(cells)?.[1] ?? rows.length);
        return send(res, 200, { range: `${sheet}!${cells}`, values: rows.slice(0, max) });
      }

      send(res, 404, { error: `fake-apis: no handler for ${host}${path}` });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        get state() {
          return state;
        },
        reset() {
          calls.length = 0;
          state = freshState();
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
