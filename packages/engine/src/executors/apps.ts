import type { KeyValuePair } from "@conduit/nodes";
import type { EngineServices, Executor, HttpResponse, IntegrationServices, Item } from "../types";
import { StepError, SHARED_MEMORY } from "../types";
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
  // A change to a spreadsheet makes earlier reads of it stale.
  if (req.method !== "GET" && services.readCache && /sheets\.googleapis\.com\/v4\/spreadsheets\//.test(req.url)) services.readCache.clear();
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

/**
 * Values are written as if typed in, so dates and numbers become real dates and
 * numbers. But Sheets also reads text starting with + or @ (or - before a word)
 * as a formula: "+91 98181 50299" turns into #ERROR!. Those are kept as text.
 * Text starting with = is left alone, so formulas still work.
 */
export function asTyped(v: string | null): string | null {
  if (v === null) return null;
  const s = v.trimStart();
  if (/^[+@]/.test(s) || (/^-/.test(s) && !/^-\s*[\d.,]+%?$/.test(s))) return `'${v}`;
  return v;
}

/** One add at a time per tab (in this process), so two messages at once can't pick the same row. */
const addLocks = new Map<string, Promise<unknown>>();

/**
 * Adds a row in the first row after the data. Many sheets are prepared with
 * formulas filled down (a serial number, "Follow-up Due"): Google's append would
 * insert a new row above those, without the formulas. Writing into that row
 * instead keeps them, because only the cells we fill are written (null cells
 * are skipped). Falls back to append when the sheet has no room left.
 */
async function addRow(services: EngineServices, token: string | undefined, id: string, sheet: unknown, row: Array<string | null>): Promise<{ row: number | null; updatedRange: string }> {
  const key = `${id}|${toText(sheet)}`;
  const run = async () => {
    const { rows } = await readTableUncached(services, token, id, sheet, 20_000);
    const cols = row.map((v, c) => (v === null ? -1 : c)).filter((c) => c >= 0);
    let last = -1;
    rows.forEach((r, i) => {
      if (cols.some((c) => (r[c] ?? "").trim())) last = i;
    });
    const target = last + 3; // the header is row 1, data row i is row i + 2
    const range = sheetRange(sheet, `A${target}:${columnLetter(row.length - 1)}${target}`);
    const put = await callJson(services, {
      method: "PUT",
      url: sheetsUrl(id, range, "?valueInputOption=USER_ENTERED"),
      headers: { authorization: `Bearer ${token}` },
      body: { values: [row.map(asTyped)] },
    });
    if (put.status < 400) return { row: target, updatedRange: toText((put.body as { updatedRange?: string }).updatedRange) || range };
    if (put.status !== 400) throw googleError(put, "Google Sheets");
    // Usually: the row is past the end of the grid. Let Google add one.
    const res = await callJson(services, {
      method: "POST",
      url: sheetsUrl(id, sheetRange(sheet, "A1"), ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),
      headers: { authorization: `Bearer ${token}` },
      body: { values: [row.map(asTyped)] },
    });
    if (res.status >= 400) throw googleError(res, "Google Sheets");
    const updatedRange = toText((res.body as { updates?: { updatedRange?: string } }).updates?.updatedRange);
    const n = Number(/![A-Z]+(\d+)/.exec(updatedRange)?.[1] ?? NaN);
    return { row: Number.isFinite(n) ? n : null, updatedRange };
  };
  const done = (addLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  addLocks.set(key, done);
  try {
    return await done;
  } finally {
    if (addLocks.get(key) === done) addLocks.delete(key);
  }
}

const sheetsAppend: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const header = await readHeader(services, accessToken, id, p.sheet);
  const pairs = (Array.isArray(p.columns) ? (p.columns as KeyValuePair[]) : []).filter((c) => toText(c.key).trim());
  if (!pairs.length) throw new StepError("Add at least one column");
  // Columns we don't fill stay untouched (null), so formulas in them keep working.
  const row: Array<string | null> = header.map(() => null);
  const values: Json = {};
  for (const c of pairs) {
    const key = toText(c.key).trim();
    const col = header.findIndex((h) => h.toLowerCase() === key.toLowerCase());
    if (col < 0) throw new StepError(`No column named "${key}". The sheet has: ${header.filter(Boolean).join(", ")}`);
    row[col] = toText(c.value);
    values[header[col]!] = row[col];
  }
  const { row: rowNum, updatedRange } = await addRow(services, accessToken, id, p.sheet, row);
  await logActivity(services, accessToken, id, p, {
    row: rowNum,
    name: nameOf(header, row),
    change: `Added: ${Object.entries(values).filter(([, v]) => toText(v).trim()).map(([k, v]) => `${k}=${toText(v)}`).join("; ")}`,
  });
  return { updatedRange, row: rowNum, values };
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
export async function readTable(services: EngineServices, token: string | undefined, id: string, sheet: unknown, limit = 5000): Promise<{ header: string[]; rows: string[][] }> {
  const key = `table|${id}|${toText(sheet)}|${limit}`;
  const hit = services.readCache?.get(key) as { header: string[]; rows: string[][] } | undefined;
  if (hit) return { header: [...hit.header], rows: hit.rows.map((r) => [...r]) };
  const table = await readTableUncached(services, token, id, sheet, limit);
  services.readCache?.set(key, table);
  return { header: [...table.header], rows: table.rows.map((r) => [...r]) };
}

async function readTableUncached(services: EngineServices, token: string | undefined, id: string, sheet: unknown, limit: number) {
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
    const b = digits(wanted).replace(/^0+/, "");
    // A cell can hold several numbers ("98000 00105 | 98000 00106"): any of them counts.
    return b.length >= 7 && cell.split(/[|,;/]|\bor\b/i).some((part) => {
      const a = digits(part).replace(/^0+/, "");
      return a.length >= 7 && (a.endsWith(b) || b.endsWith(a));
    });
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

/** "any", "all", "*" or nothing: search every column. */
const ANY_COLUMN = new Set(["", "any", "all", "*", "any column", "everything"]);

/** Every word of `wanted` is somewhere in the row (any order), so "priya architect" finds a row with both words. */
function rowHasWords(cells: string[], wanted: string): boolean {
  const text = norm(cells.join(" \u0001 "));
  const words = norm(wanted).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
}

const sheetsFind: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const column = toText(p.column).trim();
  const anyColumn = ANY_COLUMN.has(column.toLowerCase());
  const wanted = toText(p.value);
  if (!wanted.trim()) throw new StepError("The value to find is empty");
  const how = toText(p.match) || "equals";
  const limit = Math.min(500, Math.max(1, Math.floor(toNumber(p.limit ?? 50, "Max rows"))));
  // Several tabs at once: "Enquiries, Architect Data". Each row says which tab it's from.
  const tabs = toText(p.sheet).split(",").map((t) => t.trim()).filter(Boolean);
  const many = tabs.length > 1;
  const found: Json[] = [];
  for (const tab of many ? tabs : [p.sheet]) {
    const { header, rows } = await readTable(services, accessToken, id, tab);
    let col = -1;
    if (!anyColumn) {
      col = header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
      if (col < 0) {
        if (many) continue; // this tab doesn't have that column
        columnIndex(header, column); // throws the helpful "no column named" error
      }
    }
    for (let i = 0; i < rows.length && found.length < limit; i++) {
      const cells = rows[i]!;
      const hit = anyColumn
        ? how === "phone"
          ? cells.some((c) => cellMatches(c, wanted, "phone"))
          : how === "contains"
            ? rowHasWords(cells, wanted)
            : cells.some((c) => cellMatches(c, wanted, how))
        : cellMatches(cells[col] ?? "", wanted, how);
      if (hit) found.push({ found: true, ...(many ? { tab: String(tab) } : {}), ...rowObject(header, cells, i + 2) });
    }
  }
  if (p.ifNothing === "widen" && how !== "phone" && found.length < 5) {
    // Few or no hits: also try every column, then spellings that are close (Rajesh / Rajes, Mohit / Mohith).
    // Close spellings are added even when something matched, because a word can match the wrong row
    // (a name inside someone else's address) while the person meant is spelled a bit differently.
    const seenRows = new Set(found.map((f) => `${String(f.tab ?? "")}:${String(f.row)}`));
    for (const pass of anyColumn ? ["close"] : ["words", "close"]) {
      if (pass === "words" && found.length) continue;
      for (const tab of many ? tabs : [p.sheet]) {
        const { header, rows } = await readTable(services, accessToken, id, tab);
        for (let i = 0; i < rows.length && found.length < limit; i++) {
          const key = `${many ? String(tab) : ""}:${i + 2}`;
          if (seenRows.has(key)) continue;
          const cells = rows[i]!;
          if (pass === "words" ? rowHasWords(cells, wanted) : rowHasCloseWords(cells, wanted)) {
            seenRows.add(key);
            found.push({ found: true, ...(pass === "close" ? { closeMatch: true } : {}), ...(many ? { tab: String(tab) } : {}), ...rowObject(header, cells, i + 2) });
          }
        }
      }
    }
  }
  // Always one item at least, so the workflow can branch on "found".
  return found.length ? found : { found: false, row: null };
};

/** How many single-letter edits turn a into b (stops early past `max`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Every word (3+ letters) has a close spelling in the row: 1 letter off for short words, 2 for long ones. Spaces inside names don't matter. */
function rowHasCloseWords(cells: string[], wanted: string): boolean {
  const simple = (s: string) => norm(s).replace(/[^a-z0-9\u0900-\u097f ]/g, " ");
  const words = simple(wanted).split(" ").filter((w) => w.length >= 3);
  if (!words.length) return false;
  const tokens = simple(cells.join(" ")).split(" ").filter(Boolean);
  // Also pairs of neighbours glued together, so "ram lal" matches "ramlal".
  const all = [...tokens, ...tokens.slice(1).map((t, i) => tokens[i]! + t)];
  const close = (w: string) => all.some((t) => editDistance(w, t, w.length >= 7 ? 2 : 1) <= (w.length >= 7 ? 2 : 1));
  // "ram lal" typed apart still finds "Ramlal".
  const glued = simple(wanted).replace(/ /g, "");
  return words.every(close) || (glued.length >= 5 && close(glued));
}

const sheetsUpdate: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const pairs = (Array.isArray(p.columns) ? (p.columns as KeyValuePair[]) : []).filter((c) => toText(c.key).trim());
  if (!pairs.length) throw new StepError("Add at least one column to change");
  const keepEmpty = p.emptyValues === "keep";
  const changes = pairs
    .map((c) => ({ col: columnIndex(header, toText(c.key)), value: toText(c.value) }))
    // "Leave as it is": an empty value doesn't wipe the cell (handy for AI tools that only change some columns).
    .filter((c) => !keepEmpty || c.value.trim() !== "");

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
        const row: Array<string | null> = header.map(() => null);
        row[col] = wanted;
        for (const c of changes) row[c.col] = c.value;
        const { row: addedRow } = await addRow(services, accessToken, id, p.sheet, row);
        const added = addedRow ?? NaN;
        await logActivity(services, accessToken, id, p, { row: Number.isFinite(added) ? added : null, name: nameOf(header, row), change: `Added: ${changes.map((c) => `${header[c.col]}=${c.value}`).join("; ")}` });
        return { action: "added", ...rowObject(header, row.map((v) => v ?? ""), Number.isFinite(added) ? added : rows.length + 2) };
      }
      if (p.ifMissing === "skip") return { action: "not_found", row: null };
      throw new StepError(`No row where ${header[col]} is "${wanted}"`);
    }
  }

  const before = rows[rowNumber - 2] ?? header.map(() => "");
  if (!changes.length) return { action: "unchanged", changed: {}, ...rowObject(header, before, rowNumber) };
  const res = await callJson(services, {
    method: "POST",
    url: `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
    headers: { authorization: `Bearer ${accessToken}` },
    body: {
      valueInputOption: "USER_ENTERED",
      data: changes.map((c) => ({ range: sheetRange(p.sheet, `${columnLetter(c.col)}${rowNumber}`), values: [[asTyped(c.value)]] })),
    },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const after = [...before];
  for (const c of changes) after[c.col] = c.value;
  const changed = Object.fromEntries(changes.filter((c) => (before[c.col] ?? "") !== c.value).map((c) => [header[c.col]!, { from: before[c.col] ?? "", to: c.value }]));
  await logActivity(services, accessToken, id, p, {
    row: rowNumber,
    name: nameOf(header, after),
    change: Object.entries(changed).map(([k, v]) => `${k}: ${v.from || "(empty)"} -> ${v.to || "(empty)"}`).join("; "),
  });
  return { action: "updated", changed, ...rowObject(header, after, rowNumber) };
};

// ---------------------------------------------------------------------------
// Task log (a Tasks tab in a Google Sheet)
// ---------------------------------------------------------------------------

const DONE = new Set(["done", "closed", "complete", "completed", "cancelled", "canceled", "finished", "resolved", "won", "lost"]);

/** Columns of a task log, matched loosely so a hand-made sheet works. */
function taskColumns(header: string[]) {
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  return {
    id: find("id", "task id", "#"),
    task: find("task", "what", "description", "todo"),
    customer: find("customer", "client", "about", "party", "company", "customer name", "client name", "owner name", "lead", "name"),
    assignee: find("assigned to", "assignee", "owner", "who", "employee"),
    phone: find("phone", "assignee phone", "number"),
    status: find("status", "state"),
    due: find("due", "due date", "deadline", "by", "next follow-up", "next follow up", "next followup", "follow-up date", "followup date", "next followup date", "follow up date"),
    createdBy: find("created by", "assigned by", "from"),
    created: find("created", "created at", "date"),
  };
}

const tasksAdd: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const col = taskColumns(header);
  if (col.task < 0 || col.status < 0) throw new StepError(`The task sheet needs at least Task and Status columns. It has: ${header.filter(Boolean).join(", ")}`);
  const task = toText(p.task).trim();
  if (!task) throw new StepError("What's the task? It's empty.");
  const customer = toText(p.customer).trim();
  const cell = (r: string[], c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");

  // Someone already on it? Same customer (or the same task text if there's no customer), still open.
  if (p.onConflict !== "add") {
    const same = rows
      .map((r, i) => ({ r, row: i + 2 }))
      .filter(({ r }) => !DONE.has(cell(r, col.status).toLowerCase()))
      .find(({ r }) => (customer && col.customer >= 0 ? norm(cell(r, col.customer)) === norm(customer) : norm(cell(r, col.task)) === norm(task)));
    if (same) {
      const who = cell(same.r, col.assignee) || "someone";
      return {
        status: "conflict",
        message: `${who} is already handling ${customer || "that"}${cell(same.r, col.task) ? ` ("${cell(same.r, col.task)}")` : ""}${cell(same.r, col.due) ? `, due ${cell(same.r, col.due)}` : ""}.`,
        existing: {
          row: same.row,
          id: cell(same.r, col.id) || null,
          task: cell(same.r, col.task),
          customer: cell(same.r, col.customer) || null,
          assignedTo: cell(same.r, col.assignee) || null,
          phone: cell(same.r, col.phone) || null,
          status: cell(same.r, col.status),
          due: cell(same.r, col.due) || null,
        },
      };
    }
  }

  const taskId = `T${rows.length + 1}`;
  const now = services.now();
  const row: string[] = header.map(() => "");
  const put = (c: number, v: string) => {
    if (c >= 0) row[c] = v;
  };
  put(col.id, taskId);
  put(col.task, task);
  put(col.customer, customer);
  put(col.assignee, toText(p.assignee).trim());
  put(col.phone, toText(p.assigneePhone).trim());
  put(col.status, toText(p.initialStatus).trim() || "Open");
  put(col.due, toText(p.due).trim());
  put(col.createdBy, toText(p.createdBy).trim());
  put(col.created, now.toISOString().slice(0, 16).replace("T", " "));
  const res = await callJson(services, {
    method: "POST",
    url: sheetsUrl(id, sheetRange(p.sheet, "A1"), ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),
    headers: { authorization: `Bearer ${accessToken}` },
    body: { values: [row] },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
  const updatedRange = toText((res.body as { updates?: { updatedRange?: string } }).updates?.updatedRange);
  const added = Number(/![A-Z]+(\d+)/.exec(updatedRange)?.[1] ?? NaN);
  return { status: "added", id: taskId, ...rowObject(header, row, Number.isFinite(added) ? added : rows.length + 2) };
};

/** A due date as YYYY-MM-DD, from 2026-11-28, 28/11/2026 (day first), 28-11-2026 or "28 Nov 2026". */
export function dueDay(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today in a time zone, as YYYY-MM-DD. */
function todayIn(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Column picked by name in the step, or the one found automatically. */
function pickColumn(header: string[], name: unknown, auto: number): number {
  const n = toText(name).trim();
  return n ? columnIndex(header, n) : auto;
}

/** Name -> phone from a team tab (Name and Phone columns), for nudging people whose sheet has no phone column. */
async function teamPhones(services: EngineServices, token: string | undefined, id: string, sheet: string): Promise<Map<string, string>> {
  const { header, rows } = await readTable(services, token, id, sheet);
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const name = find("name", "person", "employee", "staff");
  const phone = find("phone", "phone no.", "phone no", "phone number", "mobile", "mobile number", "whatsapp", "number");
  if (name < 0 || phone < 0) throw new StepError(`The "${sheet}" tab needs Name and Phone columns. It has: ${header.filter(Boolean).join(", ")}`);
  return new Map(rows.filter((r) => r[name]?.trim() && r[phone]?.trim()).map((r) => [norm(r[name]!), r[phone]!.trim()]));
}

const DEFAULT_CLOSED = "Done, Closed, Completed, Cancelled, Won, Lost";

const tasksDue: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const found = taskColumns(header);
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const col = {
    ...found,
    task: pickColumn(header, p.taskColumn, found.task),
    customer: pickColumn(header, p.nameColumn, found.customer),
    due: pickColumn(header, p.dueColumn, found.due),
    assignee: pickColumn(header, p.assigneeColumn, found.assignee),
    status: pickColumn(header, p.statusColumn, found.status),
    customerPhone: find("phone no.", "phone no", "phone number", "mobile", "mobile number", "customer phone", "contact number", "contact"),
    notes: find("notes", "note", "remarks", "remark", "comments", "comment"),
  };
  if ((col.task < 0 && col.customer < 0) || col.status < 0 || col.due < 0) {
    throw new StepError(`Couldn't tell which columns hold the task (or name), status and due date. Pick them in the step. The sheet has: ${header.filter(Boolean).join(", ")}`);
  }
  const closed = new Set(
    (toText(p.closedStatuses).trim() || DEFAULT_CLOSED)
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const teamTab = toText(p.phonesFrom).trim();
  const phones = teamTab ? await teamPhones(services, accessToken, id, teamTab) : null;
  let tz = toText(p.timezone).trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new StepError(`"${tz}" isn't a time zone. Use one like Asia/Kolkata.`);
  }
  const today = todayIn(services.now(), tz);
  const which = toText(p.which) || "due";
  const ahead = Math.max(0, Math.floor(toNumber(p.daysAhead ?? 0, "Days ahead")));
  const who = norm(toText(p.assignee));
  const cell = (r: string[], c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");

  const tasks = rows
    .map((r, i) => {
      const due = dueDay(cell(r, col.due));
      const overdueDays = due ? dayDiff(today, due) : null;
      const assignedTo = cell(r, col.assignee) || null;
      const task = cell(r, col.task);
      const customer = cell(r, col.customer) || null;
      return {
        row: i + 2,
        id: cell(r, col.id) || null,
        task,
        customer,
        /** The task, or the name when the sheet has no task column (like a leads list). */
        what: task || customer || "",
        assignedTo,
        phone: cell(r, col.phone) || (assignedTo && phones?.get(norm(assignedTo))) || null,
        customerPhone: cell(r, col.customerPhone) || null,
        notes: cell(r, col.notes) || null,
        status: cell(r, col.status),
        due: cell(r, col.due) || null,
        dueDate: due,
        /** Days past due: 0 = due today, negative = still to come, null = no date. */
        overdueDays,
        createdBy: cell(r, col.createdBy) || null,
      };
    })
    .filter((t) => t.what && !closed.has(t.status.toLowerCase()))
    .filter((t) => !who || norm(t.assignedTo ?? "") === who)
    .filter((t) => {
      if (which === "open") return true;
      if (t.overdueDays === null) return false;
      if (which === "overdue") return t.overdueDays > 0;
      return t.overdueDays >= -ahead;
    })
    .sort((a, b) => (b.overdueDays ?? -9999) - (a.overdueDays ?? -9999));

  const when = (d: number | null) => (d === null ? "no due date" : d > 1 ? `${d} days overdue` : d === 1 ? "1 day overdue" : d === 0 ? "due today" : d === -1 ? "due tomorrow" : `due in ${-d} days`);
  const line = (t: (typeof tasks)[number]) =>
    `• ${t.task || t.customer}${t.task && t.customer ? ` (${t.customer})` : ""}${t.customerPhone ? `, ${t.customerPhone}` : ""}: ${when(t.overdueDays)}${t.status ? `, ${t.status}` : ""}${t.id ? ` [${t.id}]` : ""}`;
  if (p.output === "person") {
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const k = t.assignedTo ?? "Unassigned";
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const max = Math.max(1, Math.floor(toNumber(p.maxPerPerson ?? 15, "Most per person")));
    const people = [...groups].map(([name, list]) => ({
      assignedTo: name,
      phone: list.find((t) => t.phone)?.phone ?? null,
      count: list.length,
      overdue: list.filter((t) => (t.overdueDays ?? -1) > 0).length,
      dueToday: list.filter((t) => t.overdueDays === 0).length,
      today,
      text: [...list.slice(0, max).map(line), ...(list.length > max ? [`…and ${list.length - max} more`] : [])].join("\n"),
      tasks: list,
    }));
    return people.length ? people : { none: true, today };
  }
  if (p.output === "summary") {
    const byPerson: Record<string, number> = {};
    for (const t of tasks) byPerson[t.assignedTo ?? "Unassigned"] = (byPerson[t.assignedTo ?? "Unassigned"] ?? 0) + 1;
    const lines = tasks.map((t) => `• ${t.assignedTo ?? "Unassigned"}: ${t.task || t.customer}${t.task && t.customer ? ` (${t.customer})` : ""}, ${when(t.overdueDays)}${t.id ? ` [${t.id}]` : ""}`);
    return {
      today,
      count: tasks.length,
      overdue: tasks.filter((t) => (t.overdueDays ?? -1) > 0).length,
      dueToday: tasks.filter((t) => t.overdueDays === 0).length,
      byPerson,
      tasks,
      text: tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}:\n${lines.join("\n")}` : "Nothing due. All clear.",
    };
  }
  return tasks.length ? tasks.map((t) => ({ ...t, when: when(t.overdueDays) })) : { none: true, today };
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


// ---------------------------------------------------------------------------
// Team operations on a sheet: rules as text, an activity log, follow-up questions
// ---------------------------------------------------------------------------

/** A short local time like 26-11-26 14:05 (the sheet's own date style), in the server's time zone. */
function localStamp(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

/** Machine-readable local time for "next reminder" (read back by the same server). */
function localIso(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 16).replace("T", " ");
}
/**
 * Reads a local time back: our own "2026-11-26 15:05", or the way Google Sheets
 * shows a date it recognised ("26/11/2026 15:05:00", "26-11-26 15:05", "11/26/2026 15:05").
 */
export function fromLocalIso(v: string): number | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime();
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})[ ,T]+(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    let day = +m[1]!;
    let month = +m[2]!;
    // A US-style sheet shows month first; a day can't be over 12, so swap when that's clearly the case.
    if (month > 12 && day <= 12) [day, month] = [month, day];
    const year = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return new Date(year, month - 1, day, +m[4]!, +m[5]!).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Appends one row, filling columns by their header names; other columns stay untouched. */
async function appendByHeader(services: EngineServices, token: string | undefined, id: string, sheet: unknown, values: Record<string, string>) {
  // RAW: written exactly as given, so times and phone numbers (+91…) aren't turned into dates or numbers.
  const header = await readHeader(services, token, id, sheet);
  const row: Array<string | null> = header.map((h) => {
    const k = Object.keys(values).find((x) => x.toLowerCase() === h.trim().toLowerCase());
    return k === undefined ? null : values[k]!;
  });
  if (!row.some((v) => v !== null)) throw new StepError(`The "${String(sheet)}" tab needs the columns ${Object.keys(values).join(", ")}`);
  const res = await callJson(services, {
    method: "POST",
    url: sheetsUrl(id, sheetRange(sheet, "A1"), ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"),
    headers: { authorization: `Bearer ${token}` },
    body: { values: [row] },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
}

/**
 * Writes one line to an activity tab (When, Who, Tab, Row, Name, Change) after a
 * sheet change. Never fails the change itself: a missing tab is just skipped.
 */
async function logActivity(services: EngineServices, token: string | undefined, id: string, p: Json, entry: { row: number | null; name: string; change: string }) {
  const tab = toText(p.activitySheet).trim();
  if (!tab || !entry.change) return;
  try {
    await appendByHeader(services, token, id, tab, {
      When: localStamp(services.now()),
      Who: toText(p.activityBy).trim() || "Bot",
      Tab: toText(p.sheet).trim(),
      Row: entry.row ? String(entry.row) : "",
      Name: entry.name,
      Change: entry.change.slice(0, 1000),
    });
  } catch {
    /* the log is a nice-to-have */
  }
}

/** The first cell that looks like a name in a row, for the activity log. */
function nameOf(header: string[], cells: Array<string | null>): string {
  const i = header.findIndex((h) => /name|customer|client|firm/i.test(h) && (cells[header.indexOf(h)] ?? "").trim());
  return i >= 0 ? (cells[i] ?? "").trim() : (cells.find((c) => (c ?? "").trim()) ?? "").trim();
}

const textCache = new Map<string, { at: number; value: Json }>();

/** A whole tab as plain text (rules, notes, a price list), for an AI step's instructions. Kept for a few minutes. */
const sheetsText: AppAction = async (p, services) => {
  const id = spreadsheetIdOf(p.spreadsheetId);
  const key = `${toText(p.credential)}|${id}|${toText(p.sheet)}`;
  const keepMs = Math.max(0, toNumber(p.cacheMinutes ?? 10, "Keep for")) * 60_000;
  const hit = textCache.get(key);
  if (hit && services.now().getTime() - hit.at < keepMs) return hit.value;
  const { accessToken } = await account(p, "google", services);
  let value: Json;
  try {
    const { header, rows } = await readTable(services, accessToken, id, p.sheet, 2000);
    const used = header.map((h, i) => (h.trim() || rows.some((r) => (r[i] ?? "").trim()) ? i : -1)).filter((i) => i >= 0);
    const lines = rows
      .filter((r) => r.some((c) => c.trim()))
      .map((r) => (used.length === 1 ? `- ${r[used[0]!]!.trim()}` : `- ${used.filter((i) => (r[i] ?? "").trim()).map((i) => `${header[i] || `Column ${i + 1}`}: ${r[i]!.trim()}`).join("; ")}`));
    const title = used.length === 1 && header[used[0]!]?.trim() ? `${header[used[0]!]!.trim()}:\n` : "";
    value = { text: lines.length ? `${title}${lines.join("\n")}` : "", lines: lines.length, missing: false };
  } catch (e) {
    if (p.ifMissing !== "empty") throw e;
    value = { text: "", lines: 0, missing: true };
  }
  textCache.set(key, { at: services.now().getTime(), value });
  if (textCache.size > 200) textCache.delete(textCache.keys().next().value!);
  return value;
};

const FU = ["ID", "Asked At", "Person", "Phone", "About", "Question", "Status", "Reminders", "Next Reminder", "Answer"] as const;

function followupColumns(header: string[]) {
  const at = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const col = Object.fromEntries(FU.map((n) => [n, at(n)])) as Record<(typeof FU)[number], number>;
  const missing = FU.filter((n) => col[n] < 0);
  if (missing.length) throw new StepError(`The follow-ups tab needs these columns: ${FU.join(", ")}. Missing: ${missing.join(", ")}`);
  return col;
}

/** Sends one WhatsApp message and puts it in the person's shared memory, so their reply is understood. */
async function sendAndRemember(services: EngineServices, waCredential: string, to: string, text: string, label: string) {
  const w = integrations(services).whatsappWeb;
  if (!w) throw new StepError("WhatsApp (linked phone) isn't available on this server");
  const r = await w.send(waCredential, { to, text });
  const key = r.chatId.split("@")[0]!.split(":")[0]!;
  if (services.memory && key && !r.chatId.endsWith("@g.us")) await services.memory.append(SHARED_MEMORY, key, [{ role: "assistant", text: `[${label}] ${text}` }], 10);
  return r;
}

async function setCells(services: EngineServices, token: string | undefined, id: string, sheet: unknown, row: number, cells: Array<[number, string]>) {
  if (!cells.length) return;
  const res = await callJson(services, {
    method: "POST",
    url: `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
    headers: { authorization: `Bearer ${token}` },
    body: { valueInputOption: "RAW", data: cells.map(([c, v]) => ({ range: sheetRange(sheet, `${columnLetter(c)}${row}`), values: [[v]] })) },
  });
  if (res.status >= 400) throw googleError(res, "Google Sheets");
}

