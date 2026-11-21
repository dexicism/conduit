import "server-only";
import { APP_DEFINITIONS, type AppDefinition } from "@conduit/nodes";
import { ApiError } from "./api";
import type { AppInfo } from "./app-info";
import { env } from "./env";
import { rt } from "./runtime";

export function appCatalog(): AppInfo[] {
  const available = new Set(rt().integrations.availableApps());
  return APP_DEFINITIONS.filter((a) => available.has(a.id)).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    help: a.help ?? null,
    auth: a.auth,
  }));
}

export function requireAvailableApp(id: string): AppDefinition {
  const app = APP_DEFINITIONS.find((a) => a.id === id);
  if (!app || !rt().integrations.availableApps().includes(id)) {
    throw new ApiError(400, "invalid_request", app ? `${app.name} isn't set up on this server` : "Unknown app");
  }
  return app;
}

export const oauthRedirectUri = () => `${env.APP_URL}/api/credentials/oauth/callback`;

/** Errors from app calls (bad token, unreachable host…) become 400s with their message. */
export async function appCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const e = err as Error;
    if (e?.name === "VaultError" || e?.name === "StepError") throw new ApiError(400, "invalid_request", e.message);
    throw err;
  }
}
