import type { EngineServices, IntegrationServices } from "../types";
import { StepError } from "../types";
import { toText } from "../values";

type Json = Record<string, unknown>;
type Action = (p: Json, services: EngineServices) => Promise<Json | Json[]>;

function wa(services: EngineServices): NonNullable<IntegrationServices["whatsappWeb"]> {
  const w = services.integrations?.whatsappWeb;
  if (!w) throw new StepError("WhatsApp (linked phone) isn't available on this server");
  return w;
}

function credentialId(p: Json): string {
  const id = toText(p.credential);
  if (!id) throw new StepError("Choose a linked WhatsApp number");
  return id;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

/** Text, or a file (a photo/document someone sent, or base64 from another step), to a person or group. */
const send: Action = async (p, services) => {
  const id = credentialId(p);
  const to = toText(p.to).trim();
  if (!to) throw new StepError("To is empty. Use a phone number or a chat id (e.g. the trigger's chatId).");
  const text = toText(p.text);
  let file: { base64: string; mimetype: string; fileName: string | null } | null = null;
  const source = toText(p.fileSource) || "none";
  if (source === "media") {
    const mediaId = toText(p.mediaId).trim();
    if (!mediaId) throw new StepError("Media ID is empty");
    const m = await wa(services).readMedia(mediaId);
    if (!m) throw new StepError("That file isn't stored anymore (files are kept for 30 days) or belongs to another workspace");
    file = { base64: m.base64, mimetype: m.mimetype, fileName: toText(p.fileName) || m.fileName };
  } else if (source === "base64") {
    const raw = toText(p.fileBase64).replace(/^data:[^;]+;base64,/, "").trim();
    if (!raw) throw new StepError("The file content is empty");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new StepError("The file content isn't base64");
    const fileName = toText(p.fileName).trim() || "file";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    file = { base64: raw, mimetype: toText(p.mimetype).trim() || MIME_BY_EXT[ext] || "application/octet-stream", fileName };
  }
  if (!text.trim() && !file) throw new StepError("Nothing to send: write some text or attach a file");
  if (text.length > 65_000) throw new StepError("That message is too long for WhatsApp");
  try {
    const r = await wa(services).send(id, { to, text, file });
    return { messageId: r.messageId, chatId: r.chatId, sentFile: file ? file.fileName : null };
  } catch (e) {
    throw new StepError((e as Error).message);
  }
};

/** A stored photo or file as base64, e.g. to hand to an AI step or save to Drive. */
const getMedia: Action = async (p, services) => {
  const mediaId = toText(p.mediaId).trim();
  if (!mediaId) throw new StepError("Media ID is empty");
  const m = await wa(services).readMedia(mediaId);
  if (!m) throw new StepError("That file isn't stored anymore (files are kept for 30 days) or belongs to another workspace");
  return { mediaId, mimetype: m.mimetype, fileName: m.fileName, size: m.size, base64: m.base64 };
};

/** The groups the linked number is in, one item each. Handy for finding a group's chat id. */
const groups: Action = async (p, services) => {
  const list = await wa(services).groups(credentialId(p));
  const filter = toText(p.nameContains).trim().toLowerCase();
  return list.filter((g) => !filter || g.name.toLowerCase().includes(filter)).map((g) => ({ chatId: g.id, name: g.name, members: g.members }));
};

export const WHATSAPP_WEB_ACTIONS: Record<string, Action> = {
  "app.whatsappWeb.send": send,
  "app.whatsappWeb.getMedia": getMedia,
  "app.whatsappWeb.groups": groups,
};
