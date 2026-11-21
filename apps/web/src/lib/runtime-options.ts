import type { RuntimeOptions } from "@conduit/runtime";

/** Runtime settings from the environment. Shared by the web app and worker boot (no server-only imports). */
export function runtimeOptionsFromEnv(): Partial<RuntimeOptions> {
  const num = (name: string) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    // Off by default: steps may not call private/internal addresses unless explicitly allowed.
    allowPrivateNetwork: process.env.HTTP_ALLOW_PRIVATE_NETWORK === "1",
    retentionDays: num("EXECUTION_RETENTION_DAYS"),
    workspaceConcurrency: num("WORKSPACE_CONCURRENCY"),
    workerConcurrency: num("WORKER_CONCURRENCY"),
    codeTimeoutMs: num("CODE_TIMEOUT_MS"),
    codeMemoryMb: num("CODE_MEMORY_MB"),
  };
}
