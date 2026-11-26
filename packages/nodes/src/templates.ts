import { defaultParameters, getDefinition } from "./registry";
import { AGENT_HANDLE, TOOL_HANDLE } from "./types";

/**
 * Ready-made workflows you can start from. Account fields are left empty on
 * purpose: the editor flags them, and you pick your own accounts.
 */

interface TemplateStep {
  id: string;
  type: string;
  label: string;
  parameters?: Record<string, unknown>;
  /** Targets of the main output. */
  to?: string[];
  /** Targets of other outputs, by handle (e.g. an If's true/false). */
  routes?: Record<string, string[]>;
  /** Tool steps attached to this AI agent. */
  tools?: string[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** Apps you'll need to connect (Connections page ids). */
  apps: string[];
  needsAi?: boolean;
  /** Something to do after creating it, shown on the card. */
  setup?: string;
  steps: TemplateStep[];
}

const TEAM_PROMPT =
  "You're the team's assistant on WhatsApp. Customer records are in the Customers tab of the Google Sheet; use your tools to look them up or change them, and never make up data. Reply briefly in the language the person writes in.";

/** "Add a task" with the conflict check, for team agents. */
function TASK(id: string): TemplateStep {
  return {
    id,
    type: "tool.app.tasks.add",
    label: "Add a task",
    parameters: {
      toolName: "add_task",
      toolDescription: "Add a task to the Tasks tab and assign it. If someone already has an open task for that customer, it returns status conflict and who it is: tell the person instead of adding.",
      sheet: "Tasks",
      task: "={{AI('task', `What needs doing`, 'string')}}",
      customer: "={{AI('customer', `Customer it's about, if any`, 'string')}}",
      assignee: "={{AI('assignee', `Name of the person it's for`, 'string')}}",
      assigneePhone: "={{AI('phone', `Their phone number, from the Team tab`, 'string')}}",
      due: "={{AI('due', `Due date like 2026-11-28, or empty`, 'string')}}",
      createdBy: "${['who']['person']['name']}",
      onConflict: "report",
    },
  };
}

/** "Send this later" for team agents. */
function REMIND(id: string): TemplateStep {
  return {
    id,
    type: "tool.app.whatsappWeb.schedule",
    label: "Set a reminder",
    parameters: {
      toolName: "set_reminder",
      toolDescription: "Send a WhatsApp message later, e.g. remind the owner on Friday. When: 2026-11-28 09:00, tomorrow 9am, or in 2 hours.",
      to: "={{AI('to', `Phone number to remind, international format`, 'string')}}",
      text: "={{AI('text', `The reminder message`, 'string')}}",
      when: "={{AI('when', `When to send it`, 'string')}}",
      createdBy: "${['who']['person']['name']}",
    },
  };
}

/** "Update a task" (status, due date, notes) for team agents. */
function TASK_UPDATE(id: string): TemplateStep {
  return {
    id,
    type: "tool.app.sheets.update",
    label: "Update a task",
    parameters: {
      toolName: "update_task",
      toolDescription: "Change a task in the Tasks tab, found by its ID (like T12): mark it Done, move the due date, or reassign it. Use when someone reports progress.",
      sheet: "Tasks",
      findBy: "value",
      column: "ID",
      value: "={{AI('id', `Task ID, e.g. T12`, 'string')}}",
      match: "equals",
      columns: [
        { key: "Status", value: "={{AI('status', `Open, In progress or Done; the current one if unchanged`, 'string')}}" },
        { key: "Due", value: "={{AI('due', `Due date like 2026-11-28; the current one if unchanged`, 'string')}}" },
        { key: "Assigned to", value: "={{AI('assignedTo', `Who it's assigned to; the current person if unchanged`, 'string')}}" },
      ],
      ifMissing: "fail",
      ifMany: "fail",
    },
  };
}

/** A "find customers" tool for one of the team agents. */
function FIND(id: string): TemplateStep {
  return {
    id,
    type: "tool.app.sheets.find",
    label: "Look up customers",
    parameters: {
      toolName: "find_customers",
      toolDescription: "Find customers in the Customers tab. Search a column (e.g. Customer, Phone, Status) for a value.",
      sheet: "Customers",
      column: "={{AI('column', `Column to search: Customer, Phone, Status…`, 'string')}}",
      value: "={{AI('value', `What to look for`, 'string')}}",
      match: "contains",
      limit: 20,
    },
  };
}

/** An "update a customer" tool for the agents allowed to change data. */
function UPDATE(id: string): TemplateStep {
  return {
    id,
    type: "tool.app.sheets.update",
    label: "Update a customer",
    parameters: {
      toolName: "update_customer",
      toolDescription: "Change one customer's row in the Customers tab: find it by the Customer column, then set the given columns. Only use when someone asks for a change.",
      sheet: "Customers",
      findBy: "value",
      column: "Customer",
      value: "={{AI('customer', `The customer name exactly as in the sheet`, 'string')}}",
      match: "equals",
      columns: [
        { key: "Status", value: "={{AI('status', `New status, or the current one if unchanged`, 'string')}}" },
        { key: "Notes", value: "={{AI('notes', `New notes, or the current ones if unchanged`, 'string')}}" },
      ],
      ifMissing: "fail",
      ifMany: "fail",
    },
  };
}

const SUPPORT_PROMPT = "You are a friendly assistant. Reply briefly (1-3 sentences) in the language the person writes in.";

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "telegram-ai-bot",
    name: "AI Telegram bot",
    description: "Answers every message to your Telegram bot with AI, and remembers the conversation.",
    apps: ["telegram"],
    needsAi: true,
    steps: [
      { id: "tg", type: "trigger.telegram", label: "Message to the bot", to: ["ai"] },
      {
        id: "ai",
        type: "ai.agent",
        label: "Write a reply",
        parameters: {
          instructions: SUPPORT_PROMPT,
          prompt: "${['$input']['message']['text']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['$input']['message']['chat']['id']}",
          memoryTurns: 10,
        },
        to: ["reply"],
      },
      { id: "reply", type: "app.telegram.send", label: "Send the reply", parameters: { chatId: "${['tg']['message']['chat']['id']}", text: "${['$input']['output']}" } },
    ],
  },
  {
    id: "whatsapp-phone-assistant",
    name: "AI assistant on your WhatsApp number",
    description: "Links a normal WhatsApp number (like WhatsApp Web). Answers private chats, and in groups replies when someone @mentions it. Remembers each chat.",
    apps: ["whatsappWeb"],
    needsAi: true,
    setup: "Add WhatsApp (linked phone) under Connected apps and scan the QR code, then pick it in the first and last steps and publish.",
    steps: [
      { id: "wa", type: "trigger.whatsappWeb", label: "WhatsApp message", parameters: { groupMode: "mentioned" }, to: ["ai"] },
      {
        id: "ai",
        type: "ai.agent",
        label: "Write a reply",
        parameters: {
          instructions: `${SUPPORT_PROMPT} In group chats, keep it short and only answer what was asked.`,
          prompt: "${['$input']['fromName']} wrote: ${['$input']['text']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['$input']['chatId']}",
          memoryTurns: 10,
        },
        to: ["reply"],
      },
      { id: "reply", type: "app.whatsappWeb.send", label: "Send the reply", parameters: { to: "${['wa']['chatId']}", text: "${['$input']['output']}" } },
    ],
  },
  {
    id: "team-assistant",
    name: "Team assistant with roles",
    description:
      "One WhatsApp number for your whole team. It checks who's writing against a Team tab in your Google Sheet: the owner can look things up, update customers, assign tasks (it tells you if someone's already on it), set reminders, message one person or everyone, and search email; editors can look up, update, add tasks and set reminders; everyone else can only ask. Strangers are ignored.",
    apps: ["whatsappWeb", "google"],
    needsAi: true,
    setup:
      "In your Google Sheet, add a Team tab with the columns Name, Phone, Role and Access (edit, view or blocked; a role of Owner or Boss is the owner), a Customers tab, and a Tasks tab with ID, Task, Customer, Assigned to, Phone, Status, Due, Created by, Created. Paste the sheet link into the access check and every sheet tool, pick your linked number and Google account in each step, and add a variable COMPANY_DETAILS (your company name and address, used on PDFs).",
    steps: [
      { id: "wa", type: "trigger.whatsappWeb", label: "WhatsApp message", parameters: { chats: "all", groupMode: "mentioned" }, to: ["who"] },
      { id: "who", type: "app.team.check", label: "Who is this?", parameters: { sheet: "Team", allow: "known" }, routes: { allowed: ["owner"] } },
      {
        id: "owner",
        type: "flow.if",
        label: "The owner?",
        parameters: { conditions: { combinator: "and", rules: [{ id: "r1", left: "${['$input']['person']['isOwner']}", operator: "isTrue", right: "" }] } },
        routes: { true: ["boss"], false: ["editor"] },
      },
      {
        id: "editor",
        type: "flow.if",
        label: "Can edit?",
        parameters: { conditions: { combinator: "and", rules: [{ id: "r1", left: "${['$input']['person']['canEdit']}", operator: "isTrue", right: "" }] } },
        routes: { true: ["staff"], false: ["viewer"] },
      },
      {
        id: "boss",
        type: "ai.agent",
        label: "Owner's assistant",
        parameters: {
          instructions: `${TEAM_PROMPT} You're talking to the owner. You can look up and update customers, add and assign tasks (the task log warns you if someone's already on it: then tell the owner who), set reminders, message one person or the whole team, send quotations and other documents as PDFs, and search and send email (always say what you'll send first). Before messaging anyone else, say exactly what you'll send.`,
          prompt: "${['$input']['person']['name']} (owner) wrote: ${['wa']['text']}",
          image: "${['wa']['media']['id']}",
          effort: "medium",
          memory: "window",
          sessionKey: "${['wa']['chatId']}",
          memoryTurns: 10,
        },
        tools: ["boss_find", "boss_update", "boss_task", "boss_taskupdate", "boss_remind", "boss_send", "boss_everyone", "boss_reminders", "boss_cancel", "boss_team", "boss_mail", "boss_email", "boss_pdf"],
        to: ["reply"],
      },
      {
        id: "staff",
        type: "ai.agent",
        label: "Staff assistant",
        parameters: {
          instructions: `${TEAM_PROMPT} You're talking to a team member who may update customer records, add tasks and set reminders. Only change what they clearly asked for. If a task is already someone else's, tell them who's handling it.`,
          prompt: "${['$input']['person']['name']} (${['$input']['person']['role']}) wrote: ${['wa']['text']}",
          image: "${['wa']['media']['id']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['wa']['chatId']}",
          memoryTurns: 10,
        },
        tools: ["staff_find", "staff_update", "staff_task", "staff_taskupdate", "staff_remind"],
        to: ["reply"],
      },
      {
        id: "viewer",
        type: "ai.agent",
        label: "Read-only assistant",
        parameters: {
          instructions: `${TEAM_PROMPT} This person can look things up but not change anything. If they ask for a change, tell them who on the team can do it.`,
          prompt: "${['$input']['person']['name']} (${['$input']['person']['role']}) wrote: ${['wa']['text']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['wa']['chatId']}",
          memoryTurns: 10,
        },
        tools: ["viewer_find"],
        to: ["reply"],
      },
      { id: "reply", type: "app.whatsappWeb.send", label: "Reply", parameters: { to: "${['wa']['chatId']}", text: "${['$input']['output']}" } },
      FIND("boss_find"),
      UPDATE("boss_update"),
      {
        id: "boss_send",
        type: "tool.app.whatsappWeb.send",
        label: "Message someone",
        parameters: { toolName: "send_whatsapp", toolDescription: "Send a WhatsApp message to a phone number, for the owner.", to: "={{AI('to', `Phone number in international format, e.g. +919876543210`, 'string')}}", text: "={{AI('text', `The message to send`, 'string')}}", fileSource: "none" },
      },
      {
        id: "boss_mail",
        type: "tool.app.gmail.search",
        label: "Search email",
        parameters: { toolName: "search_email", toolDescription: "Search the owner's Gmail, e.g. from:mehta newer_than:7d.", query: "={{AI('query', `Gmail search, e.g. from:mehta is:unread`, 'string')}}", limit: 5 },
      },
      {
        id: "boss_email",
        type: "tool.app.gmail.send",
        label: "Send an email",
        parameters: { toolName: "send_email", toolDescription: "Send an email from the owner's Gmail. Only when the owner asks, and after telling them exactly what you'll send.", to: "={{AI('to', `Email address`, 'string')}}", subject: "={{AI('subject', `Subject`, 'string')}}", bodyType: "text", body: "={{AI('body', `The email text`, 'string')}}" },
      },
      {
        id: "boss_pdf",
        type: "tool.app.whatsappWeb.sendDocument",
        label: "Send a quotation PDF",
        parameters: {
          toolName: "send_document",
          toolDescription: "Make a PDF (quotation, invoice, price list) and send it on WhatsApp. Table: first line 'Item | Qty | Price', then one line per item.",
          to: "={{AI('to', `Phone number to send it to`, 'string')}}",
          caption: "={{AI('caption', `A short message with the PDF`, 'string')}}",
          title: "={{AI('title', `Document title, e.g. Quotation`, 'string')}}",
          reference: "={{AI('reference', `Reference and date line, or empty`, 'string')}}",
          from: "${['$vars']['COMPANY_DETAILS']}",
          to_name: "={{AI('customer', `Customer name`, 'string')}}",
          intro: "={{AI('intro', `One or two lines of text, or empty`, 'string')}}",
          rows: "={{AI('rows', `The table, one line per item: Item | Qty | Price`, 'string')}}",
          currency: "Rs.",
          notes: "={{AI('notes', `Terms like validity, GST, delivery, or empty`, 'string')}}",
          fileName: "={{AI('fileName', `File name like quotation-mehta.pdf`, 'string')}}",
        },
      },
      {
        id: "boss_everyone",
        type: "tool.app.whatsappWeb.broadcast",
        label: "Message several people",
        parameters: { toolName: "message_everyone", toolDescription: "Send one WhatsApp message to several people (comma separated numbers, e.g. everyone in the Team tab).", numbers: "={{AI('numbers', `Comma separated phone numbers`, 'string')}}", text: "={{AI('text', `The message`, 'string')}}", minGapSeconds: 5, maxGapSeconds: 15 },
      },
      {
        id: "boss_reminders",
        type: "tool.app.whatsappWeb.reminders",
        label: "See reminders",
        parameters: { toolName: "list_reminders", toolDescription: "List the reminders that are scheduled and not sent yet, with their IDs.", action: "list", to: "" },
      },
      {
        id: "boss_cancel",
        type: "tool.app.whatsappWeb.reminders",
        label: "Cancel a reminder",
        parameters: { toolName: "cancel_reminder", toolDescription: "Cancel a scheduled reminder by its ID (get IDs with list_reminders).", action: "cancel", reminderId: "={{AI('reminderId', `The reminder's ID`, 'string')}}" },
      },
      {
        id: "boss_team",
        type: "tool.app.sheets.find",
        label: "Look up the team",
        parameters: { toolName: "find_team", toolDescription: "Look people up in the Team tab (Name, Phone, Role). Search Role for a value like Sales, or Name.", sheet: "Team", column: "={{AI('column', `Name, Role or Phone`, 'string')}}", value: "={{AI('value', `What to look for; use a space to list everyone`, 'string')}}", match: "contains", limit: 50 },
      },
      TASK("boss_task"),
      REMIND("boss_remind"),
      TASK("staff_task"),
      TASK_UPDATE("staff_taskupdate"),
      TASK_UPDATE("boss_taskupdate"),
      REMIND("staff_remind"),
      FIND("staff_find"),
      UPDATE("staff_update"),
      FIND("viewer_find"),
    ],
  },
  {
    id: "task-nudges",
    name: "Nudge people about due tasks",
    description:
      "Every morning (Monday to Saturday, 10:00), checks the Tasks tab and sends each person a WhatsApp about their tasks that are due today or overdue, asking for an update. No AI needed, so it's free and always works. Their replies go to your team assistant, which can mark tasks done.",
    apps: ["google", "whatsappWeb"],
    setup: "Paste your sheet link into the second step, pick your Google account and linked number, and set your time zone in the first two steps.",
    steps: [
      { id: "every", type: "trigger.schedule", label: "Every morning", parameters: { mode: "cron", cron: "0 10 * * 1-6" }, to: ["due"] },
      { id: "due", type: "app.tasks.due", label: "Tasks due or overdue", parameters: { sheet: "Tasks", which: "due", daysAhead: 0, output: "each", phonesFrom: "Team" }, to: ["hasPhone"] },
      {
        id: "hasPhone",
        type: "flow.filter",
        label: "Has a phone number",
        parameters: { conditions: { combinator: "and", rules: [{ id: "r1", left: "${['$input']['phone']}", operator: "isNotEmpty", right: "" }] } },
        to: ["nudge"],
      },
      {
        id: "nudge",
        type: "app.whatsappWeb.send",
        label: "Ask for an update",
        parameters: {
          to: "${['$input']['phone']}",
          text: "Hi ${['$input']['assignedTo']}, quick check on \"${['$input']['what']}\" (${['$input']['when']}). Reply here with an update (done, or a new date).",
        },
      },
    ],
  },
  {
    id: "owner-daily-report",
    name: "Supervisor: daily report to the owner",
    description:
      "Every evening, an AI supervisor reads all open tasks, writes the owner a short report (what's overdue, who's behind, anything stuck or duplicated), and politely messages people whose tasks are more than 2 days late to ask what's happening.",
    apps: ["google", "whatsappWeb"],
    needsAi: true,
    setup: "Paste your sheet link into the second step, pick your Google account and linked number, add a variable OWNER_PHONE with the owner's number (Team & settings, Variables), and set your time zone.",
    steps: [
      { id: "every", type: "trigger.schedule", label: "Every evening", parameters: { mode: "cron", cron: "0 19 * * *" }, to: ["open"] },
      { id: "open", type: "app.tasks.due", label: "All open tasks", parameters: { sheet: "Tasks", which: "open", output: "summary" }, to: ["supervisor"] },
      {
        id: "supervisor",
        type: "ai.agent",
        label: "Supervisor",
        parameters: {
          instructions:
            "You supervise a small team's tasks. Be fair and specific, never invent facts, and keep messages short and polite. Write in plain WhatsApp text (no markdown headings).",
          prompt:
            "Open tasks today (${['$input']['today']}):\n${['$input']['text']}\n\nDetails: ${['$input']['tasks']}\n\n1) For each task more than 2 days overdue, message the person on WhatsApp (their phone is in the details) asking what's holding it up and when it'll be done. 2) Then write the owner a report of at most 10 lines: what's overdue, who's behind, anything that looks stuck or duplicated, and who you messaged.",
          effort: "medium",
          memory: "none",
        },
        tools: ["ask"],
        to: ["report"],
      },
      {
        id: "ask",
        type: "tool.app.whatsappWeb.send",
        label: "Message a team member",
        parameters: { toolName: "message_person", toolDescription: "Send a WhatsApp message to one team member about their task.", to: "={{AI('to', `Their phone number`, 'string')}}", text: "={{AI('text', `The message`, 'string')}}", fileSource: "none" },
      },
      { id: "report", type: "app.whatsappWeb.send", label: "Send the report to the owner", parameters: { to: "${['$vars']['OWNER_PHONE']}", text: "${['$input']['output']}" } },
    ],
  },
  {
    id: "whatsapp-photo-to-sheet",
    name: "WhatsApp updates to your sheet",
    description: "Someone sends a message or a photo (a bill, a screenshot, a note) to your linked WhatsApp number. AI reads it, the customer's row in your Google Sheet is updated (or added), and they get a short confirmation.",
    apps: ["whatsappWeb", "google"],
    needsAi: true,
    setup:
      "Your sheet needs the columns Customer, Status, Amount, Notes and Updated by. Paste its link into both sheet steps, pick your linked number in the first and last steps, and put the numbers allowed to make changes in the trigger's Only these numbers.",
    steps: [
      { id: "wa", type: "trigger.whatsappWeb", label: "Message or photo", parameters: { chats: "private" }, to: ["read"] },
      {
        id: "read",
        type: "ai.extract",
        label: "Read it",
        parameters: {
          text: "${['$input']['text']}",
          image: "${['$input']['media']['id']}",
          fields: [
            { id: "f1", name: "customer", value: "The customer or company name this is about", type: "string" },
            { id: "f2", name: "status", value: "New status, e.g. Called, Quoted, Paid, Delivered", type: "string" },
            { id: "f3", name: "amount", value: "Amount of money mentioned, digits only", type: "string" },
            { id: "f4", name: "notes", value: "Anything else worth keeping, in a short sentence", type: "string" },
          ],
          outputField: "update",
        },
        to: ["save"],
      },
      {
        id: "save",
        type: "app.sheets.update",
        label: "Update the customer's row",
        parameters: {
          sheet: "Sheet1",
          findBy: "value",
          column: "Customer",
          value: "${['read']['update']['customer']}",
          match: "equals",
          columns: [
            { key: "Status", value: "${['read']['update']['status']}" },
            { key: "Amount", value: "${['read']['update']['amount']}" },
            { key: "Notes", value: "${['read']['update']['notes']}" },
            { key: "Updated by", value: "${['wa']['fromName']}" },
          ],
          ifMissing: "add",
          ifMany: "fail",
        },
        to: ["confirm"],
      },
      {
        id: "confirm",
        type: "app.whatsappWeb.send",
        label: "Confirm",
        parameters: { to: "${['wa']['chatId']}", text: "Done: ${['save']['action']} ${['save']['Customer']} (row ${['save']['row']})." },
      },
    ],
  },
  {
    id: "whatsapp-ai-bot",
    name: "AI WhatsApp assistant",
    description: "Replies to WhatsApp messages on your business number with AI and remembers each customer's conversation.",
    apps: ["whatsapp"],
    needsAi: true,
    setup:
      "WhatsApp only sends messages to a public address, so run a Cloudflare tunnel and set PUBLIC_URL first. Then put the callback URL and verify token from Connections into Meta's webhook settings and subscribe to \"messages\".",
    steps: [
      { id: "wa", type: "trigger.whatsapp", label: "WhatsApp message", to: ["ai"] },
      {
        id: "ai",
        type: "ai.agent",
        label: "Write a reply",
        parameters: {
          instructions: SUPPORT_PROMPT,
          prompt: "${['$input']['text']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['$input']['from']}",
          memoryTurns: 10,
        },
        to: ["reply"],
      },
      { id: "reply", type: "app.whatsapp.send", label: "Send the reply", parameters: { to: "${['wa']['from']}", text: "${['$input']['output']}" } },
    ],
  },
  {
    id: "website-chat-assistant",
    name: "Chat assistant for your website",
    description: "A hosted chat page where visitors talk to an AI that remembers each conversation. Change the instructions to teach it about your business.",
    apps: [],
    needsAi: true,
    setup: "Publish it to get the chat link.",
    steps: [
      { id: "chat", type: "trigger.chat", label: "Visitor sends a message", parameters: { title: "Chat with us", welcomeMessage: "Hi! What can I help you with?" }, to: ["ai"] },
      {
        id: "ai",
        type: "ai.agent",
        label: "Answer",
        parameters: {
          instructions: `${SUPPORT_PROMPT} If you don't know something about the business, say so and suggest emailing us.`,
          prompt: "${['$input']['message']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['$input']['sessionId']}",
          memoryTurns: 10,
        },
      },
    ],
  },
  {
    id: "form-to-sheet",
    name: "Contact form to Google Sheets",
    description: "A hosted contact form. Each answer becomes a row in your sheet, and your phone gets a ping.",
    apps: ["google", "ntfy"],
    setup: "Make a sheet with the columns Name, Email, Message and Received, then paste its link into the sheet step.",
    steps: [
      {
        id: "form",
        type: "trigger.form",
        label: "Someone fills in the form",
        parameters: {
          title: "Get in touch",
          questions: [
            { id: "q1", name: "name", label: "Your name", type: "text", required: true },
            { id: "q2", name: "email", label: "Email", type: "email", required: true },
            { id: "q3", name: "message", label: "Message", type: "textarea", required: true },
          ],
          submitLabel: "Send",
          successMessage: "Thanks! I'll get back to you soon.",
        },
        to: ["sheet"],
      },
      {
        id: "sheet",
        type: "app.sheets.append",
        label: "Add a row",
        parameters: {
          sheet: "Sheet1",
          columns: [
            { key: "Name", value: "${['$input']['fields']['name']}" },
            { key: "Email", value: "${['$input']['fields']['email']}" },
            { key: "Message", value: "${['$input']['fields']['message']}" },
            { key: "Received", value: "${['$input']['submittedAt']}" },
          ],
        },
        to: ["ping"],
      },
      { id: "ping", type: "app.ntfy.send", label: "Ping my phone", parameters: { title: "New message", message: "${['form']['fields']['name']}: ${['form']['fields']['message']}" } },
    ],
  },
  {
    id: "rss-to-phone",
    name: "New blog posts to your phone",
    description: "Checks a feed every hour and sends a push notification for each new post. Already-seen posts are skipped.",
    apps: ["ntfy"],
    setup: "Put the feed URL in the RSS step and your topic in the ntfy step.",
    steps: [
      { id: "every", type: "trigger.schedule", label: "Every hour", parameters: { mode: "interval", every: 1, unit: "hours" }, to: ["feed"] },
      { id: "feed", type: "app.rss.read", label: "Read the feed", parameters: { url: "https://hnrss.org/frontpage", limit: 20 }, to: ["new"] },
      { id: "new", type: "flow.onlyNew", label: "Only new posts", parameters: { key: "${['$input']['link']}", firstRun: "skip" }, to: ["ping"] },
      { id: "ping", type: "app.ntfy.send", label: "Ping my phone", parameters: { title: "${['$input']['feed']}", message: "${['$input']['title']}", click: "${['$input']['link']}" } },
    ],
  },
  {
    id: "rss-to-discord",
    name: "New blog posts to Discord",
    description: "Checks a feed every hour and posts each new article to a Discord channel.",
    apps: ["discord"],
    steps: [
      { id: "every", type: "trigger.schedule", label: "Every hour", parameters: { mode: "interval", every: 1, unit: "hours" }, to: ["feed"] },
      { id: "feed", type: "app.rss.read", label: "Read the feed", parameters: { url: "https://hnrss.org/frontpage", limit: 20 }, to: ["new"] },
      { id: "new", type: "flow.onlyNew", label: "Only new posts", parameters: { key: "${['$input']['link']}", firstRun: "skip" }, to: ["post"] },
      { id: "post", type: "app.discord.send", label: "Post it", parameters: { content: "**${['$input']['title']}**\n${['$input']['link']}" } },
    ],
  },
  {
    id: "telegram-to-todoist",
    name: "Telegram messages to Todoist",
    description: "Text your bot a to-do (like \"call Ana tomorrow 5pm\") and it lands in Todoist, due date and all.",
    apps: ["telegram", "todoist"],
    steps: [
      { id: "tg", type: "trigger.telegram", label: "Message to the bot", to: ["task"] },
      { id: "task", type: "app.todoist.task", label: "Add the task", parameters: { content: "${['$input']['message']['text']}", due: "" }, to: ["ok"] },
      { id: "ok", type: "app.telegram.send", label: "Confirm", parameters: { chatId: "${['tg']['message']['chat']['id']}", text: "Added to Todoist: ${['$input']['content']}" } },
    ],
  },
  {
    id: "bug-report-to-github",
    name: "Bug report form to GitHub",
    description: "A public form for bug reports. Each one becomes a GitHub issue with the reporter's details.",
    apps: ["github"],
    setup: "Set the repository (owner/name) in the GitHub step.",
    steps: [
      {
        id: "form",
        type: "trigger.form",
        label: "Someone reports a bug",
        parameters: {
          title: "Report a bug",
          questions: [
            { id: "q1", name: "title", label: "What went wrong?", type: "text", required: true },
            { id: "q2", name: "details", label: "Steps to reproduce", type: "textarea", required: true },
            { id: "q3", name: "email", label: "Your email (optional)", type: "email", required: false },
          ],
          submitLabel: "Send report",
          successMessage: "Thanks for the report!",
        },
        to: ["issue"],
      },
      {
        id: "issue",
        type: "app.github.issue",
        label: "Open an issue",
        parameters: {
          title: "${['$input']['fields']['title']}",
          body: "${['$input']['fields']['details']}\n\n---\nReported by ${['$input']['fields']['email']} through the bug form.",
          labels: "bug",
        },
      },
    ],
  },
  {
    id: "newsletter-signup",
    name: "Newsletter sign-up form",
    description: "A sign-up form that adds people to your Mailchimp audience (with a confirmation email).",
    apps: ["mailchimp"],
    setup: "Paste your audience ID into the Mailchimp step.",
    steps: [
      {
        id: "form",
        type: "trigger.form",
        label: "Someone signs up",
        parameters: {
          title: "Join the newsletter",
          questions: [
            { id: "q1", name: "first_name", label: "First name", type: "text", required: false },
            { id: "q2", name: "email", label: "Email", type: "email", required: true },
          ],
          submitLabel: "Sign me up",
          successMessage: "Almost done! Check your inbox to confirm.",
        },
        to: ["add"],
      },
      {
        id: "add",
        type: "app.mailchimp.subscribe",
        label: "Add to the audience",
        parameters: { email: "${['$input']['fields']['email']}", status: "pending", mergeFields: [{ key: "FNAME", value: "${['$input']['fields']['first_name']}" }], tags: "website" },
      },
    ],
  },
  {
    id: "failure-alerts",
    name: "Tell me when a workflow breaks",
    description: "Sends a push notification when another workflow fails, with the error.",
    apps: ["ntfy"],
    setup: "Publish it, then pick it under Error workflow in the settings of each workflow you want watched.",
    steps: [
      { id: "err", type: "trigger.error", label: "A workflow failed", to: ["ping"] },
      {
        id: "ping",
        type: "app.ntfy.send",
        label: "Ping my phone",
        parameters: { title: "${['$input']['workflow']['name']} failed", message: "${['$input']['error']['message']}", priority: "4", tags: "warning" },
      },
    ],
  },
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

