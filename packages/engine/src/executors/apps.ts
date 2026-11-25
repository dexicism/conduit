import type { KeyValuePair } from "@conduit/nodes";
import type { EngineServices, Executor, HttpResponse, IntegrationServices, Item } from "../types";
import { StepError } from "../types";
import { parseJsonParam, toNumber, toText } from "../values";
import { MORE_APP_ACTIONS } from "./apps-more";
import { WHATSAPP_WEB_ACTIONS } from "./apps-whatsapp-web";

type Json = Record<string, unknown>;
/** One app action, run with resolved parameters. Returns one result or several (one item each). */
export type AppAction = (p: Json, services: EngineServices) => Promise<Json | Json[]>;

function integrations(services: EngineServices): IntegrationServices {
  if (!services.integrations) throw new StepError("Connected apps aren't set up on this server");
  return services.integrations;
}

export async function account(p: Json, app: string, services: EngineServices) {
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

function header(h: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  return h?.find((x) => x.name?.toLowerCase() === name)?.value ?? "";
}

/** Plain text of a Gmail message: the text/plain part, or the HTML part without tags. */
function gmailBody(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!part) return "";
  const decode = (d?: string) => (d ? Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  const kids = (part.parts ?? []) as Array<typeof part>;
  const plain = kids.map(gmailBody).find((t) => t.trim());
  if (plain) return plain;
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return decode(part.body?.data);
}

const gmailSearch: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const q = toText(p.query).trim();
  const max = Math.min(25, Math.max(1, Math.floor(toNumber(p.limit ?? 5, "Max emails"))));
  const auth = { authorization: `Bearer ${accessToken}` };
  const list = await callJson(services, {
    method: "GET",
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    headers: auth,
  });
  if (list.status === 403) throw new StepError("Gmail: Conduit isn't allowed to read mail yet. Open Connected apps and press Reconnect on the Google account.");
  if (list.status >= 400) throw googleError(list, "Gmail");
  const ids = ((list.body as { messages?: Array<{ id: string }> }).messages ?? []).map((m) => m.id);
  const out: Json[] = [];
  for (const id of ids) {
    const res = await callJson(services, { method: "GET", url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, headers: auth });
    if (res.status >= 400) throw googleError(res, "Gmail");
    const m = res.body as { id: string; threadId: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name?: string; value?: string }> } & Parameters<typeof gmailBody>[0] };
    const body = gmailBody(m.payload).trim();
    out.push({
      id: m.id,
      threadId: m.threadId,
      from: header(m.payload?.headers, "from"),
      to: header(m.payload?.headers, "to"),
      subject: header(m.payload?.headers, "subject"),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m.payload?.headers, "date"),
      unread: (m.labelIds ?? []).includes("UNREAD"),
      snippet: m.snippet ?? "",
      body: body.length > 8000 ? `${body.slice(0, 8000)}\n…(cut)` : body,
    });
  }
  return out.length ? out : { found: false };
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

/** All rows as {row, header->value}, read once per step. */
export async function readTable(services: EngineServices, token: string | undefined, id: string, sheet: unknown, limit = 5000) {
  const res = await callJson(services, { method: "GET", url: sheetsUrl(id, sheetRange(sheet, `A1:ZZ${limit + 1}`)), headers: { authorization: `Bearer ${token}` } });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const [head = [], ...rows] = (res.body as { values?: unknown[][] }).values ?? [];
  const header = head.map((h) => toText(h).trim());
  if (!header.some(Boolean)) throw new StepError("The sheet's first row needs column names");
  return { header, rows: rows.map((r) => header.map((_, c) => toText(r[c] ?? ""))) };
}

function columnIndex(header: string[], name: string): number {
  const key = name.trim().toLowerCase();
  const col = header.findIndex((h) => h.toLowerCase() === key);
  if (col < 0) throw new StepError(`No column named "${name.trim()}". The sheet has: ${header.filter(Boolean).join(", ")}`);
  return col;
}

/** Column letters for a 0-based index: 0 -> A, 26 -> AA. */
function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const digits = (v: string) => v.replace(/\D/g, "");

/** Compares one cell to what we're looking for. Phone numbers match on their digits, so "+91 98123-45678" finds "9812345678". */
function cellMatches(cell: string, wanted: string, how: string): boolean {
  if (how === "contains") return norm(cell).includes(norm(wanted));
  if (how === "phone") {
    const a = digits(cell);
    const b = digits(wanted);
    return a.length >= 7 && b.length >= 7 && (a.endsWith(b) || b.endsWith(a));
  }
  return norm(cell) === norm(wanted);
}

function rowObject(header: string[], cells: string[], rowNumber: number): Json {
  const out: Json = { row: rowNumber };
  header.forEach((h, c) => {
    if (h) out[h] = cells[c] ?? "";
  });
  return out;
}

