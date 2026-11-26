import { workflowGraphSchema } from "@conduit/core";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Binary, MongoServerError, ObjectId, type Db } from "mongodb";
import type { Integrations } from "./integrations";
import type { Runtime, StartInput } from "./runtime";
import { collections } from "./store";

/**
 * WhatsApp on a normal number, linked like WhatsApp Web (scan a QR code once).
 *
 * This isn't Meta's official business API: there are no templates and no 24-hour
 * window, and it works in groups. The trade-off is that WhatsApp can ban numbers
 * it thinks are automated, and its updates sometimes break the link for a while.
 *
 * One process owns each linked number (a lease in `whatsapp_web_sessions`), so
 * several workers never open the same session twice. Steps send through the
 * `whatsapp_web_outbox` collection, which the owner works through in order.
 */

// ---------------------------------------------------------------------------
// The socket we need from Baileys (small, so tests can fake it)
// ---------------------------------------------------------------------------

export interface WaKey {
  id?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
}

export interface WaMessage {
  key: WaKey;
  message?: Record<string, any> | null;
  pushName?: string | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

export interface WaSocket {
  ev: Pick<EventEmitter, "on" | "off">;
  user?: { id: string; lid?: string; name?: string } | null;
  sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ key: WaKey } | undefined>;
  sendPresenceUpdate?(type: "composing" | "paused" | "available", jid?: string): Promise<void>;
  readMessages?(keys: WaKey[]): Promise<void>;
  groupMetadata(jid: string): Promise<{ id: string; subject: string; participants: Array<{ id: string }> }>;
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string; participants: Array<{ id: string }> }>>;
  downloadMedia(msg: WaMessage): Promise<Buffer>;
  logout(): Promise<void>;
  end(err?: Error): void;
}

/** Opens a socket with the auth files in `authDir`. Connection events arrive on `ev`. */
export type WaSocketFactory = (authDir: string) => Promise<WaSocket>;

const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

/** The real thing, through Baileys. Loaded lazily: it's ESM-only and fairly big. */
export const baileysSocketFactory: WaSocketFactory = async (authDir) => {
  const b = await import("baileys");
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  const version = await b
    .fetchLatestBaileysVersion()
    .then((v) => v.version)
    .catch(() => undefined);
  const sock = b.makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: silentLogger as never,
    browser: b.Browsers.windows("Conduit"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);
  const s = sock as unknown as WaSocket;
  s.downloadMedia = async (msg) =>
    (await b.downloadMediaMessage(msg as never, "buffer", {}, { logger: silentLogger as never, reuploadRequest: sock.updateMediaMessage })) as Buffer;
  return s;
};

// ---------------------------------------------------------------------------
// Turning a WhatsApp message into a run item
// ---------------------------------------------------------------------------

export interface WhatsappWebItem {
  messageId: string;
  /** Where to reply: the group, or the person in a private chat. */
  chatId: string;
  isGroup: boolean;
  groupName: string | null;
  /** The sender's phone number, digits only (null when WhatsApp hides it). */
  from: string | null;
  fromName: string | null;
  text: string | null;
  type: string;
  media: { id: string; mimetype: string; fileName: string | null; size: number } | null;
  location: { latitude: number; longitude: number; name: string | null } | null;
  mentionsMe: boolean;
  /** The text of the message this one replies to, if any. */
  quotedText: string | null;
  timestamp: string | null;
}