/** Ask someone a question on WhatsApp and keep track of it until they answer. */
const followupAsk: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const col = followupColumns(header);
  const person = toText(p.person).trim();
  const about = toText(p.about).trim();
  const question = toText(p.question).trim();
  if (!question) throw new StepError("The question is empty");
  let phone = toText(p.phone).trim();
  if (!phone && person && toText(p.phonesFrom).trim()) phone = (await teamPhones(services, accessToken, id, toText(p.phonesFrom).trim())).get(norm(person)) ?? "";
  if (!phone) throw new StepError(`No phone number for ${person || "that person"}. Add it to the Team tab.`);
  const cell = (r: string[], c: number) => (r[c] ?? "").trim();
  // Already asked about this and still waiting: don't ask twice.
  const open = rows.find((r) => cell(r, col.Status).toLowerCase() === "waiting" && cellMatches(cell(r, col.Phone), phone, "phone") && (!about || norm(cell(r, col.About)) === norm(about)));
  if (open) return { status: "already_waiting", id: cell(open, col.ID), askedAt: cell(open, col["Asked At"]), question: cell(open, col.Question) };
  const waitMin = Math.max(5, toNumber(p.waitMinutes ?? 60, "Wait"));
  const sent = await sendAndRemember(services, toText(p.whatsapp), phone, question, toText(p.label).trim() || "Follow-up question");
  const now = services.now();
  const fid = `F${rows.length + 1}`;
  await appendByHeader(services, accessToken, id, p.sheet, {
    ID: fid,
    "Asked At": localStamp(now),
    Person: person,
    Phone: phone,
    About: about,
    Question: question,
    Status: "Waiting",
    Reminders: "0",
    "Next Reminder": localIso(new Date(now.getTime() + waitMin * 60_000)),
    Answer: "",
  });
  return { status: "asked", id: fid, person, phone, about, messageId: sent.messageId };
};

