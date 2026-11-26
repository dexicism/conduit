import type { NodeDefinition, ParamField } from "../types";
import { documentFields } from "./documents";

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
      kind: "boolean",
      name: "selfChat",
      label: "Also answer my \"Message yourself\" chat",
      default: false,
      description: "Lets the person who owns this number talk to the workflow from their own phone, in WhatsApp's \"Message yourself\" chat.",
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
    {
      kind: "select",
      name: "allowFrom",
      label: "Listen to",
      default: "all",
      options: [
        { value: "all", label: "Everyone (or the numbers above)" },
        { value: "sheet", label: "Only people in a sheet tab (e.g. your Team tab)" },
      ],
      description: "With a sheet tab, messages from anyone not in its Phone column are dropped right away: no run, nothing stored. The list is read again every 2 minutes.",
    },
    { kind: "credential", name: "teamCredential", label: "Google account", app: "google", showIf: { field: "allowFrom", equals: ["sheet"] } },
    { kind: "string", name: "teamSpreadsheet", label: "Spreadsheet", expression: false, placeholder: "Spreadsheet URL or ID", showIf: { field: "allowFrom", equals: ["sheet"] } },
    { kind: "string", name: "teamTab", label: "Tab", default: "Team", expression: false, showIf: { field: "allowFrom", equals: ["sheet"] } },
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
    {
      kind: "boolean",
      name: "shareInChat",
      label: "Add to the person's shared memory",
      default: false,
      description: "AI steps with shared memory then know this was sent, so a reply like \"done\" makes sense to them.",
    },
    { kind: "string", name: "shareLabel", label: "Shown as", placeholder: "Checker asked", expression: false, showIf: { field: "shareInChat", equals: [true] } },
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

export const whatsappWebStatus: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.status",
  name: "WhatsApp (linked phone): connection status",
  description:
    "Checks that the number is connected. Put it after a schedule to get an email or a Telegram/ntfy message when WhatsApp has been logged out or offline for a while: alert turns true after the wait, and outageKey stays the same for one outage (pair it with Only new items to be told once).",
  icon: "Smartphone",
  app: "whatsappWeb",
  keywords: ["whatsapp", "status", "connected", "offline", "logged out", "health", "monitor", "alert"],
  fields: [credential, { kind: "number", name: "alertAfterMinutes", label: "Alert after (minutes down)", default: 10, min: 0, max: 1440 }],
  outputSample: { ok: false, status: "logged_out", workerRunning: true, phone: "919876543210", error: "Logged out on the phone. Link it again.", since: "2026-11-27T02:10:00.000Z", downMinutes: 25, alert: true, outageKey: "logged_out|2026-11-27T02:10:00.000Z", text: "WhatsApp +919876543210 is logged out (link the phone again under Connected apps) for 25 min." },
};

export const whatsappWebSchedule: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.schedule",
  name: "WhatsApp (linked phone): send later",
  description: "Schedule a message for later, e.g. a reminder to the owner on Friday at 9. If Conduit is off at that time, it goes out as soon as it's back.",
  icon: "AlarmClock",
  app: "whatsappWeb",
  keywords: ["whatsapp", "remind", "reminder", "later", "schedule", "follow up", "alarm"],
  asTool: { name: "set_reminder", description: "Send a WhatsApp message later. When: a date and time like 2026-11-28 09:00, tomorrow 9am, or in 2 hours." },
  fields: [
    credential,
    { kind: "string", name: "to", label: "To", required: true, placeholder: "+919876543210 or a chat id", aiFill: true },
    { kind: "string", name: "text", label: "Message", required: true, multiline: true, aiFill: true },
    { kind: "string", name: "when", label: "When", required: true, aiFill: true, placeholder: "tomorrow 9am", description: "2026-11-28 09:00, tomorrow 9am, today 18:30, or in 2 hours." },
    { kind: "string", name: "timezone", label: "Time zone", expression: false, placeholder: "The server's (e.g. Asia/Kolkata)" },
    { kind: "string", name: "createdBy", label: "Set by", placeholder: "${['$input']['person']['name']}" },
  ],
  outputSample: { reminderId: "6b04a1c2e3f4a5b6c7d8e9f0", to: "919876543210@s.whatsapp.net", dueAt: "2026-11-28T03:30:00.000Z", dueLocal: "28 Nov 2026, 09:00", timezone: "Asia/Kolkata" },
};

