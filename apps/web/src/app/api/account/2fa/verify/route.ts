import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { auth } from "@/lib/auth";
import { verifySession } from "@/lib/two-factor";
import { twoFactorCall } from "@/lib/two-factor-routes";

const schema = z.object({ code: z.string().trim().min(6).max(12) });

/** Completes sign-in for a session waiting on two-step verification. */
export const POST = route(async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new ApiError(401, "unauthorized", "Sign in to continue");
  const { code } = parse(schema, await readJson(req));
  await twoFactorCall(() => verifySession(session.user.id, code, session.session.id, new Date(session.session.expiresAt)));
  return json({ verified: true });
});
