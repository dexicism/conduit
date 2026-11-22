import { workflowGraphSchema } from "@conduit/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { MongoServerError, ObjectId, type Db } from "mongodb";
import type { Integrations } from "./integrations";
import type { Runtime, StartInput } from "./runtime";
import { collections } from "./store";

/**
 * Incoming WhatsApp messages (Cloud API webhooks).
 *
 * Meta lets you set one callback URL per app, in their dashboard. Ours is
 * /hook/whatsapp/<connection id>, so it stays the same across publishes and
 * can be verified before anything is live.
 */

export interface WhatsappMessageItem {
  messageId: string;
  from: string;
  name: string | null;
  type: string;
  text: string | null;
  mediaId: string | null;
  timestamp: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
}

/** Pulls the messages out of a webhook payload. Delivery receipts ("statuses") are skipped. */
export function whatsappMessages(payload: unknown): WhatsappMessageItem[] {
  const out: WhatsappMessageItem[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of ((entry as { changes?: unknown[] })?.changes ?? []) as Array<Record<string, any>>) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of (value.contacts ?? []) as Array<Record<string, any>>) if (c?.wa_id) names.set(String(c.wa_id), c.profile?.name ?? null);
      for (const m of (value.messages ?? []) as Array<Record<string, any>>) {
        if (!m?.id || !m?.from) continue;
        const type = String(m.type ?? "unknown");
        const media = m[type] && typeof m[type] === "object" ? (m[type] as Record<string, any>) : null;
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          media?.caption ??
          (type === "location" ? [m.location?.name, m.location?.address].filter(Boolean).join(", ") || null : null);
        out.push({
          messageId: String(m.id),
          from: String(m.from),
          name: names.get(String(m.from)) ?? null,
          type,
          text: text ?? null,
          mediaId: media?.id ? String(media.id) : null,
          timestamp: /^\d+$/.test(String(m.timestamp ?? "")) ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
          phoneNumberId: value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null,
          displayPhoneNumber: value.metadata?.display_phone_number ? String(value.metadata.display_phone_number) : null,
        });
      }
    }
  }
  return out;
}

/** Meta signs every POST with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function validWhatsappSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex"));
  const got = Buffer.from(header.slice(7).toLowerCase());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type WhatsappReceiveResult = { status: 200; started: number } | { status: 401 | 404 };

export function createWhatsappReceiver(db: Db, integrations: Integrations, runtime: Pick<Runtime, "createExecution">) {
  const c = collections(db);
  const seen = db.collection<{ workflowId: ObjectId; nodeId: string; key: string; createdAt: Date }>("seen_items");

  async function connection(credentialId: string) {
    if (!ObjectId.isValid(credentialId)) return null;
    const doc = await integrations.collections.credentials.findOne({ _id: new ObjectId(credentialId), app: "whatsapp" });
    if (!doc) return null;
    const { values } = await integrations.resolve(doc.workspaceId, credentialId, "whatsapp");
    return { workspaceId: doc.workspaceId, values };
  }

  /** The GET handshake Meta does when you save the callback URL. Returns the challenge to echo, or null. */
  async function verify(credentialId: string, params: URLSearchParams): Promise<string | null> {
    if (params.get("hub.mode") !== "subscribe") return null;
    const conn = await connection(credentialId);
    const token = conn?.values.verifyToken ?? "";
    if (!token || !sameText(params.get("hub.verify_token") ?? "", token)) return null;
    return params.get("hub.challenge") ?? "";
  }

  async function receive(credentialId: string, rawBody: string, signature: string | null): Promise<WhatsappReceiveResult> {
    const conn = await connection(credentialId);
    if (!conn) return { status: 404 };
    if (!validWhatsappSignature(rawBody, signature, conn.values.appSecret ?? "")) return { status: 401 };
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 200, started: 0 };
    }
    const messages = whatsappMessages(payload).filter((m) => !m.phoneNumberId || m.phoneNumberId === conn.values.phoneNumberId);
    if (!messages.length) return { status: 200, started: 0 };

    const t = await c.triggers.findOne({ kind: "whatsapp", credentialId });
    if (!t?.versionId) return { status: 200, started: 0 };
    const [wf, version] = await Promise.all([
      c.workflows.findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
      c.versions.findOne({ _id: t.versionId }),
    ]);
    if (!wf || !version) return { status: 200, started: 0 };
    const graph = workflowGraphSchema.parse(version.graph);

    let started = 0;
    for (const m of messages) {
      // Meta retries anything it thinks we missed, so each message id only starts one run.
      try {
        await seen.insertOne({ workflowId: t.workflowId, nodeId: "__whatsapp", key: m.messageId, createdAt: new Date() });
      } catch (e) {
        if (e instanceof MongoServerError && e.code === 11000) continue;
        throw e;
      }
      const input: StartInput = {
        workspaceId: t.workspaceId,
        workflowId: t.workflowId,
        workflowName: String(wf.name),
        versionId: version._id,
        mode: "production",
        graph,
        triggerNodeId: t.nodeId,
        triggerItems: [{ json: { ...m } }],
      };
      await runtime.createExecution(input, true);
      started++;
    }
    return { status: 200, started };
  }

  return { verify, receive };
}

export type WhatsappReceiver = ReturnType<typeof createWhatsappReceiver>;
