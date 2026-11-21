import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe webhook and API payloads are untyped JSON read field by field. */
import { PLAN_IDS, planOf, type PlanId } from "@conduit/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { MongoServerError, ObjectId } from "mongodb";
import { ApiError } from "./api";
import { collections, db } from "./db";
import { env } from "./env";
import { rt } from "./runtime";

/**
 * Stripe subscriptions over its REST API. Plans change only from verified webhooks,
 * never from the checkout redirect. Upgrade controls are hidden unless configured.
 */

function opt(name: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

const PAID: Exclude<PlanId, "free">[] = ["starter", "pro", "max"];

function config() {
  const prices = Object.fromEntries(PAID.map((p) => [p, opt(`STRIPE_PRICE_${p.toUpperCase()}`)])) as Record<Exclude<PlanId, "free">, string | undefined>;
  const secretKey = opt("STRIPE_SECRET_KEY");
  const webhookSecret = opt("STRIPE_WEBHOOK_SECRET");
  const enabled = Boolean(secretKey && webhookSecret && PAID.every((p) => prices[p]));
  return { enabled, secretKey, webhookSecret, prices };
}

export function billingEnabled(): boolean {
  return config().enabled;
}

function planForPrice(priceId: string | undefined): PlanId | null {
  const { prices } = config();
  return (PAID.find((p) => prices[p] === priceId) as PlanId | undefined) ?? null;
}

async function stripe(method: "GET" | "POST", path: string, form?: Record<string, string>) {
  const { secretKey } = config();
  const { integrations } = rt();
  const res = await integrations.http({
    method,
    url: integrations.apiUrl(`https://api.stripe.com/v1${path}`),
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form ? new URLSearchParams(form).toString() : undefined,
    timeoutMs: 20_000,
  });
  const body = res.body as Record<string, any>;
  if (res.status >= 400) throw new ApiError(502, "internal_error", `Payment provider error: ${body?.error?.message ?? res.status}`);
  return body;
}

interface BillingInfo {
  customerId?: string;
  subscriptionId?: string;
  status?: string;
  periodEnd?: Date | null;
}

async function billingOf(workspaceId: ObjectId): Promise<BillingInfo> {
  const ws = await collections.workspaces().findOne({ _id: workspaceId }, { projection: { billing: 1 } });
  return (ws?.billing as BillingInfo | undefined) ?? {};
}

export async function createCheckout(workspaceId: ObjectId, plan: PlanId, email: string): Promise<string> {
  const { enabled, prices } = config();
  if (!enabled) throw new ApiError(400, "invalid_request", "Billing isn't set up on this server");
  if (plan === "free") throw new ApiError(400, "invalid_request", "Choose a paid plan");
  const billing = await billingOf(workspaceId);
  if (billing.subscriptionId && billing.status === "active") {
    throw new ApiError(400, "invalid_request", "This workspace already has a subscription. Change it from Manage billing.");
  }
  const id = workspaceId.toHexString();
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": prices[plan]!,
    "line_items[0][quantity]": "1",
    success_url: `${env.APP_URL}/app/billing?checkout=success`,
    cancel_url: `${env.APP_URL}/app/billing?checkout=canceled`,
    client_reference_id: id,
    "metadata[workspaceId]": id,
    "metadata[plan]": plan,
    "subscription_data[metadata][workspaceId]": id,
    ...(billing.customerId ? { customer: billing.customerId } : { customer_email: email }),
  });
  return String(session.url);
}

export async function createPortal(workspaceId: ObjectId): Promise<string> {
  if (!config().enabled) throw new ApiError(400, "invalid_request", "Billing isn't set up on this server");
  const { customerId } = await billingOf(workspaceId);
  if (!customerId) throw new ApiError(400, "invalid_request", "This workspace has no billing account yet");
  const s = await stripe("POST", "/billing_portal/sessions", { customer: customerId, return_url: `${env.APP_URL}/app/billing` });
  return String(s.url);
}