/** Turns a template into a workflow graph, with each step's defaults filled in. */
export function templateGraph(t: WorkflowTemplate) {
  // Tools sit under their agent; everything else goes left to right.
  const ownerOf = new Map<string, string>();
  for (const s of t.steps) for (const tool of s.tools ?? []) ownerOf.set(tool, s.id);
  const pos = new Map<string, { x: number; y: number }>();
  let col = 0;
  for (const s of t.steps) if (!ownerOf.has(s.id)) pos.set(s.id, { x: col++ * 280, y: 0 });
  for (const s of t.steps) {
    (s.tools ?? []).forEach((tool, k) => {
      const at = pos.get(s.id)!;
      pos.set(tool, { x: at.x - 140 + k * 200, y: 220 });
    });
  }
  return {
    nodes: t.steps.map((s) => {
      const def = getDefinition(s.type);
      if (!def) throw new Error(`Template ${t.id} uses an unknown step type ${s.type}`);
      const connections: Record<string, Array<{ targetId: string; targetHandle?: string }>> = {};
      if (s.to) connections.main = s.to.map((targetId) => ({ targetId }));
      for (const [handle, targets] of Object.entries(s.routes ?? {})) connections[handle] = targets.map((targetId) => ({ targetId }));
      if (s.tools?.length) connections[TOOL_HANDLE] = s.tools.map((targetId) => ({ targetId, targetHandle: AGENT_HANDLE }));
      return {
        id: s.id,
        type: s.type,
        label: s.label,
        position: pos.get(s.id) ?? { x: 0, y: 0 },
        parameters: { ...defaultParameters(def), ...(s.parameters ?? {}) },
        connections,
      };
    }),
  };
}
