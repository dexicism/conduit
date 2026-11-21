import { z } from "zod";
import { json, parse, readJson, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { disable } from "@/lib/two-factor";
import { twoFactorCall } from "@/lib/two-factor-routes";

const schema = z.object({ code: z.string().trim().min(6).max(12) });

/** Turns 2FA off. Needs a current code or a recovery code. */
export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const { code } = parse(schema, await readJson(req));
  await twoFactorCall(() => disable(user.id, code));
  return json({ enabled: false });
});
