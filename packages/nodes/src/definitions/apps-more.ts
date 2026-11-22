import type { NodeDefinition, ParamField } from "../types";

const action = {
  version: 1,
  category: "app" as const,
  color: "sky" as const,
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
};

const credential = (app: string): ParamField => ({ kind: "credential", name: "credential", label: "Account", app, required: true });

export const notionAddPage: NodeDefinition = {
  ...action,
  type: "app.notion.addPage",
  name: "Notion: add to database",
  description: "Add a page to a Notion database. Values are matched to its columns by name.",
  icon: "NotebookPen",
  app: "notion",
  keywords: ["notion", "database", "page", "add", "row", "notes", "crm"],
  asTool: { name: "add_notion_page", description: "Add a page to the Notion database." },
  fields: [
    credential("notion"),
    { kind: "string", name: "database", label: "Database", required: true, placeholder: "Database link or ID", description: "Share the database with your integration first (••• → Connections)." },
    { kind: "keyValue", name: "columns", label: "Columns", required: true, keyPlaceholder: "Column name", valuePlaceholder: "Value", description: "Works with title, text, number, select, multi-select (comma separated), status, checkbox, date, URL, email and phone columns." },
    { kind: "string", name: "content", label: "Page text", multiline: true, description: "Optional. Blank lines start a new paragraph." },
  ],
  outputSample: { id: "1f2e3d4c-…", url: "https://www.notion.so/Ana-1f2e3d4c" },
};

export const notionQuery: NodeDefinition = {
  ...action,
  type: "app.notion.query",
  name: "Notion: read database",
  description: "Read pages from a Notion database, one item per page, with columns as plain values.",
  icon: "NotebookPen",
  app: "notion",
  keywords: ["notion", "database", "read", "list", "query", "lookup"],
  asTool: { name: "read_notion_database", description: "Read pages from the Notion database." },
  fields: [
    credential("notion"),
    { kind: "string", name: "database", label: "Database", required: true, placeholder: "Database link or ID" },
    { kind: "number", name: "limit", label: "Max pages", default: 50, min: 1, max: 100 },
  ],
  outputSample: { id: "1f2e3d4c-…", url: "https://www.notion.so/Ana-1f2e3d4c", Name: "Ana", Status: "Lead", Tags: ["vip"] },
};

export const airtableAdd: NodeDefinition = {
  ...action,
  type: "app.airtable.add",
  name: "Airtable: add record",
  description: "Add a record to an Airtable table. Values are converted to each field's type.",
  icon: "Table",
  app: "airtable",
  keywords: ["airtable", "record", "row", "add", "base", "table", "spreadsheet"],
  asTool: { name: "add_airtable_record", description: "Add a record to the Airtable table." },
  fields: [
    credential("airtable"),
    { kind: "string", name: "base", label: "Base", required: true, placeholder: "Base link or ID (app…)" },
    { kind: "string", name: "table", label: "Table", required: true, placeholder: "Table name or ID" },
    { kind: "keyValue", name: "fields", label: "Fields", required: true, keyPlaceholder: "Field name", valuePlaceholder: "Value" },
  ],
  outputSample: { id: "recA1b2C3d4E5f6G7", createdTime: "2026-01-01T09:00:00.000Z", fields: { Name: "Ana", Email: "ana@example.com" } },
};

export const airtableList: NodeDefinition = {
  ...action,
  type: "app.airtable.list",
  name: "Airtable: list records",
  description: "Read records from an Airtable table, one item per record.",
  icon: "Table",
  app: "airtable",
  keywords: ["airtable", "records", "read", "list", "lookup", "find"],
  asTool: { name: "list_airtable_records", description: "Read records from the Airtable table." },
  fields: [
    credential("airtable"),
    { kind: "string", name: "base", label: "Base", required: true, placeholder: "Base link or ID (app…)" },
    { kind: "string", name: "table", label: "Table", required: true, placeholder: "Table name or ID" },
    { kind: "string", name: "filter", label: "Filter formula", placeholder: "{Status} = 'Open'", description: "Optional. An Airtable formula; only matching records come back." },
    { kind: "string", name: "view", label: "View", placeholder: "Optional view name" },
    { kind: "number", name: "limit", label: "Max records", default: 100, min: 1, max: 1000 },
  ],
  outputSample: { id: "recA1b2C3d4E5f6G7", createdTime: "2026-01-01T09:00:00.000Z", Name: "Ana", Status: "Open" },
};

