import { createRuntime, integrationsFromEnv, llmFromEnv, startBackups, startTelegramPoller, startWhatsappWeb, telegramModeFromEnv } from "@conduit/runtime";
import { resolve } from "node:path";
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
    const runtime = createRuntime(db, options, { llm: ai.llm }, { integrations });
    console.info(`[worker] AI provider: ${ai.provider}`);
    runtime.startWorker();
    if (telegramModeFromEnv() === "polling") {
      startTelegramPoller(db, integrations, runtime);
      console.info("[worker] Telegram: polling for messages (no public address needed)");
    }
    if (process.env.WHATSAPP_WEB !== "0") {
      startWhatsappWeb(db, runtime, { authRoot: resolve(process.cwd(), ".data", "whatsapp-web") });
      console.info("[worker] WhatsApp (linked phone): ready");
    }
    if (process.env.BACKUP !== "0") {
      // A daily copy of the database in .data/backups (the last 14 are kept).
      const dir = process.env.BACKUP_DIR || resolve(process.cwd(), ".data", "backups");
      startBackups(db, { dir, everyHours: Number(process.env.BACKUP_EVERY_HOURS) || 24, keep: Number(process.env.BACKUP_KEEP) || 14 });
      console.info(`[worker] daily backups to ${dir}`);
    }
    console.info("[worker] started in-process");
  })().catch((err) => {
    g.__conduitWorker = undefined;
    console.error("[worker] failed to start", err);
  });
  return g.__conduitWorker;
}