const sheetsFind: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const column = toText(p.column).trim();
  if (!column) throw new StepError("Choose the column to search in");
  const col = columnIndex(header, column);
  const wanted = toText(p.value);
  if (!wanted.trim()) throw new StepError("The value to find is empty");
  const how = toText(p.match) || "equals";
  const limit = Math.min(500, Math.max(1, Math.floor(toNumber(p.limit ?? 50, "Max rows"))));
  const found = rows
    .map((cells, i) => ({ cells, row: i + 2 }))
    .filter((r) => cellMatches(r.cells[col] ?? "", wanted, how))
    .slice(0, limit)
    .map((r) => ({ found: true, ...rowObject(header, r.cells, r.row) }));
  // Always one item at least, so the workflow can branch on "found".
  return found.length ? found : { found: false, row: null };
};

const sheetsUpdate: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const pairs = (Array.isArray(p.columns) ? (p.columns as KeyValuePair[]) : []).filter((c) => toText(c.key).trim());
  if (!pairs.length) throw new StepError("Add at least one column to change");
  const changes = pairs.map((c) => ({ col: columnIndex(header, toText(c.key)), value: toText(c.value) }));

  let rowNumber: number | null = null;
  if (p.findBy === "row") {
    rowNumber = Math.floor(toNumber(p.rowNumber, "Row number"));
    if (rowNumber < 2) throw new StepError("Row 1 is the header row. Use 2 or higher.");
  } else {
    const col = columnIndex(header, toText(p.column));
    const wanted = toText(p.value);
    if (!wanted.trim()) throw new StepError("The value to find is empty");
    const matches = rows.map((cells, i) => ({ cells, row: i + 2 })).filter((r) => cellMatches(r.cells[col] ?? "", wanted, toText(p.match) || "equals"));
    if (matches.length > 1 && p.ifMany === "fail") {
      throw new StepError(`${matches.length} rows match "${wanted}" (rows ${matches.slice(0, 5).map((m) => m.row).join(", ")}). Make the search more specific.`);
    }
    rowNumber = matches[0]?.row ?? null;
    if (rowNumber === null) {
      if (p.ifMissing === "add") {
        const row: string[] = header.map(() => "");
        row[col] = wanted;
        for (const c of changes) row[c.col] = c.value;
        const res = await callJson(services, {
          method: "POST",
          url: sheetsUrl(id, sheetRange(p.sheet, "A1"), ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),
          headers: { authorization: `Bearer ${accessToken}` },
          body: { values: [row] },
        });
        if (res.status >= 400) throw googleError(res, "Google Sheets");
        const updatedRange = toText((res.body as { updates?: { updatedRange?: string } }).updates?.updatedRange);
        const added = Number(/![A-Z]+(\d+)/.exec(updatedRange)?.[1] ?? NaN);
        return { action: "added", ...rowObject(header, row, Number.isFinite(added) ? added : rows.length + 2) };
      }
      if (p.ifMissing === "skip") return { action: "not_found", row: null };
      throw new StepError(`No row where ${header[col]} is "${wanted}"`);
    }
  }

  const before = rows[rowNumber - 2] ?? header.map(() => "");
  const res = await callJson(services, {
    method: "POST",
    url: `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
    headers: { authorization: `Bearer ${accessToken}` },
    body: {
      valueInputOption: "USER_ENTERED",
      data: changes.map((c) => ({ range: sheetRange(p.sheet, `${columnLetter(c.col)}${rowNumber}`), values: [[c.value]] })),
    },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const after = [...before];
  for (const c of changes) after[c.col] = c.value;
  const changed = Object.fromEntries(changes.filter((c) => (before[c.col] ?? "") !== c.value).map((c) => [header[c.col]!, { from: before[c.col] ?? "", to: c.value }]));
  return { action: "updated", changed, ...rowObject(header, after, rowNumber) };
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

// ---------------------------------------------------------------------------
// Google Drive (drive.file scope: only files this app created or was given)
// ---------------------------------------------------------------------------

const MAX_DRIVE_TEXT = 5_000_000;
const DRIVE_TYPES: Record<string, string> = {
  text: "text/plain",
  csv: "text/csv",
  json: "application/json",
  markdown: "text/markdown",
  html: "text/html",
};
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";

/** Accepts a Drive URL (…/d/<id>/…, …/folders/<id>, ?id=<id>) or a bare ID. */
export function driveId(v: unknown, label: string): string {
  const s = toText(v).trim();
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  const id = m?.[1] ?? s;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new StepError(`${label}: paste a Google Drive link or ID`);
  return id;
}

function driveFail(res: HttpResponse): StepError {
  const e = googleError(res, "Google Drive");
  if (res.status === 403 && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(res.body ?? ""))) {
    return new StepError(`${e.message} (reconnect the Google account to grant Drive access)`);
  }
  if (res.status === 404) return new StepError("Google Drive: file not found. Conduit can only see files it created or that were opened with it.");
  return e;
}

const driveSave: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const name = toText(p.fileName).trim();
  if (!name) throw new StepError("Add a file name");
  const content = toText(p.content);
  if (content.length > MAX_DRIVE_TEXT) throw new StepError("The content is larger than 5 MB");
  const kind = toText(p.fileType) || "text";
  const mime = DRIVE_TYPES[kind];
  if (!mime) throw new StepError(`Unknown file type "${kind}"`);
  const convert = toText(p.convert) || "none";
  if (convert === "sheet" && kind !== "csv") throw new StepError("Only CSV content can be saved as a Google Sheet");
  if (convert === "doc" && !["text", "markdown", "html"].includes(kind)) throw new StepError("Only text, Markdown or HTML can be saved as a Google Doc");
  const meta: Json = { name };
  if (convert === "doc") meta.mimeType = GOOGLE_DOC;
  if (convert === "sheet") meta.mimeType = GOOGLE_SHEET;
  if (toText(p.folder).trim()) meta.parents = [driveId(p.folder, "Folder")];

  const boundary = `conduit${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await services.http({
    method: "POST",
    url: integrations(services).apiUrl("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink"),
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}`, accept: "application/json" },
    body,
    timeoutMs: 60_000,
  });
  if (res.status >= 400) throw driveFail(res);
  const b = res.body as { id: string; name: string; mimeType: string; webViewLink?: string };
  return { id: b.id, name: b.name, mimeType: b.mimeType, link: b.webViewLink ?? `https://drive.google.com/file/d/${b.id}/view` };
};

const driveFind: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const limit = Math.min(Math.max(Math.trunc(toNumber(p.limit ?? 20, "Max files")), 1), 100);
  const name = toText(p.nameContains).trim();
  const q = ["trashed = false", ...(name ? [`name contains '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`] : [])].join(" and ");
  const qs = new URLSearchParams({ q, pageSize: String(limit), orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,webViewLink,modifiedTime,size)" });
  const res = await callJson(services, { method: "GET", url: `https://www.googleapis.com/drive/v3/files?${qs}`, headers: { authorization: `Bearer ${accessToken}` } });
  if (res.status >= 400) throw driveFail(res);
  const files = (res.body as { files?: Array<Record<string, string>> }).files ?? [];
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    link: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
    modifiedTime: f.modifiedTime ?? null,
    size: f.size ? Number(f.size) : null,
  }));
};

