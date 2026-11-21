import { z } from "zod";
import { json, parse, readJson, route } from "@/lib/api";
import { auth } from "@/lib/auth";
import { requireApiContext } from "@/lib/session";
import { enable } from "@/lib/two-factor";
import { twoFactorCall } from "@/lib/two-factor-routes";

const schema = z.object({ code: z.string().trim().min(6).max(12) });

/** Confirms setup with a code; returns one-time recovery codes. */
export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const session = (await auth.api.getSession({ headers: req.headers }))!;
  const { code } = parse(schema, await readJson(req));
  const recoveryCodes = await twoFactorCall(() => enable(user.id, code, session.session.id, new Date(session.session.expiresAt)));
  return json({ enabled: true, recoveryCodes });
});