export const discordSend: NodeDefinition = {
  ...action,
  type: "app.discord.send",
  name: "Discord: send message",
  description: "Post a message to a Discord channel through a webhook.",
  icon: "MessageSquare",
  app: "discord",
  keywords: ["discord", "chat", "notify", "channel", "post", "server"],
  asTool: { name: "send_discord_message", description: "Post a message to the Discord channel." },
  fields: [
    credential("discord"),
    { kind: "string", name: "content", label: "Message", required: true, multiline: true, description: "Up to 2,000 characters. Discord markdown works." },
    { kind: "string", name: "username", label: "Post as", placeholder: "Optional name instead of the webhook's" },
    { kind: "boolean", name: "allowMentions", label: "Allow @mentions", default: false, description: "Off: @everyone and @names in the text won't ping anyone." },
  ],
  outputSample: { id: "1300000000000000000", channelId: "1200000000000000000", timestamp: "2026-01-01T09:00:00.000Z" },
};

export const githubIssue: NodeDefinition = {
  ...action,
  type: "app.github.issue",
  name: "GitHub: create issue",
  description: "Open an issue in a GitHub repository.",
  icon: "GitBranch",
  app: "github",
  keywords: ["github", "issue", "bug", "ticket", "repo", "report"],
  asTool: { name: "create_github_issue", description: "Open an issue in the GitHub repository." },
  fields: [
    credential("github"),
    { kind: "string", name: "repo", label: "Repository", required: true, placeholder: "owner/name" },
    { kind: "string", name: "title", label: "Title", required: true },
    { kind: "string", name: "body", label: "Description", multiline: true, description: "Markdown works." },
    { kind: "string", name: "labels", label: "Labels", placeholder: "bug, from-form (optional)" },
  ],
  outputSample: { number: 42, url: "https://github.com/owner/name/issues/42", id: 3000000000 },
};

export const trelloCard: NodeDefinition = {
  ...action,
  type: "app.trello.card",
  name: "Trello: create card",
  description: "Add a card to the top of a Trello list.",
  icon: "SquareKanban",
  app: "trello",
  keywords: ["trello", "card", "board", "kanban", "task", "todo"],
  asTool: { name: "create_trello_card", description: "Add a card to the Trello list." },
  fields: [
    credential("trello"),
    { kind: "string", name: "list", label: "List ID", required: true, placeholder: "5f0c…(24 characters)", description: "Open any card in the list, add .json to its URL, and copy idList." },
    { kind: "string", name: "name", label: "Card name", required: true },
    { kind: "string", name: "description", label: "Description", multiline: true },
    { kind: "string", name: "due", label: "Due", placeholder: "2026-01-15T17:00:00Z (optional)" },
  ],
  outputSample: { id: "5f0c0c0c0c0c0c0c0c0c0c0c", url: "https://trello.com/c/AbCd1234" },
};

export const todoistTask: NodeDefinition = {
  ...action,
  type: "app.todoist.task",
  name: "Todoist: add task",
  description: "Add a task to Todoist. Due dates can be plain English, like \"tomorrow 5pm\".",
  icon: "ListTodo",
  app: "todoist",
  keywords: ["todoist", "task", "todo", "reminder", "list"],
  asTool: { name: "add_todoist_task", description: "Add a task to Todoist." },
  fields: [
    credential("todoist"),
    { kind: "string", name: "content", label: "Task", required: true },
    { kind: "string", name: "description", label: "Description", multiline: true },
    { kind: "string", name: "due", label: "Due", placeholder: "tomorrow 5pm, every monday (optional)" },
    {
      kind: "select",
      name: "priority",
      label: "Priority",
      default: "1",
      options: [
        { value: "1", label: "P4 (normal)" },
        { value: "2", label: "P3" },
        { value: "3", label: "P2" },
        { value: "4", label: "P1 (urgent)" },
      ],
    },
    { kind: "string", name: "labels", label: "Labels", placeholder: "work, errands (optional)" },
    { kind: "string", name: "project", label: "Project ID", placeholder: "Optional. Empty means Inbox" },
  ],
  outputSample: { id: "6Jf8VQXxpwv56VQ7", content: "Call Ana", due: "2026-01-02", url: "https://app.todoist.com/app/task/6Jf8VQXxpwv56VQ7" },
};