/** Every so often: re-ask the ones still waiting, and give up (for the owner to see) after a few reminders. */
const followupRemind: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  const { header, rows } = await readTable(services, accessToken, id, p.sheet);
  const col = followupColumns(header);
  const max = Math.max(0, Math.floor(toNumber(p.maxReminders ?? 2, "Reminders")));
  const waitMin = Math.max(5, toNumber(p.waitMinutes ?? 60, "Wait"));
  const now = services.now();
  const out: Json[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const cell = (c: number) => (r[c] ?? "").trim();
    if (cell(col.Status).toLowerCase() !== "waiting") continue;
    const next = fromLocalIso(cell(col["Next Reminder"]));
    if (next !== null && next > now.getTime()) continue;
    const done = Number(cell(col.Reminders)) || 0;
    const info = { id: cell(col.ID), person: cell(col.Person), phone: cell(col.Phone), about: cell(col.About), question: cell(col.Question), askedAt: cell(col["Asked At"]), reminders: done, row: i + 2 };
    if (done < max) {
      try {
        await sendAndRemember(services, toText(p.whatsapp), info.phone, `${toText(p.reminderPrefix).trim() || "Reminder:"} ${info.question}`, toText(p.label).trim() || "Follow-up reminder");
      } catch (e) {
        out.push({ action: "failed", error: (e as Error).message, ...info });
        continue;
      }
      await setCells(services, accessToken, id, p.sheet, i + 2, [
        [col.Reminders, String(done + 1)],
        [col["Next Reminder"], localIso(new Date(now.getTime() + waitMin * 60_000))],
      ]);
      out.push({ action: "reminded", ...info, reminders: done + 1 });
    } else {
      await setCells(services, accessToken, id, p.sheet, i + 2, [[col.Status, "No reply"]]);
      out.push({ action: "gave_up", ...info });
    }
  }
  return out.length ? out : { none: true };
};

