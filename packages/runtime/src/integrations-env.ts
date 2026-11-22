import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "mongodb";
import { createIntegrations, type Integrations } from "./integrations";
import { createHttpClient } from "./net";
import type { OAuthClient } from "./oauth";
import { createVault, parseMasterKeys } from "./vault";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Repo root (the folder whose package.json declares workspaces), so the web app and worker share dev files. */
function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && /"workspaces"/.test(readFileSync(pkg, "utf8"))) return dir;
    const up = dirname(dir);
    if (up === dir) return process.cwd();
    dir = up;
  }
}

/** Development only: a random key kept in .data so saved accounts survive restarts. */
function devKey(): string {
  const file = join(repoRoot(), ".data", "encryption.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32).toString("base64");
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export interface IntegrationsFromEnv {
  integrations: Integrations;
  keySource: "env" | "dev-file";
}

/**
 * Connected apps from the environment:
 * - CONDUIT_ENCRYPTION_KEY: master key(s) for saved accounts. Required in production.
 * - CONNECT_GOOGLE_CLIENT_ID / _SECRET (falls back to GOOGLE_CLIENT_ID / _SECRET): enables the Google app.
 * - CONDUIT_FAKE_APIS_URL: development/tests only, sends app API calls to a local stand-in.
 */
export function integrationsFromEnv(db: Db, opts: { allowPrivateNetwork: boolean }): IntegrationsFromEnv {
  const prod = process.env.NODE_ENV === "production";
  const spec = env("CONDUIT_ENCRYPTION_KEY");
  if (!spec && prod) {
    throw new Error("Set CONDUIT_ENCRYPTION_KEY (32 random bytes, base64) to store connected accounts");
  }
  const fake = env("CONDUIT_FAKE_APIS_URL");
  if (fake && prod) throw new Error("CONDUIT_FAKE_APIS_URL is for development and tests only");

  const oauthClients: Partial<Record<"google", OAuthClient>> = {};
  const gId = env("CONNECT_GOOGLE_CLIENT_ID") ?? env("GOOGLE_CLIENT_ID");
  const gSecret = env("CONNECT_GOOGLE_CLIENT_SECRET") ?? env("GOOGLE_CLIENT_SECRET");
  if (gId && gSecret) oauthClients.google = { clientId: gId, clientSecret: gSecret };

  const vault = createVault(parseMasterKeys(spec ?? devKey()));
  return {
    keySource: spec ? "env" : "dev-file",
    integrations: createIntegrations(db, {
      vault,
      http: createHttpClient({ allowPrivateNetwork: opts.allowPrivateNetwork }),
      allowPrivateNetwork: opts.allowPrivateNetwork,
      apiBaseOverride: fake,
      oauthClients,
    }),
  };
}

export type TelegramMode = "webhook" | "polling";

/**
 * How Telegram bots deliver messages:
 * - "webhook": Telegram calls PUBLIC_URL/hook/telegram/... (needs a public address).
 * - "polling": the worker asks Telegram for new messages (works on a PC with no public address).
 * TELEGRAM_MODE picks one; by default it's polling when the public URL is localhost.
 */
export function telegramModeFromEnv(e: NodeJS.ProcessEnv = process.env): TelegramMode {
  const m = e.TELEGRAM_MODE?.trim().toLowerCase();
  if (m === "webhook" || m === "polling") return m;
  const url = e.PUBLIC_URL?.trim() || e.BETTER_AUTH_URL?.trim() || "http://localhost:3000";
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") ? "polling" : "webhook";
  } catch {
    return "polling";
  }
}