const MEDIA_TYPES = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"] as const;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Unwraps disappearing / view-once / captioned-document wrappers. */
export function unwrapMessage(m: Record<string, any> | null | undefined): Record<string, any> {
  let cur = m ?? {};
  for (let i = 0; i < 5; i++) {
    const inner =
      cur.ephemeralMessage?.message ??
      cur.viewOnceMessage?.message ??
      cur.viewOnceMessageV2?.message ??
      cur.viewOnceMessageV2Extension?.message ??
      cur.documentWithCaptionMessage?.message ??
      cur.editedMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

const userPart = (jid: string | null | undefined) => (jid ? jid.split("@")[0]!.split(":")[0]! : "");

/** Phone number from a jid, preferring the "alt" one: newer WhatsApp hides numbers behind @lid ids. */
export function phoneOf(jid?: string | null, alt?: string | null): string | null {
  for (const j of [alt, jid]) if (j && j.endsWith("@s.whatsapp.net")) return userPart(j);
  return null;
}

/** A phone number (any format) or a chat id, as a jid WhatsApp accepts. */
/**
 * A WhatsApp chat id from a phone number or chat id. Numbers written without a
 * country code (like 9812345678 or 09812345678, as sheets often have them) get
 * `countryCode` in front; without one they're refused rather than sent to the
 * wrong person. A cell with several numbers ("98123 45678 | 98111 12222") uses
 * the first.
 */
export function toJid(to: string, countryCode?: string | null): string {
  const t = to.trim();
  if (/@(g\.us|s\.whatsapp\.net|lid)$/.test(t)) return t;
  const first = t.split(/\s*(?:[|,;/]|\bor\b)\s*/i).find((p) => p.trim()) ?? "";
  if (/[^\d\s()+.-]/.test(first)) throw new Error(`"${to}" isn't a phone number (use international format, e.g. +919876543210) or a chat id`);
  let digits = first.replace(/\D/g, "");
  if (!first.trim().startsWith("+")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0") || (digits.length >= 6 && digits.length <= 10)) {
      const cc = (countryCode ?? "").replace(/\D/g, "");
      if (!cc) throw new Error(`"${to}" has no country code. Write it like +919876543210, or set "Country code" on this WhatsApp connection.`);
      digits = cc + digits.replace(/^0+/, "");
    }
  }
  if (!/^\d{7,15}$/.test(digits)) throw new Error(`"${to}" isn't a phone number (use international format, e.g. +919876543210) or a chat id`);
  return `${digits}@s.whatsapp.net`;
}

export function messageType(m: Record<string, any>): string {
  if (m.conversation || m.extendedTextMessage) return "text";
  for (const t of MEDIA_TYPES) if (m[t]) return t.replace("Message", "");
  if (m.locationMessage || m.liveLocationMessage) return "location";
  if (m.contactMessage || m.contactsArrayMessage) return "contact";
  if (m.reactionMessage) return "reaction";
  if (m.pollCreationMessage || m.pollCreationMessageV3) return "poll";
  return Object.keys(m)[0]?.replace(/Message$/, "") ?? "unknown";
}

export function messageText(m: Record<string, any>): string | null {
  const loc = m.locationMessage ?? m.liveLocationMessage;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    (loc ? [loc.name, loc.address].filter(Boolean).join(", ") || null : null) ??
    null
  );
}

function contextInfo(m: Record<string, any>): Record<string, any> | undefined {
  for (const v of Object.values(m)) if (v && typeof v === "object" && v.contextInfo) return v.contextInfo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export type WaSessionStatus = "idle" | "starting" | "qr" | "open" | "reconnecting" | "logged_out";

export interface WaSessionDoc {
  _id?: ObjectId;
  credentialId: string;
  workspaceId: ObjectId;
  status: WaSessionStatus;
  qr: string | null;
  phone: string | null;
  name: string | null;
  error: string | null;
  /** Set by "Link phone": start a session even without saved login files. */
  linkRequestedAt: Date | null;
  /** Set by "Unlink": log out on the phone and forget the login. */
  unlinkRequestedAt?: Date | null;
  groups?: Array<{ id: string; name: string; members: number }>;
  ownerId: string | null;
  lockedUntil: Date | null;
  updatedAt: Date;
}

export interface WaOutboxDoc {
  _id?: ObjectId;
  credentialId: string;
  workspaceId: ObjectId;
  to: string;
  text: string | null;
  file: { data: Binary; mimetype: string; fileName: string | null } | null;
  status: "pending" | "sending" | "sent" | "failed";
  /** Don't send before this (spacing out a "send to everyone"). */
  notBefore?: Date | null;
  /** Set for messages that came from a reminder or a broadcast. */
  source?: "reminder" | "broadcast" | null;
  result: { messageId: string; chatId: string } | null;
  error: string | null;
  createdAt: Date;
}

/** A message to send later ("remind the owner on Friday about GST"). */
export interface ReminderDoc {
  _id?: ObjectId;
  workspaceId: ObjectId;
  credentialId: string;
  to: string;
  text: string;
  dueAt: Date;
  status: "pending" | "sent" | "canceled";
  createdBy: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface MediaFileDoc {
  _id?: ObjectId;
  workspaceId: ObjectId;
  mimetype: string;
  fileName: string | null;
  size: number;
  data: Binary;
  createdAt: Date;
}

export function whatsappWebCollections(db: Db) {
  return {
    sessions: db.collection<WaSessionDoc>("whatsapp_web_sessions"),
    outbox: db.collection<WaOutboxDoc>("whatsapp_web_outbox"),
    media: db.collection<MediaFileDoc>("media_files"),
    reminders: db.collection<ReminderDoc>("whatsapp_web_reminders"),
  };
}

export async function ensureWhatsappWebIndexes(db: Db) {
  const c = whatsappWebCollections(db);
  await Promise.all([
    c.sessions.createIndex({ credentialId: 1 }, { unique: true }),
    c.outbox.createIndex({ credentialId: 1, status: 1, createdAt: 1 }),
    c.reminders.createIndex({ status: 1, dueAt: 1 }),
    c.reminders.createIndex({ workspaceId: 1, credentialId: 1, status: 1, dueAt: 1 }),
    // Sent and canceled reminders are forgotten after 30 days.
    c.reminders.createIndex({ sentAt: 1 }, { expireAfterSeconds: 30 * 86_400 }),
    c.outbox.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
    // Photos and files people send are kept for 30 days.
    c.media.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 }),
  ]);
}

// ---------------------------------------------------------------------------
// Used by steps (any process): send through the outbox, read stored media
// ---------------------------------------------------------------------------

