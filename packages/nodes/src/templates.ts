import { defaultParameters, getDefinition } from "./registry";

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
  return {
    nodes: t.steps.map((s, i) => {
      const def = getDefinition(s.type);
      if (!def) throw new Error(`Template ${t.id} uses an unknown step type ${s.type}`);
      return {
        id: s.id,
        type: s.type,
        label: s.label,
        position: { x: i * 280, y: 0 },
        parameters: { ...defaultParameters(def), ...(s.parameters ?? {}) },
        connections: s.to ? { main: s.to.map((targetId) => ({ targetId })) } : {},
      };
    }),
  };
}
