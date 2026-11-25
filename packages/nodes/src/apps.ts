/**
 * Apps a workspace can connect (Connected Apps). A credential stores one
 * account of one app; steps pick it with a `credential` field.
 */

export interface AppField {
  name: string;
  label: string;
  kind: "string" | "secret" | "number" | "select";
  required?: boolean;
  default?: string | number;
  placeholder?: string;
  description?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export type AppAuth =
  | { kind: "fields"; fields: readonly AppField[] }
  /** OAuth 2.0 authorization code with PKCE. Offered only when the server has client credentials. */
  | { kind: "oauth2"; provider: OAuthProviderId; scopes: readonly string[] };

export type OAuthProviderId = "google";

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  auth: AppAuth;
  /** Where to get the values, shown in the connect dialog. */
  help?: string;
}

export const APP_DEFINITIONS: readonly AppDefinition[] = [
  {
    id: "telegram",
    name: "Telegram",
    description: "Send messages from a bot and start workflows when it receives one.",
    icon: "Send",
    help: "Create a bot with @BotFather in Telegram and paste the token it gives you.",
    auth: {
      kind: "fields",
      fields: [{ name: "botToken", label: "Bot token", kind: "secret", required: true, placeholder: "123456:ABC-DEF…" }],
    },
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post messages to channels as your Slack app.",
    icon: "Hash",
    help: "Create a Slack app, add the chat:write and channels:read bot scopes, install it, and paste the Bot User OAuth Token. Invite the bot to each channel it posts in.",
    auth: {
      kind: "fields",
      fields: [{ name: "botToken", label: "Bot token", kind: "secret", required: true, placeholder: "xoxb-…" }],
    },
  },
  {
    id: "whatsappWeb",
    name: "WhatsApp (linked phone)",
    description: "Use a normal WhatsApp number, linked like WhatsApp Web. Works in groups, no templates needed.",
    icon: "Smartphone",
    help: "Give it a name, then press Link phone and scan the QR code with WhatsApp on that phone (Settings > Linked devices). This isn't Meta's official business API: WhatsApp can ban numbers it thinks are bots, so use a number you can afford to lose, keep the volume human, and don't message lots of strangers first.",
    auth: { kind: "fields", fields: [] },
  },
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    description: "Send WhatsApp messages from your business number (WhatsApp Cloud API).",
    icon: "MessageCircle",
    help: "In Meta for Developers, open your app's WhatsApp > API Setup page: copy the Phone number ID and an access token (the temporary one lasts a day; a System User token with whatsapp_business_messaging doesn't expire). To receive messages too, add the App secret (App settings > Basic) and make up a verify token, then follow the steps shown on the connection.",
    auth: {
      kind: "fields",
      fields: [
        { name: "phoneNumberId", label: "Phone number ID", kind: "string", required: true, placeholder: "1234567890" },
        { name: "accessToken", label: "Access token", kind: "secret", required: true, placeholder: "EAAG…" },
        { name: "appSecret", label: "App secret (to receive messages)", kind: "secret", placeholder: "Optional" },
        { name: "verifyToken", label: "Verify token (to receive messages)", kind: "secret", placeholder: "Any long random text" },
      ],
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Gmail, Google Sheets, Google Calendar and Google Drive with one Google account.",
    icon: "Mail",
    auth: {
      kind: "oauth2",
      provider: "google",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/drive.file",
      ],
    },
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Run queries against a PostgreSQL database (also Supabase, Neon and others).",
    icon: "Database",
    help: "Use a database user with only the permissions your workflows need.",
    auth: {
      kind: "fields",
      fields: [
        { name: "host", label: "Host", kind: "string", required: true, placeholder: "db.example.com" },
        { name: "port", label: "Port", kind: "number", default: 5432 },
        { name: "database", label: "Database", kind: "string", required: true },
        { name: "user", label: "User", kind: "string", required: true },
        { name: "password", label: "Password", kind: "secret" },
        {
          name: "ssl",
          label: "SSL",
          kind: "select",
          default: "require",
          options: [
            { value: "require", label: "Require (verify certificate)" },
            { value: "no-verify", label: "Require (don't verify certificate)" },
            { value: "disable", label: "Off" },
          ],
        },
      ],
    },
  },
  {
    id: "smtp",
    name: "Email (SMTP)",
    description: "Send email through any SMTP server.",
    icon: "AtSign",
    auth: {
      kind: "fields",
      fields: [
        { name: "host", label: "Host", kind: "string", required: true, placeholder: "smtp.example.com" },
        { name: "port", label: "Port", kind: "number", default: 587 },
        {
          name: "security",
          label: "Security",
          kind: "select",
          default: "starttls",
          options: [
            { value: "starttls", label: "STARTTLS (port 587)" },
            { value: "tls", label: "TLS (port 465)" },
            { value: "none", label: "None" },
          ],
        },
        { name: "user", label: "User", kind: "string" },
        { name: "password", label: "Password", kind: "secret" },
        { name: "from", label: "From address", kind: "string", required: true, placeholder: "Team <team@example.com>" },
      ],
    },
  },
  {
    id: "httpHeader",
    name: "API key (header)",
    description: "Send a secret header with HTTP requests, e.g. Authorization: Bearer ….",
    icon: "KeyRound",
    auth: {
      kind: "fields",
      fields: [
        { name: "headerName", label: "Header name", kind: "string", required: true, default: "Authorization" },
        { name: "headerValue", label: "Header value", kind: "secret", required: true, placeholder: "Bearer sk-…" },
      ],
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Add pages to and read Notion databases.",
    icon: "NotebookPen",
    help: "Go to notion.so/profile/integrations, create an internal integration, and paste its secret. Then open each database you want to use, click ••• → Connections and add the integration.",
    auth: { kind: "fields", fields: [{ name: "token", label: "Integration secret", kind: "secret", required: true, placeholder: "ntn_…" }] },
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Add and read records in Airtable bases.",
    icon: "Table",
    help: "Create a personal access token at airtable.com/create/tokens with the data.records:read and data.records:write scopes, and give it access to your bases.",
    auth: { kind: "fields", fields: [{ name: "token", label: "Personal access token", kind: "secret", required: true, placeholder: "pat…" }] },
  },
  {
    id: "discord",
    name: "Discord",
    description: "Post messages to a Discord channel.",
    icon: "MessageSquare",
    help: "In Discord, open Server Settings → Integrations → Webhooks, create a webhook for the channel and copy its URL. One connection posts to one channel.",
    auth: { kind: "fields", fields: [{ name: "webhookUrl", label: "Webhook URL", kind: "secret", required: true, placeholder: "https://discord.com/api/webhooks/…" }] },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Open issues in your repositories.",
    icon: "GitBranch",
    help: "Create a fine-grained token at github.com/settings/tokens with access to the repositories you want and Issues: Read and write.",
    auth: { kind: "fields", fields: [{ name: "token", label: "Access token", kind: "secret", required: true, placeholder: "github_pat_…" }] },
  },
  {
    id: "trello",
    name: "Trello",
    description: "Create cards on your Trello boards.",
    icon: "SquareKanban",
    help: "Create a Power-Up at trello.com/power-ups/admin to get an API key, then click the Token link next to it to generate a token.",
    auth: {
      kind: "fields",
      fields: [
        { name: "apiKey", label: "API key", kind: "string", required: true },
        { name: "token", label: "Token", kind: "secret", required: true },
      ],
    },
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Add tasks to Todoist.",
    icon: "ListTodo",
    help: "In Todoist, open Settings → Integrations → Developer and copy your API token.",
    auth: { kind: "fields", fields: [{ name: "token", label: "API token", kind: "secret", required: true }] },
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    description: "Add people to your Mailchimp audiences.",
    icon: "MailPlus",
    help: "In Mailchimp, open Profile → Extras → API keys and create a key. It ends with something like -us21.",
    auth: { kind: "fields", fields: [{ name: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "…-us21" }] },
  },
  {
    id: "ntfy",
    name: "ntfy",
    description: "Free push notifications to your phone.",
    icon: "BellRing",
    help: "Install the ntfy app on your phone and subscribe to a topic. Leave the server as is for the free ntfy.sh service; an access token is only needed for protected topics or your own server.",
    auth: {
      kind: "fields",
      fields: [
        { name: "server", label: "Server", kind: "string", default: "https://ntfy.sh", placeholder: "https://ntfy.sh" },
        { name: "accessToken", label: "Access token", kind: "secret", placeholder: "tk_… (optional)" },
      ],
    },
  },
];