/** When someone writes in: their open questions count as answered (their message is the answer). */
const followupAnswered: AppAction = async (p, services) => {
  const { accessToken } = await account(p, "google", services);
  const id = spreadsheetIdOf(p.spreadsheetId);
  let table: { header: string[]; rows: string[][] };
  try {
    table = await readTable(services, accessToken, id, p.sheet);
  } catch (e) {
    if (p.ifMissing === "empty") return { marked: 0, about: [] };
    throw e;
  }
  const col = followupColumns(table.header);
  const phone = toText(p.phone).trim();
  if (!phone) return { marked: 0, about: [] };
  const answer = toText(p.answer).trim().slice(0, 300);
  const about: string[] = [];
  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i]!;
    if ((r[col.Status] ?? "").trim().toLowerCase() !== "waiting" || !cellMatches(r[col.Phone] ?? "", phone, "phone")) continue;
    await setCells(services, accessToken, id, p.sheet, i + 2, [
      [col.Status, "Answered"],
      [col.Answer, answer],
    ]);
    about.push((r[col.About] ?? "").trim() || (r[col.Question] ?? "").trim());
  }
  return { marked: about.length, about };
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
  "app.sheets.text": sheetsText,
  "app.followups.ask": followupAsk,
  "app.followups.remind": followupRemind,
  "app.followups.answered": followupAnswered,
  "app.sheets.read": sheetsRead,
  "app.sheets.find": sheetsFind,
  "app.tasks.add": tasksAdd,
  "app.tasks.due": tasksDue,
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
