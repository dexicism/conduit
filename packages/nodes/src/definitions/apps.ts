import type { NodeDefinition, ParamField } from "../types";
import { MORE_APP_ACTION_DEFINITIONS } from "./apps-more";
import { WHATSAPP_WEB_ACTION_DEFINITIONS } from "./apps-whatsapp-web";

export { whatsappWebTrigger } from "./apps-whatsapp-web";

const credential = (app: string): ParamField => ({
  kind: "credential",
  name: "credential",
  label: "Account",
  app,
  required: true,
});

const action = {
  version: 1,
  category: "app" as const,
  color: "sky" as const,
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
};

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export const telegramTrigger: NodeDefinition = {
  type: "trigger.telegram",
  version: 1,
  name: "Telegram message",
  description: "Start when your Telegram bot receives a message. Publishing connects the bot to this workflow.",
  category: "trigger",
  icon: "Send",
  color: "amber",
  app: "telegram",
  keywords: ["telegram", "bot", "chat", "message"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [credential("telegram")],
  outputSample: {
    updateId: 100000001,
    message: {
      messageId: 42,
      text: "Hello bot",
      date: "2026-01-01T09:00:00.000Z",
      chat: { id: 123456789, type: "private", title: null, username: "ana" },
      from: { id: 123456789, firstName: "Ana", lastName: null, username: "ana", languageCode: "en" },
    },
  },
};

export const telegramSend: NodeDefinition = {
  ...action,
  type: "app.telegram.send",
  name: "Telegram: send message",
  description: "Send a message from your bot to a chat.",
  icon: "Send",
  app: "telegram",
  keywords: ["telegram", "bot", "reply", "message", "notify"],
  asTool: { name: "send_telegram_message", description: "Send a Telegram message to a chat." },
  fields: [
    credential("telegram"),
    { kind: "string", name: "chatId", label: "Chat ID", required: true, description: "Use the chat ID from the Telegram trigger, e.g. message.chat.id." },
    { kind: "string", name: "text", label: "Text", required: true, multiline: true },
    {
      kind: "select",
      name: "parseMode",
      label: "Formatting",
      default: "none",
      options: [
        { value: "none", label: "Plain text" },
        { value: "HTML", label: "HTML" },
        { value: "MarkdownV2", label: "MarkdownV2" },
      ],
    },
  ],
  outputSample: { messageId: 43, chatId: 123456789, date: "2026-01-01T09:00:01.000Z", text: "Hi Ana!" },
};

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export const slackSend: NodeDefinition = {
  ...action,
  type: "app.slack.send",
  name: "Slack: send message",
  description: "Post a message to a Slack channel.",
  icon: "Hash",
  app: "slack",
  keywords: ["slack", "chat", "notify", "channel", "post"],
  asTool: { name: "send_slack_message", description: "Post a message to a Slack channel." },
  fields: [
    credential("slack"),
    { kind: "string", name: "channel", label: "Channel", required: true, placeholder: "#general or C0123456", dynamicOptions: "slack.channels" },
    { kind: "string", name: "text", label: "Text", required: true, multiline: true, description: "Slack mrkdwn formatting works here." },
  ],
  outputSample: { ok: true, channel: "C0123456", ts: "1767258000.000100" },
};

// ---------------------------------------------------------------------------
// WhatsApp Cloud API
// ---------------------------------------------------------------------------

export const whatsappTrigger: NodeDefinition = {
  type: "trigger.whatsapp",
  version: 1,
  name: "WhatsApp message",
  description:
    "Start when someone messages your WhatsApp Business number. Needs the app secret and verify token on the connection, and Meta needs a public address to send to (see Connections).",
  category: "trigger",
  icon: "MessageCircle",
  color: "amber",
  app: "whatsapp",
  keywords: ["whatsapp", "waba", "message", "chat", "incoming", "bot"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [credential("whatsapp")],
  outputSample: {
    messageId: "wamid.HBgLNjI4MTIzNDU2Nzg5MBUCABIYFjNFQjA",
    from: "6281234567890",
    name: "Ana",
    type: "text",
    text: "Hi, are you open today?",
    mediaId: null,
    timestamp: "2026-01-01T09:00:00.000Z",
    phoneNumberId: "1234567890",
    displayPhoneNumber: "15550001111",
  },
};

export const whatsappSend: NodeDefinition = {
  ...action,
  type: "app.whatsapp.send",
  name: "WhatsApp: send message",
  description: "Send a WhatsApp message from your business number. Outside a 24-hour reply window, WhatsApp only allows approved templates.",
  icon: "MessageCircle",
  app: "whatsapp",
  keywords: ["whatsapp", "waba", "message", "chat", "notify", "sms"],
  asTool: { name: "send_whatsapp_message", description: "Send a WhatsApp text message to a phone number." },
  fields: [
    credential("whatsapp"),
    { kind: "string", name: "to", label: "To", required: true, placeholder: "+6281234567890", description: "Phone number in international format." },
    {
      kind: "select",
      name: "messageType",
      label: "Message",
      default: "text",
      options: [
        { value: "text", label: "Text (replies within 24 hours)" },
        { value: "template", label: "Approved template" },
      ],
    },
    { kind: "string", name: "text", label: "Text", required: true, multiline: true, showIf: { field: "messageType", equals: ["text"] } },
    { kind: "string", name: "templateName", label: "Template name", required: true, expression: false, showIf: { field: "messageType", equals: ["template"] } },
    { kind: "string", name: "languageCode", label: "Template language", default: "en_US", expression: false, showIf: { field: "messageType", equals: ["template"] } },
    {
      kind: "keyValue",
      name: "templateValues",
      label: "Template values",
      description: "Fill {{1}}, {{2}}… in the template body, in order.",
      keyPlaceholder: "1",
      valuePlaceholder: "Value",
      showIf: { field: "messageType", equals: ["template"] },
    },
  ],
  outputSample: { messageId: "wamid.HBgLNjI4MTIzNDU2Nzg5MBUCABEYEjQ2", to: "6281234567890" },
};

// ---------------------------------------------------------------------------
// Google: Gmail, Sheets and Calendar
// ---------------------------------------------------------------------------

export const gmailSend: NodeDefinition = {
  ...action,
  type: "app.gmail.send",
  name: "Gmail: send email",
  description: "Send an email from your Gmail account.",
  icon: "Mail",
  app: "google",
  keywords: ["gmail", "google", "email", "mail", "send"],
  asTool: { name: "send_gmail", description: "Send an email from the connected Gmail account." },
  fields: [
    credential("google"),
    { kind: "string", name: "to", label: "To", required: true, placeholder: "ana@example.com", description: "Separate several addresses with commas." },
    { kind: "string", name: "subject", label: "Subject", required: true },
    {
      kind: "select",
      name: "bodyType",
      label: "Body type",
      default: "text",
      options: [
        { value: "text", label: "Plain text" },
        { value: "html", label: "HTML" },
      ],
    },
    { kind: "string", name: "body", label: "Body", required: true, multiline: true },
  ],
  outputSample: { id: "18c0f0c0c0c0c0c0", threadId: "18c0f0c0c0c0c0c0" },
};

const sheetFields = (): ParamField[] => [
  credential("google"),
  {
    kind: "string",
    name: "spreadsheetId",
    label: "Spreadsheet",
    required: true,
    placeholder: "Spreadsheet URL or ID",
    description: "Paste the spreadsheet's URL or its ID.",
  },
  { kind: "string", name: "sheet", label: "Sheet", required: true, default: "Sheet1", dynamicOptions: "google.sheets" },
];


/** "Log changes to an activity tab", shared by add row and update row. */
const activityFields = (): ParamField[] => [
  {
    kind: "string",
    name: "activitySheet",
    label: "Log changes to tab",
    expression: false,
    placeholder: "Activity (optional)",
    description: "Writes who changed what to this tab (columns When, Who, Tab, Row, Name, Change). Leave empty for no log.",
  },
  { kind: "string", name: "activityBy", label: "Changed by", placeholder: "${['who']['person']['name']}" },
];

export const sheetsText: NodeDefinition = {
  ...action,
  type: "app.sheets.text",
  name: "Google Sheets: read tab as text",
  description: "Reads a whole tab as plain text, like a list of rules, a price list or notes, to put into an AI step's instructions. Kept for a few minutes so it isn't read on every message.",
  icon: "Sheet",
  app: "google",
  keywords: ["google", "sheets", "rules", "instructions", "text", "notes", "price list", "read"],
  asTool: { name: "read_sheet_text", description: "Read a whole tab of the Google Sheet as text." },
  fields: [
    ...sheetFields(),
    { kind: "number", name: "cacheMinutes", label: "Keep for (minutes)", default: 10, min: 0, max: 1440 },
    {
      kind: "select",
      name: "ifMissing",
      label: "If the tab doesn't exist",
      default: "empty",
      options: [
        { value: "empty", label: "Carry on with empty text" },
        { value: "fail", label: "Stop with an error" },
      ],
    },
  ],
  outputSample: { text: "Bot Rules:\n- Quotations go out within 2 days of a site visit\n- No customer messages after 8 pm", lines: 2, missing: false },
};

const followupBase = (): ParamField[] => [
  ...sheetFields().map((f): ParamField => (f.name === "sheet" && f.kind === "string" ? { ...f, default: "Follow-ups" } : f)),
];

export const followupsAsk: NodeDefinition = {
  ...action,
  type: "app.followups.ask",
  name: "Follow-ups: ask someone",
  description:
    "Sends a question on WhatsApp (\"Is the quotation for Mohan ready?\"), writes it to a Follow-ups tab and puts it in the person's shared memory, so the assistant understands their reply. Won't ask the same thing twice while the first is still waiting. Tab columns: ID, Asked At, Person, Phone, About, Question, Status, Reminders, Next Reminder, Answer.",
  icon: "MessageCircleQuestion",
  app: "google",
  keywords: ["follow up", "ask", "question", "check", "supervisor", "chase", "whatsapp", "reminder"],
  asTool: { name: "ask_followup", description: "Ask a team member a question on WhatsApp and keep track of it until they answer (they get reminders if they don't)." },
  fields: [
    ...followupBase(),
    { kind: "credential", name: "whatsapp", label: "WhatsApp number", app: "whatsappWeb", required: true },
    { kind: "string", name: "person", label: "Person", aiFill: true, placeholder: "Ravi" },
    { kind: "string", name: "phone", label: "Phone", aiFill: true, placeholder: "Found from the team tab if empty" },
    { kind: "string", name: "phonesFrom", label: "Team tab for phone numbers", expression: false, placeholder: "Team" },
    { kind: "string", name: "about", label: "About", aiFill: true, placeholder: "Lead or task, e.g. Mohan" },
    { kind: "string", name: "question", label: "Question", required: true, multiline: true, aiFill: true },
    { kind: "number", name: "waitMinutes", label: "Remind after (minutes)", default: 60, min: 5, max: 10080 },
    { kind: "string", name: "label", label: "Shown in memory as", default: "Checker asked", expression: false },
  ],
  outputSample: { status: "asked", id: "F7", person: "Ravi", phone: "+91 98000 00001", about: "Mohan", messageId: "3EB0D2F1A9C8B7E6" },
};

export const followupsRemind: NodeDefinition = {
  ...action,
  type: "app.followups.remind",
  name: "Follow-ups: remind or give up",
  description:
    "Run it every hour or so. Questions still waiting past their time get a WhatsApp reminder; after the set number of reminders they're marked \"No reply\" and come out with action = gave_up, so you can tell the owner. No AI needed.",
  icon: "AlarmClock",
  app: "google",
  keywords: ["follow up", "reminder", "chase", "no reply", "supervisor", "check"],
  fields: [
    ...followupBase(),
    { kind: "credential", name: "whatsapp", label: "WhatsApp number", app: "whatsappWeb", required: true },
    { kind: "number", name: "maxReminders", label: "Reminders before giving up", default: 2, min: 0, max: 10 },
    { kind: "number", name: "waitMinutes", label: "Minutes between reminders", default: 60, min: 5, max: 10080 },
    { kind: "string", name: "reminderPrefix", label: "Reminder starts with", default: "Reminder:", expression: false },
    { kind: "string", name: "label", label: "Shown in memory as", default: "Checker reminded", expression: false },
  ],
  outputSample: { action: "reminded", id: "F7", person: "Ravi", phone: "+91 98000 00001", about: "Mohan", question: "Is the quotation for Mohan ready?", askedAt: "26-11-26 14:05", reminders: 1, row: 8 },
};

export const followupsAnswered: NodeDefinition = {
  ...action,
  type: "app.followups.answered",
  name: "Follow-ups: mark answered",
  description: "When someone writes in, their questions that are still waiting are marked Answered, with their message as the answer. Put it right after the WhatsApp trigger.",
  icon: "CheckCheck",
  app: "google",
  keywords: ["follow up", "answered", "reply", "done"],
  fields: [
    ...followupBase(),
    { kind: "string", name: "phone", label: "Their phone", default: "${['$input']['from']}" },
    { kind: "string", name: "answer", label: "Answer", default: "${['$input']['text']}" },
    {
      kind: "select",
      name: "ifMissing",
      label: "If the tab doesn't exist",
      default: "empty",
      options: [
        { value: "empty", label: "Carry on" },
        { value: "fail", label: "Stop with an error" },
      ],
    },
  ],
  outputSample: { marked: 1, about: ["Mohan"] },
};

export const sheetsAppend: NodeDefinition = {
  ...action,
  type: "app.sheets.append",
  name: "Google Sheets: add row",
  description: "Add a row, matching values to the sheet's header row by column name.",
  icon: "Sheet",
  app: "google",
  keywords: ["google", "sheets", "spreadsheet", "row", "append", "log"],
  asTool: { name: "add_sheet_row", description: "Add a row to the Google Sheet." },
  fields: [
    ...sheetFields(),
    {
      kind: "keyValue",
      name: "columns",
      label: "Columns",
      required: true,
      keyPlaceholder: "Column header",
      valuePlaceholder: "Value",
      description: "Names must match the sheet's first row. Columns you leave out stay empty.",
    },
    ...activityFields(),
  ],
  outputSample: { updatedRange: "Sheet1!A5:C5", row: 5, values: { Name: "Ana", Email: "ana@example.com" } },
};

export const sheetsRead: NodeDefinition = {
  ...action,
  type: "app.sheets.read",
  name: "Google Sheets: read rows",
  description: "Read rows as items, using the header row as field names.",
  icon: "Sheet",
  app: "google",
  keywords: ["google", "sheets", "spreadsheet", "rows", "read", "lookup"],
  asTool: { name: "read_sheet_rows", description: "Read rows from the Google Sheet." },
  fields: [...sheetFields(), { kind: "number", name: "limit", label: "Max rows", default: 100, min: 1, max: 5000 }],
  outputSample: { row: 2, Name: "Ana", Email: "ana@example.com" },
};

export const tasksAdd: NodeDefinition = {
  ...action,
  type: "app.tasks.add",
  name: "Task log: add task",
  description:
    "Add a task to a Tasks tab in your Google Sheet (columns like ID, Task, Customer, Assigned to, Phone, Status, Due, Created by, Created). First checks whether someone already has an open task for the same customer: then nothing is added and you get status = conflict with who's on it.",
  icon: "ListTodo",
  app: "google",
  keywords: ["task", "todo", "assign", "log", "conflict", "duplicate", "follow up", "team"],
  asTool: { name: "add_task", description: "Add a task to the team's task log. If someone already has an open task for that customer, it says who instead of adding one." },
  fields: [
    ...sheetFields().map((f): ParamField => (f.name === "sheet" && f.kind === "string" ? { ...f, default: "Tasks" } : f)),
    { kind: "string", name: "task", label: "Task", required: true, aiFill: true, placeholder: "Call Mehta about the quote" },
    { kind: "string", name: "customer", label: "Customer", aiFill: true, description: "Used for the duplicate check. Without it, the task text is compared instead." },
    { kind: "string", name: "assignee", label: "Assigned to", aiFill: true, placeholder: "Ravi" },
    { kind: "string", name: "assigneePhone", label: "Their phone", aiFill: true },
    { kind: "string", name: "due", label: "Due", aiFill: true, placeholder: "2026-12-01" },
    { kind: "string", name: "createdBy", label: "Created by", placeholder: "${['$input']['person']['name']}" },
    { kind: "string", name: "initialStatus", label: "Status", default: "Open", expression: false },
    {
      kind: "select",
      name: "onConflict",
      label: "If someone's already on it",
      default: "report",
      options: [
        { value: "report", label: "Don't add; say who has it (status = conflict)" },
        { value: "add", label: "Add it anyway" },
      ],
    },
  ],
  outputSample: { status: "added", id: "T12", row: 13, Task: "Call Mehta about the quote", Customer: "Mehta Traders", "Assigned to": "Ravi", Status: "Open", Due: "2026-12-01" },
};

export const tasksDue: NodeDefinition = {
  ...action,
  type: "app.tasks.due",
  name: "Task log: due tasks",
  description:
    "Reads the Tasks tab and gives you the open tasks that are overdue, due soon, or all of them, most overdue first. One item per task (to nudge each person), or one summary with a ready-to-send text (for a daily report). Done/closed tasks are left out.",
  icon: "CalendarClock",
  app: "google",
  keywords: ["task", "due", "overdue", "deadline", "follow up", "report", "check", "nudge"],
  asTool: { name: "due_tasks", description: "Get the team's open tasks that are overdue or due soon, from the task log." },
  fields: [
    ...sheetFields().map((f): ParamField => (f.name === "sheet" && f.kind === "string" ? { ...f, default: "Tasks" } : f)),
    {
      kind: "select",
      name: "which",
      label: "Which tasks",
      default: "due",
      options: [
        { value: "due", label: "Overdue or due within the next days" },
        { value: "overdue", label: "Only overdue" },
        { value: "open", label: "All open tasks" },
      ],
    },
    { kind: "number", name: "daysAhead", label: "Days ahead", default: 0, min: 0, max: 60, showIf: { field: "which", equals: ["due"] }, description: "0 = due today or overdue." },
    { kind: "string", name: "assignee", label: "Only for", placeholder: "Optional name", aiFill: true },
    {
      kind: "select",
      name: "output",
      label: "Output",
      default: "each",
      options: [
        { value: "each", label: "One item per task" },
        { value: "summary", label: "One summary (with a text you can send)" },
        { value: "person", label: "One item per person (all their tasks in one message)" },
      ],
    },
    { kind: "string", name: "timezone", label: "Time zone", expression: false, placeholder: "The server's (e.g. Asia/Kolkata)" },
    {
      kind: "string",
      name: "closedStatuses",
      label: "Finished statuses",
      default: "Done, Closed, Completed, Cancelled, Won, Lost",
      expression: false,
      description: "Rows with one of these statuses are left out. Separate them with commas.",
    },
    {
      kind: "string",
      name: "phonesFrom",
      label: "Team tab for phone numbers",
      expression: false,
      placeholder: "Team",
      description: "If your sheet has names in Assigned To but no phone numbers, give a tab with Name and Phone columns and each person's number is filled in from there.",
    },
    { kind: "string", name: "dueColumn", label: "Due date column", expression: false, placeholder: "Found automatically (Due, Next Follow-up…)" },
    { kind: "string", name: "nameColumn", label: "Name column", expression: false, placeholder: "Found automatically (Customer, Owner Name…)" },
    { kind: "string", name: "taskColumn", label: "Task column", expression: false, placeholder: "Found automatically (Task…); can be empty for a leads list" },
    { kind: "string", name: "assigneeColumn", label: "Assigned to column", expression: false, placeholder: "Found automatically (Assigned To…)" },
    { kind: "string", name: "statusColumn", label: "Status column", expression: false, placeholder: "Found automatically (Status)" },
  ],
  outputSample: { row: 2, id: "T2", what: "Send quote", task: "Send quote", customerPhone: null, notes: null, customer: "Mehta Traders", assignedTo: "Ravi", phone: "9812345678", status: "Open", due: "2026-11-28", dueDate: "2026-11-28", overdueDays: 2, createdBy: "Shadab", when: "2 days overdue" },
};

export const gmailSearch: NodeDefinition = {
  ...action,
  type: "app.gmail.search",
  name: "Gmail: find emails",
  description: "Search your mailbox with Gmail's own search (from:, subject:, is:unread, newer_than:2d…). One item per email, with the text. Needs the Google account reconnected once to allow reading.",
  icon: "Mail",
  app: "google",
  keywords: ["gmail", "email", "mail", "inbox", "search", "read", "unread"],
  asTool: { name: "search_email", description: "Search the owner's Gmail. Use Gmail search syntax, e.g. from:mehta newer_than:7d." },
  fields: [
    credential("google"),
    { kind: "string", name: "query", label: "Search", aiFill: true, placeholder: "is:unread newer_than:1d", description: "Gmail search, exactly like the search box in Gmail. Empty = latest emails." },
    { kind: "number", name: "limit", label: "Max emails", default: 5, min: 1, max: 25 },
  ],
  outputSample: { id: "18c2f…", threadId: "18c2f…", from: "Mehta <mehta@example.com>", to: "you@gmail.com", subject: "Order 42", date: "2026-01-01T09:00:00.000Z", unread: true, snippet: "Please send the quote…", body: "Please send the quote for 50 units." },
};

export const teamCheck: NodeDefinition = {
  version: 1,
  category: "app",
  color: "sky",
  inputs: [{ id: "main" }],
  outputs: [
    { id: "allowed", label: "allowed" },
    { id: "denied", label: "denied" },
  ],
  type: "app.team.check",
  name: "Team access check",
  description:
    "Looks up who's writing in a Team tab of your Google Sheet (columns Name, Phone, Role, Access) and sends them down allowed or denied. Adds a person object: name, role, canEdit, isOwner. Access: edit, view or blocked; a role with owner or boss is the owner.",
  icon: "ShieldCheck",
  app: "google",
  keywords: ["team", "access", "permission", "role", "owner", "employee", "allowed", "whitelist", "who"],
  fields: [
    ...sheetFields().map((f): ParamField => (f.name === "sheet" && f.kind === "string" ? { ...f, default: "Team" } : f)),
    { kind: "string", name: "phone", label: "Phone number to check", required: true, default: "${['$input']['from']}", description: "Usually the WhatsApp sender. Matched on digits, so +91 and leading zeros don't matter." },
    {
      kind: "select",
      name: "allow",
      label: "Allow",
      default: "known",
      options: [
        { value: "known", label: "Anyone on the team sheet (not blocked)" },
        { value: "edit", label: "Only people who can edit" },
        { value: "owner", label: "Only the owner" },
        { value: "roles", label: "Only these roles" },
      ],
    },
    { kind: "string", name: "roles", label: "Roles", required: true, expression: false, placeholder: "Owner, Manager", showIf: { field: "allow", equals: ["roles"] } },
  ],
  outputSample: {
    from: "919812345678",
    text: "Mehta paid 4500",
    person: { known: true, name: "Ravi", role: "Sales", access: "edit", canEdit: true, isOwner: false, phone: "+91 98123 45678", row: 3, details: { Name: "Ravi", Phone: "+91 98123 45678", Role: "Sales", Access: "edit" } },
  },
};

const matchField: ParamField = {
  kind: "select",
  name: "match",
  label: "Match",
  default: "equals",
  options: [
    { value: "equals", label: "Is exactly (ignoring case and spaces)" },
    { value: "contains", label: "Contains" },
    { value: "phone", label: "Same phone number (compares digits only)" },
  ],
};

export const sheetsFind: NodeDefinition = {
  ...action,
  type: "app.sheets.find",
  name: "Google Sheets: find rows",
  description: "Find the rows where a column matches a value, e.g. the customer with this phone number. Always outputs something: matching rows with found = true, or one item with found = false.",
  icon: "Sheet",
  app: "google",
  keywords: ["google", "sheets", "spreadsheet", "find", "search", "lookup", "customer", "row"],
  asTool: { name: "find_sheet_rows", description: "Find rows in the Google Sheet where a column matches a value." },
  fields: [
    ...sheetFields(),
    {
      kind: "string",
      name: "column",
      label: "Search in column",
      required: true,
      aiFill: true,
      placeholder: "Phone",
      description: "Or \"any\" to search every column. With \"Contains\", every word has to be somewhere in the row. Tab can also list several tabs: Enquiries, Architect Data.",
    },
    { kind: "string", name: "value", label: "Value", required: true, aiFill: true },
    matchField,
    {
      kind: "select",
      name: "ifNothing",
      label: "If nothing matches",
      default: "none",
      options: [
        { value: "none", label: "Say nothing was found" },
        { value: "widen", label: "Look in every column, then close spellings" },
      ],
      description: "Good for AI tools and names typed from memory: Rajes also finds Rajesh. Close matches have closeMatch = true.",
    },
    { kind: "number", name: "limit", label: "Max rows", default: 50, min: 1, max: 500 },
  ],
  outputSample: { found: true, row: 7, Name: "Mehta Traders", Phone: "9812345678", Status: "Quoted" },
};

export const sheetsUpdate: NodeDefinition = {
  ...action,
  type: "app.sheets.update",
  name: "Google Sheets: update row",
  description: "Change some cells in one row, found by a column value (e.g. the phone number) or by row number. Other cells stay as they are.",
  icon: "Sheet",
  app: "google",
  keywords: ["google", "sheets", "spreadsheet", "update", "edit", "change", "row", "upsert"],
  asTool: { name: "update_sheet_row", description: "Update cells in one row of the Google Sheet, found by a column value." },
  fields: [
    ...sheetFields(),
    {
      kind: "select",
      name: "findBy",
      label: "Which row",
      default: "value",
      options: [
        { value: "value", label: "The row where a column matches" },
        { value: "row", label: "A row number" },
      ],
    },
    { kind: "string", name: "column", label: "Find by column", required: true, aiFill: true, placeholder: "Phone", showIf: { field: "findBy", equals: ["value"] } },
    { kind: "string", name: "value", label: "Value", required: true, aiFill: true, showIf: { field: "findBy", equals: ["value"] } },
    { ...matchField, showIf: { field: "findBy", equals: ["value"] } },
    { kind: "string", name: "rowNumber", label: "Row number", required: true, placeholder: "${['$input']['row']}", showIf: { field: "findBy", equals: ["row"] } },
    {
      kind: "keyValue",
      name: "columns",
      label: "Set",
      required: true,
      keyPlaceholder: "Column header",
      valuePlaceholder: "New value",
      description: "Only these columns change.",
    },
    {
      kind: "select",
      name: "emptyValues",
      label: "Empty values",
      default: "clear",
      options: [
        { value: "clear", label: "Clear the cell" },
        { value: "keep", label: "Leave the cell as it is" },
      ],
      description: "Use \"Leave as it is\" when an AI fills the columns, so a column it has nothing for isn't wiped.",
    },
    {
      kind: "select",
      name: "ifMissing",
      label: "If no row matches",
      default: "fail",
      showIf: { field: "findBy", equals: ["value"] },
      options: [
        { value: "fail", label: "Stop with an error" },
        { value: "skip", label: "Do nothing (output action = not_found)" },
        { value: "add", label: "Add a new row" },
      ],
    },
    {
      kind: "select",
      name: "ifMany",
      label: "If several rows match",
      default: "first",
      showIf: { field: "findBy", equals: ["value"] },
      options: [
        { value: "first", label: "Update the first one" },
        { value: "fail", label: "Stop with an error (safer)" },
      ],
    },
    ...activityFields(),
  ],
  outputSample: { action: "updated", changed: { Status: { from: "Quoted", to: "Called" } }, row: 7, Name: "Mehta Traders", Phone: "9812345678", Status: "Called" },
};

// ---------------------------------------------------------------------------
// Databases and email
// ---------------------------------------------------------------------------

export const postgresQuery: NodeDefinition = {
  ...action,
  type: "app.postgres.query",
  name: "PostgreSQL: run query",
  description: "Run SQL and get one item per returned row. Use $1, $2… for values.",
  icon: "Database",
  app: "postgres",
  keywords: ["postgres", "postgresql", "sql", "database", "supabase", "query", "insert", "select"],
  asTool: { name: "run_sql", description: "Run a SQL query against the database and return the rows." },
  fields: [
    credential("postgres"),
    { kind: "string", name: "query", label: "Query", required: true, multiline: true, expression: false, placeholder: "select * from orders where email = $1" },
    {
      kind: "json",
      name: "values",
      label: "Values",
      default: "[]",
      description: 'JSON array for $1, $2…, e.g. ["${[\'$input\'][\'email\']}"]. Values are sent separately, never mixed into the SQL.',
    },
    { kind: "number", name: "timeoutSeconds", label: "Timeout (seconds)", default: 30, min: 1, max: 120 },
  ],
  outputSample: { id: 1, email: "ana@example.com" },
};

export const smtpSend: NodeDefinition = {
  ...action,
  type: "app.smtp.send",
  name: "Email: send (SMTP)",
  description: "Send an email through your SMTP server.",
  icon: "AtSign",
  app: "smtp",
  keywords: ["email", "smtp", "mail", "send", "notify"],
  asTool: { name: "send_email", description: "Send an email." },
  fields: [
    credential("smtp"),
    { kind: "string", name: "to", label: "To", required: true, description: "Separate several addresses with commas." },
    { kind: "string", name: "subject", label: "Subject", required: true },
    { kind: "string", name: "text", label: "Text", multiline: true, required: true },
    { kind: "string", name: "html", label: "HTML (optional)", multiline: true },
  ],
  outputSample: { messageId: "<abc@example.com>", accepted: ["ana@example.com"], rejected: [] },
};

export const calendarCreate: NodeDefinition = {
  ...action,
  type: "app.calendar.create",
  name: "Google Calendar: create event",
  description: "Add an event to a Google Calendar and optionally invite people.",
  icon: "CalendarPlus",
  app: "google",
  keywords: ["google", "calendar", "event", "meeting", "schedule", "booking", "invite"],
  asTool: { name: "create_calendar_event", description: "Create a Google Calendar event." },
  fields: [
    credential("google"),
    { kind: "string", name: "calendarId", label: "Calendar", default: "primary", description: "\"primary\" or a calendar ID from its settings." },
    { kind: "string", name: "summary", label: "Title", required: true },
    { kind: "string", name: "start", label: "Starts", required: true, placeholder: "2026-01-15T10:00:00", description: "Date and time, e.g. 2026-01-15T10:00:00 (or with an offset like +07:00)." },
    { kind: "string", name: "end", label: "Ends", required: true, placeholder: "2026-01-15T10:30:00" },
    { kind: "string", name: "timeZone", label: "Time zone", default: "UTC", placeholder: "Asia/Jakarta" },
    { kind: "string", name: "description", label: "Description", multiline: true },
    { kind: "string", name: "attendees", label: "Invite (emails)", description: "Separate several addresses with commas. They get Google's invitation email." },
  ],
  outputSample: { id: "abc123", htmlLink: "https://www.google.com/calendar/event?eid=abc123", status: "confirmed", start: "2026-01-15T10:00:00+07:00" },
};

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

const DRIVE_NOTE = "Conduit can only see Drive files it created, or that were opened with it.";

export const driveSave: NodeDefinition = {
  ...action,
  type: "app.drive.save",
  name: "Google Drive: save file",
  description: "Save text, CSV, JSON, Markdown or HTML as a file in Google Drive, or as a Google Doc or Sheet.",
  icon: "HardDrive",
  app: "google",
  keywords: ["google", "drive", "file", "save", "upload", "doc", "csv", "backup", "export"],
  asTool: { name: "save_drive_file", description: "Save text as a file in Google Drive." },
  fields: [
    credential("google"),
    { kind: "string", name: "fileName", label: "File name", required: true, placeholder: "report.csv" },
    { kind: "string", name: "content", label: "Content", required: true, multiline: true },
    {
      kind: "select",
      name: "fileType",
      label: "Content type",
      default: "text",
      options: [
        { value: "text", label: "Plain text" },
        { value: "csv", label: "CSV" },
        { value: "json", label: "JSON" },
        { value: "markdown", label: "Markdown" },
        { value: "html", label: "HTML" },
      ],
    },
    {
      kind: "select",
      name: "convert",
      label: "Save as",
      default: "none",
      options: [
        { value: "none", label: "A file of that type" },
        { value: "doc", label: "A Google Doc (from text, Markdown or HTML)" },
        { value: "sheet", label: "A Google Sheet (from CSV)" },
      ],
    },
    { kind: "string", name: "folder", label: "Folder", placeholder: "Folder link or ID (optional)", description: "Leave empty for My Drive." },
  ],
  outputSample: { id: "1AbCdEfGhIjKlMnOp", name: "report.csv", mimeType: "text/csv", link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" },
};

export const driveFind: NodeDefinition = {
  ...action,
  type: "app.drive.find",
  name: "Google Drive: find files",
  description: `List Drive files, newest first, one item per file. ${DRIVE_NOTE}`,
  icon: "HardDrive",
  app: "google",
  keywords: ["google", "drive", "file", "search", "list", "find"],
  asTool: { name: "find_drive_files", description: "Find files in Google Drive by name." },
  fields: [
    credential("google"),
    { kind: "string", name: "nameContains", label: "Name contains", placeholder: "report (optional)" },
    { kind: "number", name: "limit", label: "Max files", default: 20, min: 1, max: 100 },
  ],
  outputSample: { id: "1AbCdEfGhIjKlMnOp", name: "report.csv", mimeType: "text/csv", link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", modifiedTime: "2026-01-01T09:00:00.000Z", size: 120 },
};

export const driveRead: NodeDefinition = {
  ...action,
  type: "app.drive.read",
  name: "Google Drive: read file",
  description: `Read a text file, Google Doc (as text) or Google Sheet (as CSV). ${DRIVE_NOTE}`,
  icon: "HardDrive",
  app: "google",
  keywords: ["google", "drive", "file", "read", "download", "doc", "content"],
  asTool: { name: "read_drive_file", description: "Read the text of a Google Drive file." },
  fields: [credential("google"), { kind: "string", name: "file", label: "File", required: true, placeholder: "File link or ID" }],
  outputSample: { id: "1AbCdEfGhIjKlMnOp", name: "notes.txt", mimeType: "text/plain", content: "Hello" },
};

export const APP_ACTION_DEFINITIONS: readonly NodeDefinition[] = [
  telegramSend,
  slackSend,
  whatsappSend,
  calendarCreate,
  gmailSend,
  sheetsAppend,
  sheetsRead,
  sheetsFind,
  sheetsUpdate,
  gmailSearch,
  tasksAdd,
  tasksDue,
  sheetsText,
  followupsAsk,
  followupsRemind,
  followupsAnswered,
  driveSave,
  driveFind,
  driveRead,
  postgresQuery,
  smtpSend,
  ...MORE_APP_ACTION_DEFINITIONS,
  ...WHATSAPP_WEB_ACTION_DEFINITIONS,
];
