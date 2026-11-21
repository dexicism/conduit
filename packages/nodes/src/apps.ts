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
    id: "whatsapp",
    name: "WhatsApp Business",
    description: "Send WhatsApp messages from your business number (WhatsApp Cloud API).",
    icon: "MessageCircle",
    help: "In Meta for Developers, open your WhatsApp app: copy the Phone number ID, and create a System User access token with whatsapp_business_messaging permission.",
    auth: {
      kind: "fields",
      fields: [
        { name: "phoneNumberId", label: "Phone number ID", kind: "string", required: true, placeholder: "1234567890" },
        { name: "accessToken", label: "Access token", kind: "secret", required: true, placeholder: "EAAG…" },
      ],
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Gmail, Google Sheets and Google Calendar with one Google account.",
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
