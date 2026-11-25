import type { NodeDefinition, ParamField } from "../types";

const action = {
  version: 1,
  category: "app" as const,
  color: "sky" as const,
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
};

const credential: ParamField = { kind: "credential", name: "credential", label: "Linked number", app: "whatsappWeb", required: true };

export const whatsappWebTrigger: NodeDefinition = {
  type: "trigger.whatsappWeb",
  version: 1,
  name: "WhatsApp (linked phone): message",
  description: "Start when your linked WhatsApp number gets a message, in a private chat or a group. Photos and files come with a media ID.",
  category: "trigger",
  icon: "Smartphone",
  color: "amber",
  app: "whatsappWeb",
  keywords: ["whatsapp", "web", "group", "message", "chat", "bot", "linked"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [
    credential,
    {
      kind: "select",
      name: "chats",
      label: "Listen to",
      default: "all",
      options: [
        { value: "all", label: "Private chats and groups" },
        { value: "private", label: "Private chats only" },
        { value: "groups", label: "Groups only" },
      ],
    },
    {
      kind: "select",
      name: "groupMode",
      label: "In groups",
      default: "all",
      options: [
        { value: "all", label: "Every message" },
        { value: "mentioned", label: "Only when someone @mentions or replies to it" },
      ],
    },
    {
      kind: "string",
      name: "allowedNumbers",
      label: "Only these numbers",
      multiline: true,
      expression: false,
      placeholder: "+919876543210, +919812345678",
      description: "Optional. Messages from anyone else are ignored. Leave empty to listen to everyone.",
    },
  ],
  outputSample: {
    messageId: "3EB0C4A1F2D9B7E5A1C2",
    chatId: "120363042712345678@g.us",
    isGroup: true,
    groupName: "Sales team",
    from: "919876543210",
    fromName: "Ravi",
    text: "Called Mehta, he wants the quote by Friday",
    type: "text",
    media: null,
    location: null,
    mentionsMe: false,
    quotedText: null,
    timestamp: "2026-01-01T09:00:00.000Z",
  },
};

export const whatsappWebSend: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.send",
  name: "WhatsApp (linked phone): send",
  description: "Send text, a photo or a file from your linked number to a person or a group. There's a short typing pause first, so it reads like a person.",
  icon: "Smartphone",
  app: "whatsappWeb",
  keywords: ["whatsapp", "web", "send", "reply", "message", "group", "file", "photo", "document"],
  asTool: { name: "send_whatsapp", description: "Send a WhatsApp message to a phone number or a group chat id." },
  fields: [
    credential,
    { kind: "string", name: "to", label: "To", required: true, default: "${['$input']['chatId']}", placeholder: "+919876543210 or a chat id", description: "A phone number in international format, or a chat id (from the trigger, or the groups step)." },
    { kind: "string", name: "text", label: "Text", multiline: true, aiFill: true, description: "The message. With a file, this is its caption." },
    {
      kind: "select",
      name: "fileSource",
      label: "Attach",
      default: "none",
      options: [
        { value: "none", label: "Nothing" },
        { value: "media", label: "A received photo or file (media ID)" },
        { value: "base64", label: "File content from another step (base64)" },
      ],
    },
    { kind: "string", name: "mediaId", label: "Media ID", required: true, showIf: { field: "fileSource", equals: ["media"] }, placeholder: "${['$input']['media']['id']}" },
    { kind: "string", name: "fileBase64", label: "File content (base64)", required: true, showIf: { field: "fileSource", equals: ["base64"] } },
    { kind: "string", name: "fileName", label: "File name", showIf: { field: "fileSource", equals: ["media", "base64"] }, placeholder: "quotation.pdf" },
    { kind: "string", name: "mimetype", label: "File type", showIf: { field: "fileSource", equals: ["base64"] }, placeholder: "Worked out from the file name if empty" },
  ],
  outputSample: { messageId: "3EB0D2F1A9C8B7E6", chatId: "919876543210@s.whatsapp.net", sentFile: null },
};

export const whatsappWebGetMedia: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.getMedia",
  name: "WhatsApp (linked phone): get file",
  description: "Load a photo or file someone sent (by its media ID) as base64, e.g. to read it with AI or save it to Drive. Files are kept for 30 days.",
  icon: "Smartphone",
  app: "whatsappWeb",
  keywords: ["whatsapp", "media", "photo", "image", "file", "download", "screenshot"],
  fields: [{ kind: "string", name: "mediaId", label: "Media ID", required: true, default: "${['$input']['media']['id']}" }],
  outputSample: { mediaId: "6b03c9683b77f9c37e43d41d", mimetype: "image/jpeg", fileName: null, size: 48211, base64: "/9j/4AAQSkZJRgABAQ…" },
};

export const whatsappWebGroups: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.groups",
  name: "WhatsApp (linked phone): list groups",
  description: "The groups your linked number is in, one item each, with their chat ids.",
  icon: "Smartphone",
  app: "whatsappWeb",
  keywords: ["whatsapp", "groups", "list", "chat id"],
  fields: [credential, { kind: "string", name: "nameContains", label: "Name contains", placeholder: "Optional" }],
  outputSample: { chatId: "120363042712345678@g.us", name: "Sales team", members: 8 },
};

export const WHATSAPP_WEB_ACTION_DEFINITIONS: NodeDefinition[] = [whatsappWebSend, whatsappWebGetMedia, whatsappWebGroups];
