import type { HttpRequest, HttpResponse } from "@conduit/engine";
import { createHmac, randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { SealedSecret, Vault } from "./vault";

/**
 * Outbound webhooks: POSTs signed JSON to a workspace's URLs when live runs finish.
 * Deliveries are queued in Mongo and retried with backoff (1m, 5m, 30m, 2h, 12h).
 * Requests go through the SSRF-guarded HTTP client.
 *
 * Signature header: `Conduit-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 */

export const OUTBOUND_EVENTS = ["execution.completed", "execution.failed"] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

interface WebhookDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  url: string;
  events: OutboundEvent[];
  secret: SealedSecret;
  active: boolean;
  createdAt: Date;
}

interface DeliveryDoc {
  _id: ObjectId;
  webhookId: ObjectId;
  workspaceId: ObjectId;
  event: OutboundEvent;
  body: string;
  attempts: number;
  status: "pending" | "delivering" | "delivered" | "failed";
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface WebhookView {
  id: string;
  url: string;
  events: OutboundEvent[];
  active: boolean;
  createdAt: string;
  recent: Array<{ id: string; event: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string }>;
}

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
type Http = (req: HttpRequest) => Promise<HttpResponse>;

export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export function createOutbound(db: Db, deps: { vault: Vault; http: Http }) {
  const hooks = db.collection<WebhookDoc>("outbound_webhooks");
  const deliveries = db.collection<DeliveryDoc>("webhook_deliveries");
  let indexed: Promise<unknown> | null = null;
  const ready = () =>
    (indexed ??= Promise.all([
      hooks.createIndex({ workspaceId: 1 }),
      deliveries.createIndex({ status: 1, nextAttemptAt: 1 }),
      deliveries.createIndex({ webhookId: 1, createdAt: -1 }),
      deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 86_400 }),
    ]));

  async function list(workspaceId: ObjectId): Promise<WebhookView[]> {
    await ready();
    const docs = await hooks.find({ workspaceId }).sort({ createdAt: -1 }).toArray();
    return Promise.all(
      docs.map(async (h) => ({
        id: h._id.toHexString(),
        url: h.url,
        events: h.events,
        active: h.active,
        createdAt: h.createdAt.toISOString(),
        recent: (await deliveries.find({ webhookId: h._id }).sort({ createdAt: -1 }).limit(5).toArray()).map((d) => ({
          id: d._id.toHexString(),
          event: d.event,
          status: d.status === "delivering" ? "pending" : d.status,
          attempts: d.attempts,
          lastStatus: d.lastStatus,
          lastError: d.lastError,
          createdAt: d.createdAt.toISOString(),
        })),
      })),
    );
  }

  /** Adds an endpoint. The signing secret is returned once; it's stored encrypted. */
  async function create(workspaceId: ObjectId, url: string, events: OutboundEvent[]) {
    await ready();
    const _id = new ObjectId();
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await hooks.insertOne({ _id, workspaceId, url, events, secret: deps.vault.seal(workspaceId, _id, { secret }), active: true, createdAt: new Date() });
    return { id: _id.toHexString(), secret };
  }

  async function remove(workspaceId: ObjectId, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const r = await hooks.deleteOne({ _id: new ObjectId(id), workspaceId });
    if (r.deletedCount) await deliveries.deleteMany({ webhookId: new ObjectId(id), status: { $in: ["pending", "delivering"] } });
    return r.deletedCount === 1;
  }

  /** Queues the event for every active endpoint of the workspace that subscribes to it. */
  async function enqueue(workspaceId: ObjectId, event: OutboundEvent, data: Record<string, unknown>, onlyWebhookId?: ObjectId) {
    await ready();
    const targets = await hooks.find({ workspaceId, active: true, ...(onlyWebhookId ? { _id: onlyWebhookId } : { events: event }) }).toArray();
    if (!targets.length) return 0;
    const now = new Date();
    await deliveries.insertMany(
      targets.map((h) => {
        const _id = new ObjectId();
        return {
          _id,
          webhookId: h._id,
          workspaceId,
          event,
          body: JSON.stringify({ id: _id.toHexString(), type: event, createdAt: now.toISOString(), data }),
          attempts: 0,
          status: "pending" as const,
          nextAttemptAt: now,
          lockedUntil: null,
          lastStatus: null,
          lastError: null,
          createdAt: now,
          deliveredAt: null,
        };
      }),
    );
    return targets.length;
  }

  async function sendTest(workspaceId: ObjectId, id: string) {
    if (!ObjectId.isValid(id)) return false;
    const h = await hooks.findOne({ _id: new ObjectId(id), workspaceId });
    if (!h) return false;
    await enqueue(workspaceId, "execution.completed", { test: true, message: "Test delivery from Conduit" }, h._id);
    await tick();
    return true;
  }

  async function deliver(d: DeliveryDoc) {
    const h = await hooks.findOne({ _id: d.webhookId });
    if (!h) return deliveries.updateOne({ _id: d._id }, { $set: { status: "failed", lastError: "Endpoint was removed", lockedUntil: null } });
    const { secret } = deps.vault.open(h.workspaceId, h._id, h.secret);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await deps.http({
        method: "POST",
        url: h.url,
        headers: {
          "content-type": "application/json",
          "user-agent": "Conduit-Webhooks/1",
          "conduit-event": d.event,
          "conduit-delivery": d._id.toHexString(),
          "conduit-signature": signPayload(secret!, d.body),
        },
        body: d.body,
        timeoutMs: 15_000,
      });
      status = res.status;
      if (res.status >= 300) error = `Endpoint answered ${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      return deliveries.updateOne({ _id: d._id }, { $set: { status: "delivered", attempts, lastStatus: status, lastError: null, deliveredAt: new Date(), lockedUntil: null } });
    }
    const delay = BACKOFF_MS[attempts - 1];
    return deliveries.updateOne(
      { _id: d._id },
      {
        $set: {
          status: delay === undefined ? "failed" : "pending",
          attempts,
          lastStatus: status,
          lastError: error,
          nextAttemptAt: new Date(Date.now() + (delay ?? 0)),
          lockedUntil: null,
        },
      },
    );
  }

  /** Delivers everything that's due. Safe to run from several workers (deliveries are claimed with a lease). */
  async function tick(limit = 20) {
    await ready();
    for (let i = 0; i < limit; i++) {
      const now = new Date();
      const d = await deliveries.findOneAndUpdate(
        { $or: [{ status: "pending", nextAttemptAt: { $lte: now } }, { status: "delivering", lockedUntil: { $lt: now } }] },
        { $set: { status: "delivering", lockedUntil: new Date(now.getTime() + 60_000) } },
        { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
      );
      if (!d) return;
      await deliver(d);
    }
  }

  return { list, create, remove, enqueue, sendTest, tick };
}

export type Outbound = ReturnType<typeof createOutbound>;
