import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { db } from "./db";
import { env } from "./env";
import { rt } from "./runtime";

/**
 * Two-step verification with an authenticator app (TOTP, RFC 6238: SHA-1, 30 s, 6 digits).
 *
 * Better Auth's two-factor plugin only gates password sign-ins, and every sign-in
 * here is passwordless (email code, Google, GitHub), so this is enforced per session:
 * a session of a user with 2FA on is "pending" until a code is entered, and
 * `requirePageUser` / `requireApiContext` refuse pending sessions.
 *
 * The secret is encrypted with the vault. Codes can't be replayed (the last used
 * time step is stored). Recovery codes are stored as SHA-256 hashes, single use.
 */

const STEP = 30;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
// The vault binds ciphertext to two ids; 2FA secrets use a fixed scope plus the user's doc id.
const SCOPE = new ObjectId("000000000000000000000002");

interface TwoFactorDoc {
  _id: string; // user id
  docId: ObjectId;
  secret: ReturnType<ReturnType<typeof rt>["integrations"]["vault"]["seal"]>;
  enabledAt: Date | null;
  lastStep: number;
  recoveryHashes: string[];
  failures: Date[];
}

interface SessionCheckDoc {
  _id: string; // session id
  userId: string;
  verifiedAt: Date;
  expiresAt: Date;
}

const factors = () => db.collection<TwoFactorDoc>("user_two_factor");
const verified = () => db.collection<SessionCheckDoc>("session_two_factor");
let indexed: Promise<unknown> | null = null;
const ensureIndexes = () => (indexed ??= verified().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }));

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$|\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** The matching time step within ±1 (clock drift), or null. */
function matchStep(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (const s of [cur, cur - 1, cur + 1]) {
    const a = Buffer.from(totpAt(secret, s));
    const b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}

const vault = () => rt().integrations.vault;
const hash = (s: string) => createHash("sha256").update(s.replace(/[\s-]/g, "").toLowerCase()).digest("hex");

export async function twoFactorStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const d = await factors().findOne({ _id: userId });
  return { enabled: Boolean(d?.enabledAt), recoveryCodesLeft: d?.enabledAt ? d.recoveryHashes.length : 0 };
}

/** Starts setup: a new secret (not active until confirmed with a code). */
export async function beginSetup(userId: string, email: string) {
  const existing = await factors().findOne({ _id: userId });
  if (existing?.enabledAt) throw new TwoFactorError("Two-step verification is already on");
  const secret = randomBytes(20);
  const docId = existing?.docId ?? new ObjectId();
  await factors().updateOne(
    { _id: userId },
    { $set: { docId, secret: vault().seal(SCOPE, docId, { secret: base32Encode(secret) }), enabledAt: null, lastStep: 0, recoveryHashes: [], failures: [] } },
    { upsert: true },
  );
  const key = base32Encode(secret);
  const issuer = "Conduit";
  const label = encodeURIComponent(`${issuer}:${email}`);
  const uri = `otpauth://totp/${label}?secret=${key}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
  return { key, uri };
}

export class TwoFactorError extends Error {}

async function checkCode(doc: TwoFactorDoc, code: string, allowRecovery: boolean): Promise<boolean> {
  const recent = doc.failures.filter((f) => f.getTime() > Date.now() - FAILURE_WINDOW_MS);
  if (recent.length >= MAX_FAILURES) throw new TwoFactorError("Too many wrong codes. Wait 15 minutes and try again.");
  const secret = base32Decode(vault().open(SCOPE, doc.docId, doc.secret).secret!);
  const step = matchStep(secret, code.trim());
  if (step !== null) {
    // Replay protection: each time step works once.
    const r = await factors().updateOne({ _id: doc._id, lastStep: { $lt: step } }, { $set: { lastStep: step, failures: [] } });
    if (r.modifiedCount) return true;
  } else if (allowRecovery) {
    const h = hash(code);
    const r = await factors().updateOne({ _id: doc._id, recoveryHashes: h }, { $pull: { recoveryHashes: h }, $set: { failures: [] } });
    if (r.modifiedCount) return true;
  }
  await factors().updateOne({ _id: doc._id }, { $push: { failures: { $each: [new Date()], $slice: -MAX_FAILURES } } });
  return false;
}

/** Confirms setup with a code from the app. Returns recovery codes (shown once). */
export async function enable(userId: string, code: string, sessionId: string, sessionExpiresAt: Date) {
  const doc = await factors().findOne({ _id: userId });
  if (!doc || doc.enabledAt) throw new TwoFactorError("Start setup first");
  if (!(await checkCode(doc, code, false))) throw new TwoFactorError("That code isn't right. Check the time on your phone and try again.");
  const codes = Array.from({ length: 8 }, () => {
    const r = randomBytes(5).toString("hex");
    return `${r.slice(0, 5)}-${r.slice(5)}`;
  });
  await factors().updateOne({ _id: userId }, { $set: { enabledAt: new Date(), recoveryHashes: codes.map(hash) } });
  await markVerified(sessionId, userId, sessionExpiresAt);
  return codes;
}

export async function disable(userId: string, code: string) {
  const doc = await factors().findOne({ _id: userId, enabledAt: { $ne: null } });
  if (!doc) throw new TwoFactorError("Two-step verification is off");
  if (!(await checkCode(doc, code, true))) throw new TwoFactorError("That code isn't right");
  await factors().deleteOne({ _id: userId });
  await verified().deleteMany({ userId });
}

async function markVerified(sessionId: string, userId: string, expiresAt: Date) {
  await ensureIndexes();
  await verified().updateOne({ _id: sessionId }, { $set: { userId, verifiedAt: new Date(), expiresAt } }, { upsert: true });
}

/** Verifies a pending session with a TOTP or recovery code. */
export async function verifySession(userId: string, code: string, sessionId: string, sessionExpiresAt: Date) {
  const doc = await factors().findOne({ _id: userId, enabledAt: { $ne: null } });
  if (!doc) return;
  if (!(await checkCode(doc, code, true))) throw new TwoFactorError("That code isn't right");
  await markVerified(sessionId, userId, sessionExpiresAt);
}

/** True when the user has 2FA on and this session hasn't passed it yet. */
export async function sessionNeedsTwoFactor(userId: string, sessionId: string): Promise<boolean> {
  const doc = await factors().findOne({ _id: userId, enabledAt: { $ne: null } }, { projection: { _id: 1 } });
  if (!doc) return false;
  return !(await verified().findOne({ _id: sessionId, userId }, { projection: { _id: 1 } }));
}

export const twoFactorIssuerHost = () => new URL(env.APP_URL).host;