export async function listInvoices(workspaceId: ObjectId) {
  if (!config().enabled) return [];
  const { customerId } = await billingOf(workspaceId);
  if (!customerId) return [];
  const list = await stripe("GET", `/invoices?customer=${encodeURIComponent(customerId)}&limit=24`);
  return ((list.data ?? []) as Array<Record<string, any>>).map((i) => ({
    id: String(i.id),
    number: i.number ? String(i.number) : null,
    amount: Number(i.amount_paid ?? i.total ?? 0) / 100,
    currency: String(i.currency ?? "usd").toUpperCase(),
    status: String(i.status ?? ""),
    createdAt: new Date(Number(i.created) * 1000).toISOString(),
    pdfUrl: typeof i.invoice_pdf === "string" ? i.invoice_pdf : null,
    pageUrl: typeof i.hosted_invoice_url === "string" ? i.hosted_invoice_url : null,
  }));
}

/** Verifies a `Stripe-Signature` header (`t=…,v1=…`): HMAC-SHA256 of `${t}.${body}`, within 5 minutes. */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

async function setPlan(workspaceId: ObjectId, plan: PlanId, billing: Partial<BillingInfo>) {
  const set: Record<string, unknown> = { plan, updatedAt: new Date() };
  for (const [k, v] of Object.entries(billing)) if (v !== undefined) set[`billing.${k}`] = v;
  const before = await collections.workspaces().findOneAndUpdate({ _id: workspaceId }, { $set: set });
  if (before && planOf(before.plan).id !== plan) await rt().runtime.credits.applyPlan(workspaceId, plan);
}

const events = () => db.collection<{ _id: string; type: string; receivedAt: Date }>("stripe_events");

/** Applies one verified Stripe event. Repeated deliveries of the same event do nothing; a failed one can be retried. */
export async function handleStripeEvent(event: { id: string; type: string; data: { object: Record<string, any> } }) {
  try {
    return await applyStripeEvent(event);
  } catch (err) {
    await events().deleteOne({ _id: event.id }); // let Stripe's retry run it again
    throw err;
  }
}

async function applyStripeEvent(event: { id: string; type: string; data: { object: Record<string, any> } }) {
  try {
    await events().insertOne({ _id: event.id, type: event.type, receivedAt: new Date() });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) return "duplicate";
    throw err;
  }
  const o = event.data.object;
  const wsIdOf = (v: unknown) => (typeof v === "string" && ObjectId.isValid(v) ? new ObjectId(v) : null);

  switch (event.type) {
    case "checkout.session.completed": {
      const ws = wsIdOf(o.metadata?.workspaceId ?? o.client_reference_id);
      const plan = String(o.metadata?.plan);
      if (!ws || !(PLAN_IDS as readonly string[]).includes(plan)) return "ignored";
      await setPlan(ws, plan as PlanId, { customerId: o.customer, subscriptionId: o.subscription, status: "active" });
      return "applied";
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const ws =
        wsIdOf(o.metadata?.workspaceId) ??
        ((await collections.workspaces().findOne({ "billing.subscriptionId": o.id }, { projection: { _id: 1 } }))?._id as ObjectId | undefined) ??
        null;
      if (!ws) return "ignored";
      const status = event.type === "customer.subscription.deleted" ? "canceled" : String(o.status);
      const live = status === "active" || status === "trialing" || status === "past_due";
      const plan = live ? (planForPrice(o.items?.data?.[0]?.price?.id) ?? null) : "free";
      const periodEnd = typeof o.current_period_end === "number" ? new Date(o.current_period_end * 1000) : null;
      if (!plan) return "ignored";
      await setPlan(ws, plan, { subscriptionId: o.id, customerId: o.customer, status, periodEnd });
      return "applied";
    }
    case "invoice.paid": {
      // Renewal: a new period's credits.
      if (o.billing_reason !== "subscription_cycle") return "ignored";
      const w = await collections.workspaces().findOne({ "billing.subscriptionId": o.subscription }, { projection: { plan: 1 } });
      if (!w) return "ignored";
      await rt().runtime.credits.applyPlan(w._id as ObjectId, planOf(w.plan).id);
      return "applied";
    }
    default:
      return "ignored";
  }
}

export function webhookSecret() {
  return config().webhookSecret;
}
