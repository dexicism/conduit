import { NextResponse } from "next/server";
import { handleStripeEvent, verifyStripeSignature, webhookSecret } from "@/lib/billing";

export const dynamic = "force-dynamic";

/** Stripe events. The signature is checked against the raw body before anything is parsed or applied. */
export async function POST(req: Request) {
  const secret = webhookSecret();
  if (!secret) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature") ?? "", secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await handleStripeEvent(event as Parameters<typeof handleStripeEvent>[0]);
    return NextResponse.json({ received: true, result });
  } catch (err) {
    console.error("[billing] webhook failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