export interface WaSendInput {
  to: string;
  text?: string | null;
  file?: { base64: string; mimetype: string; fileName?: string | null } | null;
}

/** Queues a message for the process that owns the session and waits for the result. */
export async function sendWhatsappWeb(
  db: Db,
  workspaceId: ObjectId,
  credentialId: string,
  input: WaSendInput,
  opts: { timeoutMs?: number; pollMs?: number; countryCode?: string | null } = {},
): Promise<{ messageId: string; chatId: string }> {
  const c = whatsappWebCollections(db);
  const session = await c.sessions.findOne({ credentialId, workspaceId });
  if (!session || session.status === "logged_out" || session.status === "idle") {
    throw new Error("This WhatsApp number isn't linked. Open Connected apps and link the phone first.");
  }
  const to = toJid(input.to, opts.countryCode);
  const file = input.file ? { data: new Binary(Buffer.from(input.file.base64, "base64")), mimetype: input.file.mimetype, fileName: input.file.fileName ?? null } : null;
  if (file && file.data.length() > MAX_MEDIA_BYTES) throw new Error("Files can be at most 10 MB");
  if (!input.text?.trim() && !file) throw new Error("Nothing to send: add text or a file");
  const { insertedId } = await c.outbox.insertOne({
    credentialId,
    workspaceId,
    to,
    text: input.text?.trim() ? input.text : null,
    file,
    status: "pending",
    result: null,
    error: null,
    createdAt: new Date(),
  });
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const doc = await c.outbox.findOne({ _id: insertedId }, { projection: { status: 1, result: 1, error: 1 } });
    if (doc?.status === "sent" && doc.result) return doc.result;
    if (doc?.status === "failed") throw new Error(`WhatsApp: ${doc.error ?? "sending failed"}`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
  }
  // Don't let it go out late after we've already reported a failure.
  await c.outbox.updateOne({ _id: insertedId, status: "pending" }, { $set: { status: "failed", error: "timed out" } });
  throw new Error("WhatsApp didn't send the message in time. Is the phone linked and Conduit's worker running?");
}

export async function readMediaFile(db: Db, workspaceId: ObjectId, id: string): Promise<{ base64: string; mimetype: string; fileName: string | null; size: number } | null> {
  if (!ObjectId.isValid(id)) return null;
  const doc = await whatsappWebCollections(db).media.findOne({ _id: new ObjectId(id), workspaceId });
  if (!doc) return null;
  return { base64: Buffer.from(doc.data.buffer).toString("base64"), mimetype: doc.mimetype, fileName: doc.fileName, size: doc.size };
}

/** Saves a message to send at `dueAt`. The worker that holds the number sends it then (or as soon as it's back, if it was off). */
export async function scheduleWhatsappWeb(db: Db, workspaceId: ObjectId, credentialId: string, input: { to: string; text: string; dueAt: Date; createdBy?: string | null; countryCode?: string | null }) {
  const to = toJid(input.to, input.countryCode);
  const text = input.text.trim();
  if (!text) throw new Error("The message is empty");
  const { insertedId } = await whatsappWebCollections(db).reminders.insertOne({
    workspaceId,
    credentialId,
    to,
    text,
    dueAt: input.dueAt,
    status: "pending",
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
    sentAt: null,
  });
  return { id: insertedId.toHexString(), to, dueAt: input.dueAt.toISOString() };
}

export async function listWhatsappWebReminders(db: Db, workspaceId: ObjectId, credentialId: string, filter: { to?: string | null } = {}) {
  const q: Record<string, unknown> = { workspaceId, credentialId, status: "pending" };
  if (filter.to?.trim()) {
    // Match on the end of the number, so it works with or without the country code.
    const d = filter.to.replace(/\D/g, "").replace(/^0+/, "");
    q.to = d.length >= 6 ? { $regex: `${d}@s\\.whatsapp\\.net$` } : toJid(filter.to);
  }
  const docs = await whatsappWebCollections(db).reminders.find(q).sort({ dueAt: 1 }).limit(100).toArray();
  return docs.map((d) => ({ id: d._id!.toHexString(), to: d.to, text: d.text, dueAt: d.dueAt.toISOString(), createdBy: d.createdBy }));
}

export async function cancelWhatsappWebReminder(db: Db, workspaceId: ObjectId, id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const r = await whatsappWebCollections(db).reminders.updateOne({ _id: new ObjectId(id), workspaceId, status: "pending" }, { $set: { status: "canceled", sentAt: new Date() } });
  return r.modifiedCount === 1;
}

/**
 * The same message to many people, spaced out by a random gap so it doesn't
 * look like a blast (blasts are the fastest way to get a number banned).
 */