const driveRead: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = driveId(p.file, "File");
  const auth = { authorization: `Bearer ${accessToken}` };
  const metaRes = await callJson(services, { method: "GET", url: `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size`, headers: auth });
  if (metaRes.status >= 400) throw driveFail(metaRes);
  const meta = metaRes.body as { id: string; name: string; mimeType: string; size?: string };
  let url: string;
  if (meta.mimeType === GOOGLE_DOC || meta.mimeType === "application/vnd.google-apps.presentation") url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`;
  else if (meta.mimeType === GOOGLE_SHEET) url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`;
  else if (/^text\/|json|xml|csv|markdown/.test(meta.mimeType)) {
    if (Number(meta.size ?? 0) > MAX_DRIVE_TEXT) throw new StepError("The file is larger than 5 MB");
    url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  } else throw new StepError(`Only text files, Google Docs and Google Sheets can be read (this file is ${meta.mimeType})`);
  const res = await services.http({ method: "GET", url: integrations(services).apiUrl(url), headers: { ...auth, accept: "*/*" }, timeoutMs: 60_000 });
  if (res.status >= 400) throw driveFail(res);
  const content = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  if (content.length > MAX_DRIVE_TEXT) throw new StepError("The file is larger than 5 MB");
  return { id: meta.id, name: meta.name, mimeType: meta.mimeType, content };
};

export const APP_ACTIONS: Record<string, AppAction> = {
  ...MORE_APP_ACTIONS,
  ...WHATSAPP_WEB_ACTIONS,
  "app.drive.save": driveSave,
  "app.drive.find": driveFind,
  "app.drive.read": driveRead,
  "app.whatsapp.send": whatsappSend,
  "app.calendar.create": calendarCreate,
  "app.telegram.send": telegramSend,
  "app.slack.send": slackSend,
  "app.gmail.send": gmailSend,
  "app.sheets.append": sheetsAppend,
  "app.sheets.read": sheetsRead,
  "app.sheets.find": sheetsFind,
  "app.gmail.search": gmailSearch,
  "app.sheets.update": sheetsUpdate,
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
