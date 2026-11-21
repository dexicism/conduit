import { json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { twoFactorStatus } from "@/lib/two-factor";

export const GET = route(async (req) => {
  const { user } = await requireApiContext(req);
  return json(await twoFactorStatus(user.id));
});
