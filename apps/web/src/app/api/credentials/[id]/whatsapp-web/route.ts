import { requestWhatsappWebLink, requestWhatsappWebUnlink, whatsappWebStatus } from "@conduit/runtime";
import QRCode from "qrcode";
import { z } from "zod";
import { ApiError, json, parse, readJson, route } from "@/lib/api";
import { db } from "@/lib/db";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";
import { canEdit } from "@/lib/workspaces";

type Ctx = RouteContext<"/api/credentials/[id]/whatsapp-web">;

async function load(req: Request, ctx: Ctx) {
  const c = await requireApiContext(req);
  const { id } = await ctx.params;
  const doc = await rt().integrations.find(c.workspace.workspaceId, id);
  if (!doc || doc.app !== "whatsappWeb") throw new ApiError(404, "not_found", "Linked WhatsApp number not found");
  return { ...c, id };
}

/** Link status, and the QR code to scan while linking (as an image). */
export const GET = route<Ctx>(async (req, ctx) => {
  const { workspace, id } = await load(req, ctx);
  const s = await whatsappWebStatus(db, workspace.workspaceId, id);
  const qrImage = s.status === "qr" && s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 280 }) : null;
  return json({ status: s.status, phone: s.phone, name: s.name, error: s.error, groups: s.groups, workerRunning: s.workerRunning, qrImage });
});

/** `link` shows a fresh QR code; `unlink` logs the phone out and forgets the login. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { workspace, id } = await load(req, ctx);
  if (!canEdit(workspace.role)) throw new ApiError(403, "forbidden", "Viewers can't change linked numbers");
  const { action } = parse(z.object({ action: z.enum(["link", "unlink"]) }), await readJson(req));
  if (action === "link") await requestWhatsappWebLink(db, workspace.workspaceId, id);
  else await requestWhatsappWebUnlink(db, id);
  return json({ ok: true });
});