export const whatsappWebReminders: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.reminders",
  name: "WhatsApp (linked phone): reminders",
  description: "List the messages scheduled for later (optionally for one person), or cancel one by its ID.",
  icon: "AlarmClock",
  app: "whatsappWeb",
  keywords: ["whatsapp", "reminders", "scheduled", "cancel", "list"],
  asTool: { name: "manage_reminders", description: "List scheduled WhatsApp reminders, or cancel one by ID (action: list or cancel)." },
  fields: [
    credential,
    {
      kind: "select",
      name: "action",
      label: "Action",
      default: "list",
      options: [
        { value: "list", label: "List the pending ones" },
        { value: "cancel", label: "Cancel one" },
      ],
    },
    { kind: "string", name: "to", label: "Only for", placeholder: "Optional phone number", aiFill: true, showIf: { field: "action", equals: ["list"] } },
    { kind: "string", name: "reminderId", label: "Reminder ID", required: true, aiFill: true, showIf: { field: "action", equals: ["cancel"] } },
  ],
  outputSample: { found: true, id: "6b04a1c2e3f4a5b6c7d8e9f0", to: "919876543210@s.whatsapp.net", text: "GST payment is due today", dueAt: "2026-11-28T03:30:00.000Z", createdBy: "Shadab" },
};

export const whatsappWebBroadcast: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.broadcast",
  name: "WhatsApp (linked phone): send to many",
  description:
    "The same message to a list of people, one by one with a random gap between them (5 to 15 seconds by default), because instant blasts get numbers banned. At most 200 at a time.",
  icon: "Megaphone",
  app: "whatsappWeb",
  keywords: ["whatsapp", "broadcast", "everyone", "team", "announce", "bulk", "send to all"],
  asTool: { name: "message_everyone", description: "Send one WhatsApp message to several phone numbers (comma separated)." },
  fields: [
    credential,
    { kind: "string", name: "numbers", label: "Phone numbers", required: true, multiline: true, aiFill: true, placeholder: "+919812345678, +919811112222", description: "Separated by commas or lines, or a list from another step." },
    { kind: "string", name: "text", label: "Message", required: true, multiline: true, aiFill: true },
    { kind: "number", name: "minGapSeconds", label: "Gap at least (seconds)", default: 5, min: 2, max: 600 },
    { kind: "number", name: "maxGapSeconds", label: "Gap at most (seconds)", default: 15, min: 2, max: 600 },
  ],
  outputSample: { queued: 3, recipients: ["919812345678@s.whatsapp.net"], invalid: [], lastAt: "2026-11-27T09:00:30.000Z" },
};

export const whatsappWebSendDocument: NodeDefinition = {
  ...action,
  type: "app.whatsappWeb.sendDocument",
  name: "WhatsApp (linked phone): send a PDF",
  description: "Make a PDF (quotation, invoice, list) from a title, text and a table, and send it on WhatsApp, in one step. Qty × Price amounts and the total are worked out for you.",
  icon: "FileText",
  app: "whatsappWeb",
  keywords: ["whatsapp", "pdf", "quotation", "quote", "invoice", "document", "send", "file", "estimate"],
  asTool: {
    name: "send_document",
    description: "Make a PDF (like a quotation or invoice) and send it on WhatsApp. Table: lines like 'Item | Qty | Price' then one line per item.",
  },
  fields: [
    credential,
    { kind: "string", name: "to", label: "To", required: true, placeholder: "+919876543210 or a chat id", aiFill: true },
    { kind: "string", name: "caption", label: "Message with it", multiline: true, aiFill: true },
    ...documentFields(true),
    {
      kind: "boolean",
      name: "shareInChat",
      label: "Add to the person's shared memory",
      default: false,
      description: "AI steps with shared memory then know this was sent, so a reply like \"done\" makes sense to them.",
    },
    { kind: "string", name: "shareLabel", label: "Shown as", placeholder: "Checker asked", expression: false, showIf: { field: "shareInChat", equals: [true] } },
  ],
  outputSample: { messageId: "3EB0D2F1A9C8B7E6", chatId: "919876543210@s.whatsapp.net", fileName: "quotation-mehta.pdf", pages: 1, total: 10000 },
};

export const WHATSAPP_WEB_ACTION_DEFINITIONS: NodeDefinition[] = [
  whatsappWebSendDocument,
  whatsappWebSend,
  whatsappWebSchedule,
  whatsappWebReminders,
  whatsappWebBroadcast,
  whatsappWebGetMedia,
  whatsappWebGroups,
  whatsappWebStatus,
];