const APPS = new Map(APP_DEFINITIONS.map((a) => [a.id, a]));

export function getApp(id: string): AppDefinition | undefined {
  return APPS.get(id);
}

/** Fields whose values are secret (never returned by the API). OAuth tokens are always secret. */
export function secretFieldNames(app: AppDefinition): string[] {
  return app.auth.kind === "fields" ? app.auth.fields.filter((f) => f.kind === "secret").map((f) => f.name) : [];
}

/** Checks and normalizes form values for a fields-auth app. */
export function validateAppFields(app: AppDefinition, data: Record<string, unknown>): { values: Record<string, string>; errors: Record<string, string> } {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  if (app.auth.kind !== "fields") return { values, errors: { _: "This app connects with sign-in, not a form" } };
  for (const f of app.auth.fields) {
    const raw = data[f.name];
    let v = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!v && f.default !== undefined) v = String(f.default);
    if (!v) {
      if (f.required) errors[f.name] = `${f.label} is required`;
      continue;
    }
    if (v.length > 4000) errors[f.name] = `${f.label} is too long`;
    else if (f.kind === "number" && !/^\d{1,5}$/.test(v)) errors[f.name] = `${f.label} must be a whole number`;
    else if (f.kind === "select" && !f.options?.some((o) => o.value === v)) errors[f.name] = `Choose a valid ${f.label.toLowerCase()}`;
    values[f.name] = v;
  }
  return { values, errors };
}
