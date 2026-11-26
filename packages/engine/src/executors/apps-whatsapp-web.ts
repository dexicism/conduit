import type { EngineServices, IntegrationServices } from "../types";
import { SHARED_MEMORY, StepError } from "../types";
import { buildPdf } from "../pdf";
import { toText } from "../values";
import { docInputOf, pdfName } from "./documents";

type Json = Record<string, unknown>;
type Action = (p: Json, services: EngineServices) => Promise<Json | Json[]>;

function wa(services: EngineServices): NonNullable<IntegrationServices["whatsappWeb"]> {
  const w = services.integrations?.whatsappWeb;
  if (!w) throw new StepError("WhatsApp (linked phone) isn't available on this server");
  return w;
}

function credentialId(p: Json): string {
  const id = toText(p.credential);
  if (!id) throw new StepError("Choose a linked WhatsApp number");
  return id;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

/**
 * "Add to the person's shared memory": the assistant that reads their reply then
 * knows what was asked. Keyed by the phone number (digits), like the trigger's `from`.
 */
async function rememberSent(p: Json, services: EngineServices, chatId: string, text: string, fileName: string | null) {
  if (!p.shareInChat || !services.memory || chatId.endsWith("@g.us")) return;
  const key = chatId.split("@")[0]!.split(":")[0]!;
  const label = toText(p.shareLabel).trim() || "Message sent to them";
  const what = [text.trim(), fileName ? `(file: ${fileName})` : ""].filter(Boolean).join(" ");
  if (key && what) await services.memory.append(SHARED_MEMORY, key, [{ role: "assistant", text: `[${label}] ${what}` }], 10);
}

/** Text, or a file (a photo/document someone sent, or base64 from another step), to a person or group. */
const send: Action = async (p, services) => {
  const id = credentialId(p);
  const to = toText(p.to).trim();
  if (!to) throw new StepError("To is empty. Use a phone number or a chat id (e.g. the trigger's chatId).");
  const text = toText(p.text);
  let file: { base64: string; mimetype: string; fileName: string | null } | null = null;
  const source = toText(p.fileSource) || "none";
  if (source === "media") {
    const mediaId = toText(p.mediaId).trim();
    if (!mediaId) throw new StepError("Media ID is empty");
    const m = await wa(services).readMedia(mediaId);
    if (!m) throw new StepError("That file isn't stored anymore (files are kept for 30 days) or belongs to another workspace");
    file = { base64: m.base64, mimetype: m.mimetype, fileName: toText(p.fileName) || m.fileName };
  } else if (source === "base64") {
    const raw = toText(p.fileBase64).replace(/^data:[^;]+;base64,/, "").trim();
    if (!raw) throw new StepError("The file content is empty");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new StepError("The file content isn't base64");
    const fileName = toText(p.fileName).trim() || "file";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    file = { base64: raw, mimetype: toText(p.mimetype).trim() || MIME_BY_EXT[ext] || "application/octet-stream", fileName };
  }
  if (!text.trim() && !file) throw new StepError("Nothing to send: write some text or attach a file");
  if (text.length > 65_000) throw new StepError("That message is too long for WhatsApp");
  try {
    const r = await wa(services).send(id, { to, text, file });
    await rememberSent(p, services, r.chatId, text, file?.fileName ?? null);
    return { messageId: r.messageId, chatId: r.chatId, sentFile: file ? file.fileName : null };
  } catch (e) {
    throw new StepError((e as Error).message);
  }
};

// ---------------------------------------------------------------------------
// When: "2026-11-28 09:00", "tomorrow 9am", "in 2 hours", or an ISO time
// ---------------------------------------------------------------------------

/** How far `tz` is ahead of UTC at `at`, in ms. */
function zoneOffset(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at.getTime() / 1000) * 1000;
}

/** A wall-clock time in `tz` as a real instant. */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffset(new Date(guess), tz);
  return new Date(guess - zoneOffset(new Date(first), tz));
}

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new StepError(`"${tz}" isn't a time zone. Use one like Asia/Kolkata.`);
  }
}

const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 604_800_000, week: 604_800_000 };