export async function broadcastWhatsappWeb(
  db: Db,
  workspaceId: ObjectId,
  credentialId: string,
  input: { numbers: string[]; text: string; spacingMs?: [number, number]; countryCode?: string | null },
) {
  const c = whatsappWebCollections(db);
  const text = input.text.trim();
  if (!text) throw new Error("The message is empty");
  const [min, max] = input.spacingMs ?? [5000, 15000];
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const n of input.numbers) {
    if (!n.trim()) continue;
    try {
      const jid = toJid(n, input.countryCode);
      if (!seen.has(jid)) {
        seen.add(jid);
        valid.push(jid);
      }
    } catch {
      invalid.push(n.trim());
    }
  }
  if (valid.length > 200) throw new Error("That's more than 200 people at once. Split it up: big blasts get numbers banned.");
  let at = Date.now();
  const docs: WaOutboxDoc[] = valid.map((to, i) => {
    if (i > 0) at += min + Math.random() * Math.max(0, max - min);
    return { credentialId, workspaceId, to, text, file: null, status: "pending", notBefore: new Date(at), source: "broadcast", result: null, error: null, createdAt: new Date() };
  });
  if (docs.length) await c.outbox.insertMany(docs);
  return { queued: valid.length, recipients: valid, invalid, lastAt: new Date(at).toISOString() };
}

export async function listWhatsappWebGroups(db: Db, workspaceId: ObjectId, credentialId: string) {
  const s = await whatsappWebCollections(db).sessions.findOne({ credentialId, workspaceId }, { projection: { groups: 1 } });
  return (s?.groups ?? []).slice(0, 500);
}

// ---------------------------------------------------------------------------
// The session manager (runs in the worker)
// ---------------------------------------------------------------------------

export interface WhatsappWebOptions {
  /** Where login files live, one folder per linked number. */
  authRoot: string;
  socketFactory?: WaSocketFactory;
  /** How often to look for new numbers, renew leases and so on. */
  syncMs?: number;
  outboxMs?: number;
  /** Pause before sending, so replies don't arrive inhumanly fast. [min, max] ms. */
  typingDelayMs?: [number, number];
  /** Stop showing a QR code nobody scans after this long. */
  qrTimeoutMs?: number;
  /** For "only people in a sheet tab": reads that tab with the workspace's Google account. */
  integrations?: Integrations;
  /** How long a team list read from a sheet is kept (ms). */
  allowListMs?: number;
}

/** Digits of every phone number in a sheet tab's phone column (Phone, Mobile, WhatsApp…). */
async function sheetPhones(integrations: Integrations, workspaceId: ObjectId, p: Record<string, unknown>): Promise<string[]> {
  const svc = integrations.servicesFor(workspaceId, new Set());
  const { accessToken } = (await svc.credential(String(p.teamCredential ?? ""), "google")) as { accessToken?: string };
  const raw = String(p.teamSpreadsheet ?? "").trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? raw;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error("Team sheet: enter a spreadsheet URL or ID");
  const tab = String(p.teamTab ?? "Team").trim() || "Team";
  const url = svc.apiUrl(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A1:ZZ2000`)}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Team sheet: Google Sheets said ${res.status}`);
  const [head = [], ...rows] = ((await res.json()) as { values?: string[][] }).values ?? [];
  const col = head.findIndex((h) => /phone|mobile|whatsapp|number/i.test(String(h)));
  if (col < 0) throw new Error(`Team sheet: the "${tab}" tab needs a Phone column`);
  return rows
    .flatMap((r) => String(r[col] ?? "").split(/[|,;/]|\bor\b/i))
    .map((x) => x.replace(/\D/g, "").replace(/^0+/, ""))
    .filter((d) => d.length >= 7);
}

const LEASE_MS = 45_000;
const LINK_WINDOW_MS = 5 * 60_000;

