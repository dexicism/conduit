import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ObjectId } from "mongodb";

/**
 * Envelope encryption for credentials.
 *
 * Each credential gets its own random data key (DEK). The data is encrypted with
 * the DEK, and the DEK is encrypted ("wrapped") with a master key (KEK) from the
 * environment. Both use AES-256-GCM with the workspace and credential IDs as
 * associated data, so a ciphertext copied into another row or workspace fails
 * to decrypt. `keyVersion` records which master key wrapped the DEK, so keys can
 * be rotated by adding a new version and rewrapping.
 */

export interface SealedSecret {
  keyVersion: number;
  /** iv(12) | tag(16) | encrypted DEK(32), base64 */
  wrappedKey: string;
  /** iv(12) | tag(16) | ciphertext, base64 */
  data: string;
}

export interface Vault {
  seal(workspaceId: ObjectId, credentialId: ObjectId, values: Record<string, string>): SealedSecret;
  open(workspaceId: ObjectId, credentialId: ObjectId, sealed: SealedSecret): Record<string, string>;
  currentVersion: number;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

function gcmEncrypt(key: Buffer, plain: Buffer, aad: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function gcmDecrypt(key: Buffer, packed: string, aad: Buffer): Buffer {
  const buf = Buffer.from(packed, "base64");
  if (buf.length < 28) throw new VaultError("Corrupt secret");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(buf.subarray(12, 28));
  try {
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  } catch {
    throw new VaultError("This saved account can't be decrypted. Reconnect it.");
  }
}

/** Parses master keys: "v1:<base64 32 bytes>,v2:<...>" or a single base64 key (version 1). The highest version encrypts. */
export function parseMasterKeys(spec: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^v(\d+):(.+)$/.exec(part);
    const version = m ? Number(m[1]) : 1;
    const key = Buffer.from(m ? m[2]! : part, "base64");
    if (key.length !== 32) throw new VaultError("Each encryption key must be 32 bytes, base64-encoded");
    keys.set(version, key);
  }
  if (!keys.size) throw new VaultError("No encryption key given");
  return keys;
}

export function createVault(keys: Map<number, Buffer>): Vault {
  const currentVersion = Math.max(...keys.keys());
  const kek = (v: number) => {
    const k = keys.get(v);
    if (!k) throw new VaultError(`Encryption key version ${v} isn't configured`);
    return k;
  };
  const aad = (ws: ObjectId, id: ObjectId, part: string) => Buffer.from(`${ws.toHexString()}:${id.toHexString()}:${part}`);

  return {
    currentVersion,
    seal(workspaceId, credentialId, values) {
      const dek = randomBytes(32);
      const data = gcmEncrypt(dek, Buffer.from(JSON.stringify(values), "utf8"), aad(workspaceId, credentialId, "data"));
      const wrappedKey = gcmEncrypt(kek(currentVersion), dek, aad(workspaceId, credentialId, "dek"));
      dek.fill(0);
      return { keyVersion: currentVersion, wrappedKey, data };
    },
    open(workspaceId, credentialId, sealed) {
      const dek = gcmDecrypt(kek(sealed.keyVersion), sealed.wrappedKey, aad(workspaceId, credentialId, "dek"));
      try {
        return JSON.parse(gcmDecrypt(dek, sealed.data, aad(workspaceId, credentialId, "data")).toString("utf8")) as Record<string, string>;
      } finally {
        dek.fill(0);
      }
    },
  };
}
