import "server-only";

const isProd = process.env.NODE_ENV === "production";
/**
 * CONDUIT_LOCAL=1: a production build running for one person on their own computer
 * (listening on 127.0.0.1 only). Sign-in codes then go to the local outbox, as in development.
 */
export const isLocalInstall = process.env.CONDUIT_LOCAL === "1";
// `next build` runs in production mode but must not need runtime secrets.
const enforce = isProd && process.env.NEXT_PHASE !== "phase-production-build";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function required(name: string, devFallback: string): string {
  const v = optional(name);
  if (v) return v;
  if (enforce) throw new Error(`Missing required environment variable ${name}`);
  return devFallback;
}

export const env = {
  isProd,
  APP_URL: required("BETTER_AUTH_URL", "http://localhost:3000"),
  /**
   * Address outside services use to reach incoming hooks (Telegram, webhooks, forms).
   * Defaults to APP_URL; set it to a tunnel (e.g. Cloudflare) when running on your own PC.
   */
  PUBLIC_URL: (optional("PUBLIC_URL") ?? optional("BETTER_AUTH_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
  AUTH_SECRET: required("BETTER_AUTH_SECRET", "dev-only-secret-change-me-dev-only-secret-change-me"),
  MONGODB_URI: required("MONGODB_URI", "mongodb://127.0.0.1:27018/?replicaSet=rs0"),
  MONGODB_DB: optional("MONGODB_DB") ?? "conduit",
  GOOGLE_CLIENT_ID: optional("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: optional("GOOGLE_CLIENT_SECRET"),
  GITHUB_CLIENT_ID: optional("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: optional("GITHUB_CLIENT_SECRET"),
  RESEND_API_KEY: optional("RESEND_API_KEY"),
  SMTP_URL: optional("SMTP_URL"),
  EMAIL_FROM: optional("EMAIL_FROM") ?? "Conduit <no-reply@localhost>",
  /** Dev-only file where emails are written when no provider is configured. */
  OUTBOX_PATH: optional("OUTBOX_PATH") ?? ".data/outbox.jsonl",
} as const;

/** Social providers are offered only when fully configured, so the UI never shows a button that cannot work. */
export const oauthProviders = {
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
};

export const emailMode: "resend" | "smtp" | "dev-outbox" = env.RESEND_API_KEY
  ? "resend"
  : env.SMTP_URL
    ? "smtp"
    : "dev-outbox";

if (enforce && emailMode === "dev-outbox" && !isLocalInstall) {
  throw new Error("Configure RESEND_API_KEY or SMTP_URL: sign-in codes cannot be delivered in production without one");
}
