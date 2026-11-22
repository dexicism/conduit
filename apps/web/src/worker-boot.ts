import { createRuntime, integrationsFromEnv, llmFromEnv, startTelegramPoller, telegramModeFromEnv } from "@conduit/runtime";
import { MongoClient } from "mongodb";
import { runtimeOptionsFromEnv } from "./lib/runtime-options";

const g = globalThis as unknown as { __conduitWorker?: Promise<void> };

/** Idempotent: hot reloads re-run instrumentation, but only one worker loop starts. */
export function bootWorker(): Promise<void> {
  g.__conduitWorker ??= (async () => {
    const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0";
    const client = new MongoClient(uri, { appName: "conduit-worker", maxPoolSize: 20 });
    await client.connect();
    const ai = llmFromEnv();
    const db = client.db(process.env.MONGODB_DB ?? "conduit");
    const options = runtimeOptionsFromEnv();
    const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: Boolean(options.allowPrivateNetwork) });
    const runtime = createRuntime(db, options, { llm: ai.llm, billable: ai.provider === "anthropic" }, { integrations });
    console.info(`[worker] AI provider: ${ai.provider}`);
    runtime.startWorker();
    if (telegramModeFromEnv() === "polling") {
      startTelegramPoller(db, integrations, runtime);
      console.info("[worker] Telegram: polling for messages (no public address needed)");
    }
    console.info("[worker] started in-process");
  })().catch((err) => {
    g.__conduitWorker = undefined;
    console.error("[worker] failed to start", err);
  });
  return g.__conduitWorker;
}