export const mailchimpSubscribe: NodeDefinition = {
  ...action,
  type: "app.mailchimp.subscribe",
  name: "Mailchimp: add subscriber",
  description: "Add someone to a Mailchimp audience, or update them if they're already on it.",
  icon: "MailPlus",
  app: "mailchimp",
  keywords: ["mailchimp", "newsletter", "subscriber", "audience", "list", "email", "marketing"],
  asTool: { name: "add_mailchimp_subscriber", description: "Add an email address to the Mailchimp audience." },
  fields: [
    credential("mailchimp"),
    { kind: "string", name: "audience", label: "Audience ID", required: true, placeholder: "a1b2c3d4e5", description: "Audience → Settings → Audience name and defaults → Audience ID." },
    { kind: "string", name: "email", label: "Email", required: true },
    {
      kind: "select",
      name: "status",
      label: "New people are",
      default: "pending",
      options: [
        { value: "pending", label: "Sent a confirmation email first (double opt-in)" },
        { value: "subscribed", label: "Subscribed right away" },
      ],
    },
    { kind: "keyValue", name: "mergeFields", label: "Extra fields", keyPlaceholder: "FNAME", valuePlaceholder: "Value" },
    { kind: "string", name: "tags", label: "Tags", placeholder: "from-website, beta (optional)" },
  ],
  outputSample: { id: "8f14e45fceea167a5a36dedd4bea2543", email: "ana@example.com", status: "pending" },
};

export const ntfySend: NodeDefinition = {
  ...action,
  type: "app.ntfy.send",
  name: "ntfy: phone notification",
  description: "Send a push notification to your phone with the free ntfy app. Anyone who knows the topic name can read it, so pick a hard-to-guess one.",
  icon: "BellRing",
  app: "ntfy",
  keywords: ["ntfy", "push", "notification", "phone", "alert", "notify", "mobile"],
  asTool: { name: "send_phone_notification", description: "Send a push notification to the phone." },
  fields: [
    credential("ntfy"),
    { kind: "string", name: "topic", label: "Topic", required: true, placeholder: "my-alerts-x7k2", description: "Subscribe to the same topic in the ntfy app." },
    { kind: "string", name: "title", label: "Title" },
    { kind: "string", name: "message", label: "Message", required: true, multiline: true },
    {
      kind: "select",
      name: "priority",
      label: "Priority",
      default: "3",
      options: [
        { value: "1", label: "Min (no sound)" },
        { value: "2", label: "Low" },
        { value: "3", label: "Normal" },
        { value: "4", label: "High" },
        { value: "5", label: "Urgent (rings through Do Not Disturb)" },
      ],
    },
    { kind: "string", name: "tags", label: "Tags / emoji", placeholder: "warning, tada (optional)" },
    { kind: "string", name: "click", label: "Open on tap", placeholder: "https://… (optional)" },
  ],
  outputSample: { id: "sPs71M8A2T", topic: "my-alerts-x7k2", time: "2026-01-01T09:00:00.000Z" },
};

export const rssRead: NodeDefinition = {
  ...action,
  type: "app.rss.read",
  name: "RSS: read feed",
  description: "Read the latest posts from an RSS or Atom feed, one item per post. Pair it with a schedule and a filter to watch a blog or news site.",
  icon: "Rss",
  keywords: ["rss", "atom", "feed", "blog", "news", "podcast", "read"],
  asTool: { name: "read_rss_feed", description: "Read the latest posts from the RSS feed." },
  fields: [
    { kind: "string", name: "url", label: "Feed URL", required: true, placeholder: "https://example.com/feed.xml" },
    { kind: "number", name: "limit", label: "Max posts", default: 20, min: 1, max: 200 },
  ],
  outputSample: { title: "A new post", link: "https://example.com/a-new-post", id: "https://example.com/?p=1", published: "2026-01-01T09:00:00.000Z", summary: "The first lines of the post…", author: "Ana", feed: "Example Blog" },
};

export const MORE_APP_ACTION_DEFINITIONS: readonly NodeDefinition[] = [
  notionAddPage,
  notionQuery,
  airtableAdd,
  airtableList,
  discordSend,
  githubIssue,
  trelloCard,
  todoistTask,
  mailchimpSubscribe,
  ntfySend,
  rssRead,
];
