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
  telegramWebhooks: Record<string, { url: string; secretToken?: string }>;
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
      },
    },
    sentMail: [],
    telegramWebhooks: {},
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

      // --- Google Calendar ------------------------------------------------
      if (host === "www.googleapis.com" && path.startsWith("/calendar/v3/calendars/")) {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        const id = `evt${randomBytes(4).toString("hex")}`;
        return send(res, 200, { id, status: "confirmed", htmlLink: `https://www.google.com/calendar/event?eid=${id}`, start: b.start, end: b.end, attendees: b.attendees });
      }

      // --- Stripe ---------------------------------------------------------
      if (host === "api.stripe.com") {
        if (req.headers.authorization !== "Bearer sk_test_fake") return send(res, 401, { error: { message: "Invalid API Key provided" } });
        if (path === "/v1/checkout/sessions" && req.method === "POST") {
          const id = `cs_test_${randomBytes(6).toString("hex")}`;
          return send(res, 200, { id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}`, metadata: { workspaceId: b["metadata[workspaceId]"], plan: b["metadata[plan]"] } });
        }
        if (path === "/v1/billing_portal/sessions" && req.method === "POST") {
          return send(res, 200, { id: "bps_test", url: `https://billing.stripe.com/p/session/test_${String(b.customer)}` });
        }
        if (path === "/v1/invoices") {
          const customer = url.searchParams.get("customer");
          return send(res, 200, {
            object: "list",
            data: [{ id: "in_test_1", number: "CONDUIT-0001", amount_paid: 2900, currency: "usd", status: "paid", created: 1767258000, invoice_pdf: `https://pay.stripe.com/invoice/${customer}/pdf`, hosted_invoice_url: null }],
          });
        }
        return send(res, 404, { error: { message: "Unrecognized request URL" } });
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
            return send(res, 200, { ok: true, result: true });
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
        return send(res, 404, { error: { message: "Not found" } });
      }

      // --- Google Sheets --------------------------------------------------
      if (host === "sheets.googleapis.com") {
        if (!googleAuthed(req)) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
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
