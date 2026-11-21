import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + database check for load balancers and uptime monitors. */
export async function GET() {
  try {
    await db.command({ ping: 1 });
    return Response.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