/** Parses when to send. Times without a zone are read in `tz`. */
export function parseWhen(text: string, now: Date, tz: string): Date {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) throw new StepError("When is empty");
  const rel = /^in (\d+(?:\.\d+)?) ?(m|min|minute|h|hr|hour|d|day|w|week)s?$/.exec(s);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * UNIT_MS[rel[2]!]!);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text.trim()) && /^\d{4}-\d{2}-\d{2}t/i.test(text.trim())) {
    const d = new Date(text.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  const local = new Date(now.getTime() + zoneOffset(now, tz));
  const today = { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
  const clock = (h: string | undefined, mi: string | undefined, ap: string | undefined) => {
    let hour = h === undefined ? 9 : Number(h);
    const min = mi === undefined ? 0 : Number(mi);
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (hour > 23 || min > 59) throw new StepError(`"${text}" isn't a valid time`);
    return { hour, min };
  };
  const date = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2})(?::(\d{2}))? ?(am|pm)?)?$/.exec(s);
  if (date) {
    const t = clock(date[4], date[5], date[6]);
    return wallTime(Number(date[1]), Number(date[2]), Number(date[3]), t.hour, t.min, tz);
  }
  const day = /^(today|tomorrow)(?: (?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)?)?$/.exec(s);
  if (day) {
    const t = clock(day[2], day[3], day[4]);
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + (day[1] === "tomorrow" ? 1 : 0)));
    return wallTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), t.hour, t.min, tz);
  }
  throw new StepError(`Couldn't read "${text}" as a time. Use 2026-11-28 09:00, tomorrow 9am, or in 2 hours.`);
}

const schedule: Action = async (p, services) => {
  const id = credentialId(p);
  const to = toText(p.to).trim();
  if (!to) throw new StepError("To is empty");
  const text = toText(p.text);
  if (!text.trim()) throw new StepError("The message is empty");
  const tz = validZone(toText(p.timezone).trim() || serverTimeZone());
  const now = services.now();
  const dueAt = parseWhen(toText(p.when), now, tz);
  if (dueAt.getTime() < now.getTime() - 60_000) throw new StepError(`That time (${dueAt.toISOString()}) is in the past`);
  if (dueAt.getTime() > now.getTime() + 366 * 86_400_000) throw new StepError("Reminders can be at most a year ahead");
  try {
    const r = await wa(services).schedule(id, { to, text, dueAt, createdBy: toText(p.createdBy).trim() || null });
    return { reminderId: r.id, to: r.to, dueAt: r.dueAt, dueLocal: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(dueAt), timezone: tz };
  } catch (e) {
    throw new StepError((e as Error).message);
  }
};

const reminders: Action = async (p, services) => {
  const id = credentialId(p);
  if (p.action === "cancel") {
    const reminderId = toText(p.reminderId).trim();
    if (!reminderId) throw new StepError("Which reminder? The reminder ID is empty.");
    const ok = await wa(services).cancelReminder(reminderId);
    return { canceled: ok, reminderId, ...(ok ? {} : { message: "No pending reminder with that ID (already sent or canceled?)" }) };
  }
  const list = await wa(services).reminders(id, { to: toText(p.to).trim() || null });
  return list.length ? list.map((r) => ({ found: true, ...r })) : { found: false };
};

/** Splits "a, b; c" / lines / a JSON array into numbers. */
function numberList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => toText(typeof x === "object" && x ? ((x as Record<string, unknown>).phone ?? (x as Record<string, unknown>).Phone ?? "") : x));
  const s = toText(v).trim();
  if (s.startsWith("[")) {
    try {
      return numberList(JSON.parse(s));
    } catch {
      /* fall through */
    }
  }
  return s.split(/[\n,;]+/).map((x) => x.trim());
}

const broadcast: Action = async (p, services) => {
  const id = credentialId(p);
  const numbers = numberList(p.numbers).filter(Boolean);
  if (!numbers.length) throw new StepError("No phone numbers to send to");
  const text = toText(p.text);
  if (!text.trim()) throw new StepError("The message is empty");
  const min = Math.max(2, Number(toText(p.minGapSeconds) || 5));
  const max = Math.max(min, Number(toText(p.maxGapSeconds) || 15));
  try {
    return await wa(services).broadcast(id, { numbers, text, spacingMs: [min * 1000, max * 1000] });
  } catch (e) {
    throw new StepError((e as Error).message);
  }
};

