import type { KeyValuePair } from "@conduit/nodes";
import type { EngineServices, Executor, HttpResponse, IntegrationServices, Item } from "../types";
import { StepError } from "../types";
import { parseJsonParam, toNumber, toText } from "../values";

type Json = Record<string, unknown>;
/** One app action, run with resolved parameters. Returns one result or several (one item each). */
export type AppAction = (p: Json, services: EngineServices) => Promise<Json | Json[]>;

function integrations(services: EngineServices): IntegrationServices {
  if (!services.integrations) throw new StepError("Connected apps aren't set up on this server");
  return services.integrations;
}

async function account(p: Json, app: string, services: EngineServices) {
  const id = toText(p.credential);
  if (!id) throw new StepError("Choose an account to use");
  return integrations(services).credential(id, app);
}

async function callJson(
  services: EngineServices,
  req: { method: string; url: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    headers["content-type"] = "application/json";
  }
  return services.http({
    method: req.method,
    url: integrations(services).apiUrl(req.url),
    headers,
    body,
    timeoutMs: req.timeoutMs ?? 30_000,
  });
}

/** Strips CR/LF so values can't add mail headers. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

function addressList(v: unknown): string {
  const list = toText(v)
    .split(/[,;]/)
    .map((s) => headerSafe(s))
    .filter(Boolean);
  if (!list.length) throw new StepError("Add at least one recipient");
  for (const a of list) {
    const email = /<([^>]+)>/.exec(a)?.[1] ?? a;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StepError(`"${a}" is not a valid email address`);
  }
  return list.join(", ");
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

const telegramSend: AppAction = async (p, services) => {
  const { botToken } = await account(p, "telegram", services);
  const text = toText(p.text);
  if (!text.trim()) throw new StepError("Text is empty");
  if (text.length > 4096) throw new StepError("Telegram messages can be at most 4096 characters");
  const res = await callJson(services, {
    method: "POST",
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    body: {
      chat_id: toText(p.chatId),
      text,
      ...(p.parseMode && p.parseMode !== "none" ? { parse_mode: toText(p.parseMode) } : {}),
    },
  });
  const b = res.body as { ok?: boolean; description?: string; result?: { message_id: number; date: number; text?: string; chat: { id: number } } };
  if (!b?.ok || !b.result) throw new StepError(`Telegram: ${b?.description ?? `request failed with status ${res.status}`}`);
  return {
    messageId: b.result.message_id,
    chatId: b.result.chat.id,
    date: new Date(b.result.date * 1000).toISOString(),
    text: b.result.text ?? text,
  };
};

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

const slackSend: AppAction = async (p, services) => {
  const { botToken } = await account(p, "slack", services);
  const res = await callJson(services, {
    method: "POST",
    url: "https://slack.com/api/chat.postMessage",
    headers: { authorization: `Bearer ${botToken}` },
    body: { channel: toText(p.channel).trim(), text: toText(p.text) },
  });
  const b = res.body as { ok?: boolean; error?: string; channel?: string; ts?: string };
  if (!b?.ok) {
    const hint =
      b?.error === "not_in_channel" ? " (invite the bot to the channel first)" : b?.error === "channel_not_found" ? " (check the channel name or ID)" : "";
    throw new StepError(`Slack: ${b?.error ?? `request failed with status ${res.status}`}${hint}`);
  }
  return { ok: true, channel: b.channel, ts: b.ts };
};

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function googleError(res: HttpResponse, what: string): StepError {
  const b = res.body as { error?: { message?: string } | string; error_description?: string };
  const msg = typeof b?.error === "object" ? b.error?.message : (b?.error_description ?? b?.error);
  return new StepError(`${what}: ${msg ?? `request failed with status ${res.status}`}`);
}

function encodeHeaderWord(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** RFC 5322 message, base64url-encoded for the Gmail API. */
export function buildMime(msg: { to: string; subject: string; body: string; html: boolean }): string {
  const lines = [
    `To: ${msg.to}`,
    `Subject: ${encodeHeaderWord(headerSafe(msg.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: ${msg.html ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(msg.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const gmailSend: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const raw = buildMime({ to: addressList(p.to), subject: toText(p.subject), body: toText(p.body), html: p.bodyType === "html" });
  const res = await callJson(services, {
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    headers: { authorization: `Bearer ${accessToken}` },
    body: { raw },
  });
  if (res.status >= 400) throw googleError(res, "Gmail");
  const b = res.body as { id: string; threadId: string };
  return { id: b.id, threadId: b.threadId };
};

/** Accepts a spreadsheet URL or a bare ID. */
export function spreadsheetIdOf(v: unknown): string {
  const s = toText(v).trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s)?.[1];
  const id = fromUrl ?? s;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new StepError("Enter a spreadsheet URL or ID");
  return id;
}

function sheetRange(sheet: unknown, cells: string): string {
  const name = toText(sheet).trim() || "Sheet1";
  return `'${name.replace(/'/g, "''")}'!${cells}`;
}