export function startWhatsappWeb(db: Db, runtime: Pick<Runtime, "createExecution">, options: WhatsappWebOptions) {
  const c = whatsappWebCollections(db);
  const store = collections(db);
  const credentials = db.collection<{ _id: ObjectId; workspaceId: ObjectId; app: string }>("credentials");
  const seen = db.collection<{ workflowId: ObjectId; nodeId: string; key: string; createdAt: Date }>("seen_items");
  const factory = options.socketFactory ?? baileysSocketFactory;
  const me = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const [minDelay, maxDelay] = options.typingDelayMs ?? [300, 900];

  interface Local {
    credentialId: string;
    workspaceId: ObjectId;
    sock: WaSocket | null;
    open: boolean;
    stopping: boolean;
    retries: number;
    qrSince: number | null;
    groupNames: Map<string, string>;
    sending: boolean;
    listeners: Array<[string, (...a: any[]) => void]>;
    /** Message ids and self-chat texts this process sent, so its own replies in "Message yourself" aren't read as new messages. */
    botSent: Map<string, number>;
  }
  const local = new Map<string, Local>();
  /** Team lists read from sheets, per trigger: kept a short while so every message doesn't read the sheet. */
  // Messages arriving together share one read (the promise is kept, not just the result).
  const allowLists = new Map<string, { at: number; phones: Promise<string[]> }>();
  const allowListMs = options.allowListMs ?? 120_000;
  async function teamAllows(workspaceId: ObjectId, p: Record<string, unknown>, from: string | null): Promise<boolean> {
    if (!options.integrations) return true;
    const key = `${String(workspaceId)}|${String(p.teamCredential)}|${String(p.teamSpreadsheet)}|${String(p.teamTab)}`;
    let entry = allowLists.get(key);
    if (!entry || Date.now() - entry.at > allowListMs) {
      entry = { at: Date.now(), phones: sheetPhones(options.integrations, workspaceId, p) };
      allowLists.set(key, entry);
    }
    let phones: string[];
    try {
      phones = await entry.phones;
    } catch (e) {
      // Can't read the sheet right now: let the message through (the workflow's own checks still apply)
      // rather than locking the team out, and try again on the next message.
      if (allowLists.get(key) === entry) allowLists.delete(key);
      console.warn("[whatsapp-web] couldn't read the team list:", (e as Error).message);
      return true;
    }
    if (!from) return false;
    const d = from.replace(/^0+/, "");
    return phones.some((x) => x.endsWith(d) || d.endsWith(x));
  }
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const authDir = (id: string) => join(options.authRoot, id);

  async function setStatus(l: Local, patch: Partial<WaSessionDoc>) {
    await c.sessions.updateOne({ credentialId: l.credentialId, ownerId: me }, { $set: { ...patch, updatedAt: new Date() } });
  }

  function detach(l: Local) {
    if (l.sock) for (const [ev, fn] of l.listeners) l.sock.ev.off(ev, fn);
    l.listeners = [];
  }

  async function open(l: Local) {
    if (stopped || l.stopping) return;
    await mkdir(authDir(l.credentialId), { recursive: true });
    await setStatus(l, { status: l.retries ? "reconnecting" : "starting", error: null });
    let sock: WaSocket;
    try {
      sock = await factory(authDir(l.credentialId));
    } catch (e) {
      await setStatus(l, { status: "reconnecting", error: (e as Error).message });
      scheduleReconnect(l);
      return;
    }
    detach(l);
    l.sock = sock;
    const on = (ev: string, fn: (...a: any[]) => void) => {
      sock.ev.on(ev, fn);
      l.listeners.push([ev, fn]);
    };
    on("connection.update", (u: { connection?: string; qr?: string; lastDisconnect?: { error?: any } }) => {
      void onConnection(l, sock, u).catch((e) => console.error("[whatsapp-web] connection update failed", e));
    });
    on("messages.upsert", (u: { messages: WaMessage[]; type: string }) => {
      if (u.type !== "notify") return;
      for (const m of u.messages) void onMessage(l, sock, m).catch((e) => console.error("[whatsapp-web] couldn't handle a message", e));
    });
    on("groups.update", (gs: Array<{ id?: string; subject?: string }>) => {
      for (const g of gs) if (g.id && g.subject) l.groupNames.set(g.id, g.subject);
    });
  }

  function scheduleReconnect(l: Local) {
    if (stopped || l.stopping) return;
    l.retries++;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(l.retries, 6));
    setTimeout(() => void open(l), wait).unref?.();
  }

  async function onConnection(l: Local, sock: WaSocket, u: { connection?: string; qr?: string; lastDisconnect?: { error?: any } }) {
    if (l.sock !== sock) return;
    if (u.qr) {
      l.qrSince ??= Date.now();
      if (Date.now() - l.qrSince > (options.qrTimeoutMs ?? 3 * 60_000)) {
        // Nobody scanned it. Stop until someone presses "Link phone" again.
        l.stopping = true;
        detach(l);
        sock.end();
        l.sock = null;
        await setStatus(l, { status: "idle", qr: null, linkRequestedAt: null, error: "The QR code wasn't scanned in time" });
        local.delete(l.credentialId);
        return;
      }
      await setStatus(l, { status: "qr", qr: u.qr });
    }
    if (u.connection === "open") {
      l.open = true;
      l.retries = 0;
      l.qrSince = null;
      const phone = phoneOf(sock.user?.id) ?? userPart(sock.user?.id);
      let groups: Array<{ id: string; name: string; members: number }> = [];
      try {
        groups = Object.values(await sock.groupFetchAllParticipating()).map((g) => ({ id: g.id, name: g.subject, members: g.participants.length }));
        for (const g of groups) l.groupNames.set(g.id, g.name);
      } catch {
        /* groups are a nice-to-have */
      }
      await setStatus(l, { status: "open", qr: null, error: null, phone: phone || null, name: sock.user?.name ?? null, groups });
      await credentials.updateOne({ _id: new ObjectId(l.credentialId) }, { $set: { account: phone ? `+${phone}` : null, status: "ok", lastError: null } });
    }
    if (u.connection === "close") {
      l.open = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      detach(l);
      l.sock = null;
      if (code === 401 || code === 403) {
        // Logged out from the phone (or banned): the saved login is useless now.
        await rm(authDir(l.credentialId), { recursive: true, force: true });
        await setStatus(l, {
          status: "logged_out",
          qr: null,
          linkRequestedAt: null,
          error: code === 403 ? "WhatsApp refused this number (it may be banned)" : "Logged out on the phone. Link it again.",
        });
        await credentials.updateOne({ _id: new ObjectId(l.credentialId) }, { $set: { status: "error", lastError: "WhatsApp is logged out. Link the phone again." } });
        local.delete(l.credentialId);
        return;
      }
      if (l.stopping || stopped) return;
      // 515 means "restart now" right after pairing; everything else: back off and retry.
      if (code === 515) setTimeout(() => void open(l), 200).unref?.();
      else scheduleReconnect(l);
    }
  }

  async function onMessage(l: Local, sock: WaSocket, m: WaMessage) {
    const key = m.key ?? {};
    const chatId = key.remoteJid ?? "";
    if (!key.id || !chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter") || chatId.endsWith("@broadcast")) return;
    const mine = [userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean);
    // The only message of our own we read: what the owner types in their "Message yourself" chat.
    const selfChat = Boolean(key.fromMe) && !chatId.endsWith("@g.us") && mine.includes(userPart(chatId));
    if (key.fromMe && !selfChat) return;
    const content = unwrapMessage(m.message);
    if (!Object.keys(content).length || content.protocolMessage || (content.senderKeyDistributionMessage && Object.keys(content).length === 1)) return;
    if (selfChat) {
      const now = Date.now();
      for (const [k, at] of l.botSent) if (now - at > 10 * 60_000) l.botSent.delete(k);
      if (l.botSent.has(key.id) || l.botSent.has(`t:${messageText(content) ?? ""}`)) return;
    }

    const t = await store.triggers.findOne({ kind: "whatsappWeb", credentialId: l.credentialId });
    if (!t?.versionId) return;
    const [wf, version] = await Promise.all([
      store.workflows.findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
      store.versions.findOne({ _id: t.versionId }),
    ]);
    if (!wf || !version) return;
    const graph = workflowGraphSchema.parse(version.graph);
    const node = graph.nodes.find((n) => n.id === t.nodeId);
    const p = node?.parameters ?? {};

    const isGroup = chatId.endsWith("@g.us");
    const chats = String(p.chats ?? "all");
    if ((chats === "private" && isGroup) || (chats === "groups" && !isGroup)) return;
    if (selfChat && !p.selfChat) return;
    const ctx = contextInfo(content);
    const mentionsMe = ((ctx?.mentionedJid ?? []) as string[]).some((j) => mine.includes(userPart(j))) || mine.includes(userPart(ctx?.participant));
    if (isGroup && p.groupMode === "mentioned" && !mentionsMe) return;

    const from = selfChat ? (phoneOf(sock.user?.id) ?? userPart(sock.user?.id)) : isGroup ? phoneOf(key.participant, key.participantAlt) : phoneOf(key.remoteJid, key.remoteJidAlt);
    const allowed = String(p.allowedNumbers ?? "")
      .split(/[\s,;]+/)
      .map((n) => n.replace(/\D/g, ""))
      .filter(Boolean);
    if (allowed.length && (!from || !allowed.some((a) => from.endsWith(a) || a.endsWith(from)))) return;
    // Only people in a sheet tab: everyone else is dropped here, before any run (or sheet read) starts.
    if (p.allowFrom === "sheet" && !(await teamAllows(l.workspaceId, p, from))) return;

    // One run per message, even if WhatsApp delivers it twice.
    try {
      await seen.insertOne({ workflowId: t.workflowId, nodeId: "__whatsapp_web", key: key.id, createdAt: new Date() });
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) return;
      throw e;
    }

    const type = messageType(content);
    let media: WhatsappWebItem["media"] = null;
    const mediaKey = MEDIA_TYPES.find((k) => content[k]);
    if (mediaKey) {
      const meta = content[mediaKey] as { mimetype?: string; fileName?: string; fileLength?: number | { toNumber(): number } };
      const declared = typeof meta.fileLength === "object" ? meta.fileLength.toNumber() : Number(meta.fileLength ?? 0);
      if (declared <= MAX_MEDIA_BYTES) {
        try {
          const buf = await sock.downloadMedia(m);
          if (buf.length <= MAX_MEDIA_BYTES) {
            const mimetype = meta.mimetype?.split(";")[0] ?? "application/octet-stream";
            const { insertedId } = await c.media.insertOne({
              workspaceId: l.workspaceId,
              mimetype,
              fileName: meta.fileName ?? null,
              size: buf.length,
              data: new Binary(buf),
              createdAt: new Date(),
            });
            media = { id: insertedId.toHexString(), mimetype, fileName: meta.fileName ?? null, size: buf.length };
          }
        } catch (e) {
          console.warn("[whatsapp-web] couldn't download media", (e as Error).message);
        }
      }
    }

    let groupName: string | null = null;
    if (isGroup) {
      groupName = l.groupNames.get(chatId) ?? null;
      if (!groupName) {
        try {
          groupName = (await sock.groupMetadata(chatId)).subject;
          l.groupNames.set(chatId, groupName);
        } catch {
          /* unknown group name is fine */
        }
      }
    }
    const loc = content.locationMessage ?? content.liveLocationMessage;
    const ts = typeof m.messageTimestamp === "object" && m.messageTimestamp ? m.messageTimestamp.toNumber() : Number(m.messageTimestamp ?? 0);
    const item: WhatsappWebItem = {
      messageId: key.id,
      chatId,
      isGroup,
      groupName,
      from,
      fromName: m.pushName ?? null,
      text: messageText(content),
      type,
      media,
      location: loc ? { latitude: Number(loc.degreesLatitude), longitude: Number(loc.degreesLongitude), name: loc.name ?? null } : null,
      mentionsMe,
      quotedText: ctx?.quotedMessage ? messageText(unwrapMessage(ctx.quotedMessage)) : null,
      timestamp: ts ? new Date(ts * 1000).toISOString() : null,
    };
    void sock.readMessages?.([key]).catch(() => {});
    const input: StartInput = {
      workspaceId: t.workspaceId,
      workflowId: t.workflowId,
      workflowName: String(wf.name),
      versionId: version._id,
      mode: "production",
      graph,
      triggerNodeId: t.nodeId,
      triggerItems: [{ json: { ...item } }],
    };
    try {
      await runtime.createExecution(input, true);
    } catch (e) {
      await seen.deleteOne({ workflowId: t.workflowId, nodeId: "__whatsapp_web", key: key.id });
      throw e;
    }
  }

  async function drainOutbox(l: Local) {
    if (!l.open || !l.sock || l.sending) return;
    l.sending = true;
    try {
      for (;;) {
        const job = await c.outbox.findOneAndUpdate(
          { credentialId: l.credentialId, status: "pending", $or: [{ notBefore: null }, { notBefore: { $lte: new Date() } }] },
          { $set: { status: "sending" } },
          { sort: { createdAt: 1 }, returnDocument: "after" },
        );
        if (!job) break;
        const sock = l.sock;
        if (!sock) {
          await c.outbox.updateOne({ _id: job._id }, { $set: { status: "pending" } });
          break;
        }
        try {
          let content: Record<string, unknown>;
          if (job.file) {
            const buf = Buffer.from(job.file.data.buffer);
            const kind = job.file.mimetype.startsWith("image/") ? "image" : job.file.mimetype.startsWith("video/") ? "video" : job.file.mimetype.startsWith("audio/") ? "audio" : "document";
            content =
              kind === "document"
                ? { document: buf, mimetype: job.file.mimetype, fileName: job.file.fileName ?? "file", ...(job.text ? { caption: job.text } : {}) }
                : { [kind]: buf, mimetype: job.file.mimetype, ...(job.text && kind !== "audio" ? { caption: job.text } : {}) };
          } else {
            content = { text: job.text ?? "" };
          }
          if (maxDelay > 0) {
            await sock.sendPresenceUpdate?.("composing", job.to).catch(() => {});
            const len = job.text?.length ?? 0;
            await new Promise((r) => setTimeout(r, Math.min(maxDelay, minDelay + Math.random() * (maxDelay - minDelay) + len * 5)));
            await sock.sendPresenceUpdate?.("paused", job.to).catch(() => {});
          }
          const ownChat = [userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean).includes(userPart(job.to));
          if (ownChat) l.botSent.set(`t:${job.text ?? ""}`, Date.now());
          const sent = await sock.sendMessage(job.to, content);
          if (sent?.key?.id) l.botSent.set(sent.key.id, Date.now());
          await c.outbox.updateOne({ _id: job._id }, { $set: { status: "sent", result: { messageId: sent?.key?.id ?? "", chatId: job.to }, file: null } });
        } catch (e) {
          await c.outbox.updateOne({ _id: job._id }, { $set: { status: "failed", error: (e as Error).message, file: null } });
        }
      }
    } finally {
      l.sending = false;
    }
  }

  /** Claims sessions to run here, starts and stops them as numbers are added, linked or removed. */
  async function sync() {
    const creds = await credentials.find({ app: "whatsappWeb" }, { projection: { workspaceId: 1 } }).toArray();
    const ids = new Set(creds.map((x) => x._id.toHexString()));
    // Removed accounts: close and forget.
    for (const [id, l] of local) {
      if (ids.has(id)) continue;
      l.stopping = true;
      detach(l);
      l.sock?.end();
      local.delete(id);
      await rm(authDir(id), { recursive: true, force: true });
      await c.sessions.deleteOne({ credentialId: id });
    }
    const now = new Date();
    for (const cred of creds) {
      const id = cred._id.toHexString();
      await c.sessions.updateOne(
        { credentialId: id },
        {
          $setOnInsert: { credentialId: id, workspaceId: cred.workspaceId, status: "idle", qr: null, phone: null, name: null, error: null, linkRequestedAt: null, updatedAt: now },
        },
        { upsert: true },
      );
      // Take (or keep) the lease.
      const lease = await c.sessions.findOneAndUpdate(
        { credentialId: id, $or: [{ ownerId: me }, { ownerId: null }, { lockedUntil: { $lt: now } }] },
        { $set: { ownerId: me, lockedUntil: new Date(now.getTime() + LEASE_MS) } },
        { returnDocument: "after" },
      );
      if (!lease) continue;
      let l = local.get(id);
      if (!l) {
        const hasLogin = await access(join(authDir(id), "creds.json")).then(() => true, () => false);
        const linkRequested = lease.linkRequestedAt && now.getTime() - lease.linkRequestedAt.getTime() < LINK_WINDOW_MS;
        if (!hasLogin && !linkRequested) continue;
        l = { credentialId: id, workspaceId: cred.workspaceId, sock: null, open: false, stopping: false, retries: 0, qrSince: null, groupNames: new Map(), sending: false, listeners: [], botSent: new Map() };
        local.set(id, l);
        void open(l);
      }
    }
  }

  async function unlinkRequests() {
    const reqs = await c.sessions.find({ ownerId: me, unlinkRequestedAt: { $ne: null } }).toArray();
    for (const r of reqs) {
      const l = local.get(r.credentialId);
      if (l) {
        l.stopping = true;
        try {
          await l.sock?.logout();
        } catch {
          /* already gone */
        }
        detach(l);
        l.sock?.end();
        local.delete(r.credentialId);
      }
      await rm(authDir(r.credentialId), { recursive: true, force: true });
      await c.sessions.updateOne(
        { credentialId: r.credentialId },
        { $set: { status: "idle", qr: null, phone: null, name: null, error: null, groups: [], linkRequestedAt: null, unlinkRequestedAt: null, updatedAt: new Date() } },
      );
    }
  }

  /** Reminders that are due go into the outbox of the number that owns them. */
  async function fireReminders() {
    const owned = [...local.keys()];
    if (!owned.length) return;
    for (;;) {
      const r = await c.reminders.findOneAndUpdate(
        { credentialId: { $in: owned }, status: "pending", dueAt: { $lte: new Date() } },
        { $set: { status: "sent", sentAt: new Date() } },
        { sort: { dueAt: 1 }, returnDocument: "after" },
      );
      if (!r) break;
      await c.outbox.insertOne({ credentialId: r.credentialId, workspaceId: r.workspaceId, to: r.to, text: r.text, file: null, status: "pending", source: "reminder", result: null, error: null, createdAt: new Date() });
    }
  }

  const pass = async () => {
    if (stopped) return;
    try {
      await sync();
      await unlinkRequests();
      await fireReminders();
    } catch (e) {
      console.error("[whatsapp-web] sync failed", (e as Error).message);
    }
  };
  // One pass at a time: two overlapping passes could both start the same number twice.
  let queue: Promise<void> = Promise.resolve();
  const tick = () => (queue = queue.then(pass));
  void ensureWhatsappWebIndexes(db).then(tick);
  timers.push(setInterval(() => void tick(), options.syncMs ?? 3000));
  timers.push(
    setInterval(() => {
      for (const l of local.values()) void drainOutbox(l).catch((e) => console.error("[whatsapp-web] outbox failed", (e as Error).message));
    }, options.outboxMs ?? 400),
  );
  for (const t of timers) t.unref?.();

  return {
    /** Runs one sync pass now (tests). */
    tick,
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      for (const l of local.values()) {
        l.stopping = true;
        detach(l);
        l.sock?.end();
      }
      local.clear();
      await c.sessions.updateMany({ ownerId: me }, { $set: { ownerId: null, lockedUntil: null } });
    },
  };
}