/** Builds a PDF (quotation, invoice, list) and sends it, in one step. */
const sendDocument: Action = async (p, services) => {
  const id = credentialId(p);
  const to = toText(p.to).trim();
  if (!to) throw new StepError("To is empty");
  const input = docInputOf(p);
  const pdf = await buildPdf(input);
  const fileName = pdfName(p.fileName, input.title);
  try {
    const r = await wa(services).send(id, { to, text: toText(p.caption), file: { base64: pdf.base64, mimetype: "application/pdf", fileName } });
    await rememberSent(p, services, r.chatId, toText(p.caption), fileName);
    return { messageId: r.messageId, chatId: r.chatId, fileName, pages: pdf.pages, total: pdf.total, ...(pdf.replaced.length ? { replacedCharacters: pdf.replaced } : {}) };
  } catch (e) {
    throw new StepError((e as Error).message);
  }
};

/** A stored photo or file as base64, e.g. to hand to an AI step or save to Drive. */
const getMedia: Action = async (p, services) => {
  const mediaId = toText(p.mediaId).trim();
  if (!mediaId) throw new StepError("Media ID is empty");
  const m = await wa(services).readMedia(mediaId);
  if (!m) throw new StepError("That file isn't stored anymore (files are kept for 30 days) or belongs to another workspace");
  return { mediaId, mimetype: m.mimetype, fileName: m.fileName, size: m.size, base64: m.base64 };
};

/** The groups the linked number is in, one item each. Handy for finding a group's chat id. */
const STATUS_TEXT: Record<string, string> = {
  open: "connected",
  starting: "starting up",
  reconnecting: "trying to reconnect",
  qr: "waiting for the QR code to be scanned",
  logged_out: "logged out (link the phone again under Connected apps)",
  idle: "not linked",
};

/** Is the number connected? `alert` is true once it's been down for a while, with a key that changes per outage. */
const status: Action = async (p, services) => {
  const id = credentialId(p);
  const s = await wa(services).status(id);
  const now = services.now().getTime();
  const sinceMs = s.since ? Date.parse(s.since) : now;
  const ok = s.status === "open" && s.workerRunning;
  const downMinutes = ok ? 0 : Math.max(0, Math.round((now - sinceMs) / 60_000));
  const waitMin = Math.max(0, Number(p.alertAfterMinutes ?? 10) || 0);
  const what = !s.workerRunning ? "not running (is Conduit's worker up?)" : (STATUS_TEXT[s.status] ?? s.status);
  return {
    ok,
    status: s.status,
    workerRunning: s.workerRunning,
    phone: s.phone,
    error: s.error,
    since: s.since,
    downMinutes,
    alert: !ok && downMinutes >= waitMin,
    /** Same for the whole outage, so "only new" sends one alert per outage. */
    outageKey: ok ? null : `${s.status}|${s.since ?? ""}`,
    text: ok ? `WhatsApp ${s.phone ? `+${s.phone} ` : ""}is connected.` : `WhatsApp ${s.phone ? `+${s.phone} ` : ""}is ${what}${downMinutes ? ` for ${downMinutes} min` : ""}.${s.error ? ` (${s.error})` : ""}`,
  };
};

const groups: Action = async (p, services) => {
  const list = await wa(services).groups(credentialId(p));
  const filter = toText(p.nameContains).trim().toLowerCase();
  return list.filter((g) => !filter || g.name.toLowerCase().includes(filter)).map((g) => ({ chatId: g.id, name: g.name, members: g.members }));
};

export const WHATSAPP_WEB_ACTIONS: Record<string, Action> = {
  "app.whatsappWeb.send": send,
  "app.whatsappWeb.getMedia": getMedia,
  "app.whatsappWeb.groups": groups,
  "app.whatsappWeb.status": status,
  "app.whatsappWeb.schedule": schedule,
  "app.whatsappWeb.reminders": reminders,
  "app.whatsappWeb.broadcast": broadcast,
  "app.whatsappWeb.sendDocument": sendDocument,
};