function sheetsUrl(id: string, range: string, suffix = "") {
  return `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}${suffix}`;
}

async function readHeader(services: EngineServices, token: string | undefined, id: string, sheet: unknown): Promise<string[]> {
  const res = await callJson(services, { method: "GET", url: sheetsUrl(id, sheetRange(sheet, "1:1")), headers: { authorization: `Bearer ${token}` } });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const header = ((res.body as { values?: unknown[][] }).values?.[0] ?? []).map((h) => toText(h).trim());
  if (!header.some(Boolean)) throw new StepError("The sheet's first row needs column names");
  return header;
}

const sheetsAppend: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const header = await readHeader(services, accessToken, id, p.sheet);
  const pairs = (Array.isArray(p.columns) ? (p.columns as KeyValuePair[]) : []).filter((c) => toText(c.key).trim());
  if (!pairs.length) throw new StepError("Add at least one column");
  const row: string[] = header.map(() => "");
  const values: Json = {};
  for (const c of pairs) {
    const key = toText(c.key).trim();
    const col = header.findIndex((h) => h.toLowerCase() === key.toLowerCase());
    if (col < 0) throw new StepError(`No column named "${key}". The sheet has: ${header.filter(Boolean).join(", ")}`);
    row[col] = toText(c.value);
    values[header[col]!] = row[col];
  }
  const res = await callJson(services, {
    method: "POST",
    url: sheetsUrl(id, sheetRange(p.sheet, "A1"), ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),
    headers: { authorization: `Bearer ${accessToken}` },
    body: { values: [row] },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const updatedRange = toText((res.body as { updates?: { updatedRange?: string } }).updates?.updatedRange);
  const rowNum = Number(/![A-Z]+(\d+)/.exec(updatedRange)?.[1] ?? NaN);
  return { updatedRange, row: Number.isFinite(rowNum) ? rowNum : null, values };
};

const sheetsRead: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const limit = Math.min(5000, Math.max(1, Math.floor(toNumber(p.limit ?? 100, "Max rows"))));
  const res = await callJson(services, {
    method: "GET",
    url: sheetsUrl(id, sheetRange(p.sheet, `A1:ZZ${limit + 1}`)),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const [head = [], ...rows] = (res.body as { values?: unknown[][] }).values ?? [];
  const header = head.map((h) => toText(h).trim());
  if (!header.some(Boolean)) throw new StepError("The sheet's first row needs column names");
  return rows.map((r, i) => {
    const out: Json = { row: i + 2 };
    header.forEach((h, c) => {
      if (h) out[h] = r[c] ?? "";
    });
    return out;
  });
};

// ---------------------------------------------------------------------------
// PostgreSQL and SMTP
// ---------------------------------------------------------------------------

const postgresQuery: AppAction = async (p, services) => {
  const cfg = await account(p, "postgres", services);
  const sql = toText(p.query).trim();
  if (!sql) throw new StepError("Query is empty");
  const values = parseJsonParam(p.values, "Values") ?? [];
  if (!Array.isArray(values)) throw new StepError("Values must be a JSON array, e.g. [1, \"text\"]");
  const timeoutMs = Math.min(120, Math.max(1, toNumber(p.timeoutSeconds ?? 30, "Timeout"))) * 1000;
  const res = await integrations(services).sqlQuery(cfg, sql, values, timeoutMs);
  return res.rows.length ? res.rows : { rowCount: res.rowCount, command: res.command };
};

const smtpSend: AppAction = async (p, services) => {
  const cfg = await account(p, "smtp", services);
  const html = toText(p.html).trim();
  return integrations(services).sendMail(cfg, {
    to: addressList(p.to),
    subject: headerSafe(toText(p.subject)),
    text: toText(p.text),
    ...(html ? { html } : {}),
  });
};

// ---------------------------------------------------------------------------
// WhatsApp Cloud API and Google Calendar
// ---------------------------------------------------------------------------

const whatsappSend: AppAction = async (p, services) => {
  const { phoneNumberId, accessToken } = await account(p, "whatsapp", services);
  const to = toText(p.to).replace(/[\s()+-]/g, "");
  if (!/^\d{7,15}$/.test(to)) throw new StepError("Enter the phone number in international format, e.g. +6281234567890");
  let payload: Json;
  if (p.messageType === "template") {
    const name = toText(p.templateName).trim();
    if (!name) throw new StepError("Template name is required");
    const values = (Array.isArray(p.templateValues) ? (p.templateValues as KeyValuePair[]) : []).filter((v) => toText(v.value) !== "");
    payload = {
      type: "template",
      template: {
        name,
        language: { code: toText(p.languageCode) || "en_US" },
        ...(values.length ? { components: [{ type: "body", parameters: values.map((v) => ({ type: "text", text: toText(v.value) })) }] } : {}),
      },
    };
  } else {
    const text = toText(p.text);
    if (!text.trim()) throw new StepError("Text is empty");
    if (text.length > 4096) throw new StepError("WhatsApp messages can be at most 4096 characters");
    payload = { type: "text", text: { body: text, preview_url: true } };
  }
  const res = await callJson(services, {
    method: "POST",
    url: `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId ?? "")}/messages`,
    headers: { authorization: `Bearer ${accessToken}` },
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload },
  });
  const b = res.body as { messages?: Array<{ id: string }>; contacts?: Array<{ wa_id: string }>; error?: { message?: string; code?: number } };
  if (res.status >= 400 || !b?.messages?.[0]) {
    const hint = b?.error?.code === 131047 ? " (more than 24 hours since they last wrote: use an approved template)" : "";
    throw new StepError(`WhatsApp: ${b?.error?.message ?? `request failed with status ${res.status}`}${hint}`);
  }
  return { messageId: b.messages[0].id, to: b.contacts?.[0]?.wa_id ?? to };
};

function isoDateTime(v: unknown, label: string): string {
  const s = toText(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(s)) {
    throw new StepError(`${label}: use a date and time like 2026-01-15T10:00:00`);
  }
  return s.length === 16 ? `${s}:00` : s;
}

const calendarCreate: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const start = isoDateTime(p.start, "Starts");
  const end = isoDateTime(p.end, "Ends");
  const timeZone = toText(p.timeZone).trim() || "UTC";
  const attendees = toText(p.attendees)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of attendees) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new StepError(`"${a}" is not a valid email address`);
  const calendarId = encodeURIComponent(toText(p.calendarId).trim() || "primary");
  const res = await callJson(services, {
    method: "POST",
    url: `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${attendees.length ? "?sendUpdates=all" : ""}`,
    headers: { authorization: `Bearer ${accessToken}` },
    body: {
      summary: toText(p.summary),
      description: toText(p.description) || undefined,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
      ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
    },
  });
  if (res.status >= 400) {
    const insufficient = res.status === 403 ? " (reconnect the Google account to grant Calendar access)" : "";
    throw new StepError(`${googleError(res, "Google Calendar").message}${insufficient}`);
  }
  const b = res.body as { id: string; htmlLink: string; status: string; start?: { dateTime?: string } };
  return { id: b.id, htmlLink: b.htmlLink, status: b.status, start: b.start?.dateTime ?? start };
};

export const APP_ACTIONS: Record<string, AppAction> = {
  "app.whatsapp.send": whatsappSend,
  "app.calendar.create": calendarCreate,
  "app.telegram.send": telegramSend,
  "app.slack.send": slackSend,
  "app.gmail.send": gmailSend,
  "app.sheets.append": sheetsAppend,
  "app.sheets.read": sheetsRead,
  "app.postgres.query": postgresQuery,
  "app.smtp.send": smtpSend,
};

/** Runs the action once per input item; list results become one item each. */
export const appActionExecutor: Executor = async (ctx) => {
  const run = APP_ACTIONS[ctx.node.type];
  if (!run) throw new StepError(`Unknown app action ${ctx.node.type}`);
  const out: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const r = await run(ctx.params(i), ctx.services);
    for (const j of Array.isArray(r) ? r : [r]) out.push({ json: j });
  }
  return { outputs: { main: out } };
};