export type WhatsappWeb = ReturnType<typeof startWhatsappWeb>;

/** Asks the owning worker to show a QR code for this number. */
export async function requestWhatsappWebLink(db: Db, workspaceId: ObjectId, credentialId: string) {
  await whatsappWebCollections(db).sessions.updateOne(
    { credentialId },
    { $set: { linkRequestedAt: new Date(), status: "starting", error: null, workspaceId, updatedAt: new Date() }, $setOnInsert: { qr: null, phone: null, name: null, ownerId: null, lockedUntil: null } },
    { upsert: true },
  );
}

export async function requestWhatsappWebUnlink(db: Db, credentialId: string) {
  await whatsappWebCollections(db).sessions.updateOne({ credentialId }, { $set: { unlinkRequestedAt: new Date() } });
}

export async function whatsappWebStatus(db: Db, workspaceId: ObjectId, credentialId: string) {
  const s = await whatsappWebCollections(db).sessions.findOne({ credentialId, workspaceId });
  if (!s) return { status: "idle" as WaSessionStatus, qr: null, phone: null, name: null, error: null, groups: [] as Array<{ id: string; name: string; members: number }>, workerRunning: false };
  return {
    status: s.status,
    qr: s.qr,
    phone: s.phone,
    name: s.name,
    error: s.error,
    groups: (s.groups ?? []).slice(0, 200),
    workerRunning: Boolean(s.lockedUntil && s.lockedUntil > new Date()),
    /** When the status last changed. */
    since: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}
