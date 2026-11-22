import "server-only";
import { createExecutionQueries, createRuntime, createTriggerService, integrationsFromEnv, llmFromEnv, telegramModeFromEnv, type Integrations, type LlmProviderName } from "@conduit/runtime";
import type { LlmService } from "@conduit/engine";
import { db, mongoClient } from "./db";
import { env } from "./env";
import { runtimeOptionsFromEnv } from "./runtime-options";

const g = globalThis as unknown as {
  __conduitRuntime?: {
    runtime: ReturnType<typeof createRuntime>;
    triggers: ReturnType<typeof createTriggerService>;
    executions: ReturnType<typeof createExecutionQueries>;
    ai: { provider: LlmProviderName; llm?: LlmService };
    integrations: Integrations;
  };
};

/** Web-side access to the execution runtime (enqueueing, publishing, reading runs, AI). */
export function rt() {
  if (!g.__conduitRuntime) {
    const ai = llmFromEnv();
    const options = runtimeOptionsFromEnv();
    const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: Boolean(options.allowPrivateNetwork) });
    g.__conduitRuntime = {
      runtime: createRuntime(db, options, { llm: ai.llm }, { integrations }),
      triggers: createTriggerService(db, mongoClient, {
        telegram:
          telegramModeFromEnv() === "polling"
            ? {
                // The worker polls for messages; a leftover webhook would block that, and old messages are skipped.
                urlFor: (path) => `${env.PUBLIC_URL}/hook/telegram/${path}`,
                register: (ws, cred) => integrations.telegram.deleteWebhook(ws, cred, true),
                unregister: async () => {},
              }
            : {
                urlFor: (path) => `${env.PUBLIC_URL}/hook/telegram/${path}`,
                register: (ws, cred, url, secret) => integrations.telegram.setWebhook(ws, cred, url, secret),
                unregister: (ws, cred) => integrations.telegram.deleteWebhook(ws, cred),
              },
      }),
      executions: createExecutionQueries(db),
      ai,
      integrations,
    };
  }
  return g.__conduitRuntime;
}

export interface AiStatus {
  enabled: boolean;
  /** "fake" is the deterministic test model; the UI labels it. */
  provider: LlmProviderName;
}

export function aiStatus(): AiStatus {
  const { ai } = rt();
  return { enabled: Boolean(ai.llm), provider: ai.provider };
}

/** Apps that can be connected on this server (OAuth apps need client credentials). */
export function availableApps(): string[] {
  return rt().integrations.availableApps();
}
