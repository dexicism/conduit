import QRCode from "qrcode";
import { json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { beginSetup } from "@/lib/two-factor";
import { twoFactorCall } from "@/lib/two-factor-routes";

/** New secret for the authenticator app, as a QR code and a key to type in. */
export const POST = route(async (req) => {
  const { user } = await requireApiContext(req);
  const { key, uri } = await twoFactorCall(() => beginSetup(user.id, user.email));
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return json({ key, uri, qr });
});
