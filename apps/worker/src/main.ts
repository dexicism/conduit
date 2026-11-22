/**
 * Standalone execution worker for production. Runs queued executions, resumes
 * waits and fires schedules. Run as many copies as needed: jobs are claimed
 * atomically with leases, so workers never run the same job twice.
 *
 *   MONGODB_URI=... MONGODB_DB=conduit npm start -w worker
 */
import { createRuntime, integrationsFromEnv, llmFromEnv, startTelegramPoller, telegramModeFromEnv } from "@conduit/runtime";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}
const num = (n: string) => (Number.isFinite(Number(process.env[n])) && Number(process.env[n]) > 0 ? Number(process.env[n]) : undefined);

const client = new MongoClient(uri, { appName: "conduit-worker" });
await client.connect();
const ai = llmFromEnv();
const db = client.db(process.env.MONGODB_DB ?? "conduit");
const allowPrivateNetwork = process.env.HTTP_ALLOW_PRIVATE_NETWORK === "1";
// Saved accounts are decrypted here, so the worker needs the same CONDUIT_ENCRYPTION_KEY as the web app.
const { integrations, keySource } = integrationsFromEnv(db, { allowPrivateNetwork });
const runtime = createRuntime(db, {
  allowPrivateNetwork,
  retentionDays: num("EXECUTION_RETENTION_DAYS"),
  workspaceConcurrency: num("WORKSPACE_CONCURRENCY"),
  workerConcurrency: num("WORKER_CONCURRENCY"),
  codeTimeoutMs: num("CODE_TIMEOUT_MS"),
  codeMemoryMb: num("CODE_MEMORY_MB"),
}, { llm: ai.llm, billable: ai.provider === "anthropic" }, { integrations });
console.info(`[worker] connected apps key: ${keySource}`);
const worker = runtime.startWorker();
// Polling mode: Telegram rejects overlapping polls, so with several workers set TELEGRAM_POLL=0 on all but one.
const poller = telegramModeFromEnv() === "polling" && process.env.TELEGRAM_POLL !== "0" ? startTelegramPoller(db, integrations, runtime) : null;
if (poller) console.info("[worker] Telegram: polling for messages");
console.info(`[worker] AI provider: ${ai.provider}`);
console.info("[worker] running");

const shutdown = async () => {
  console.info("[worker] draining…");
  await poller?.stop();
  await worker.stop();
  await client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
