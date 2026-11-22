import { FINAL_STATUSES, workflowGraphSchema, type ExecutionMode, type WorkflowGraph } from "@conduit/core";
import { initialState, nextScheduleRun, runExecution, StepError, type EngineServices, type Item, type LlmService } from "@conduit/engine";
import { createMemoryService, ensureMemoryIndexes } from "./llm";
import { getDefinition } from "@conduit/nodes";
import { createOutbound } from "./outbound";
import { ObjectId, type Db, type Filter } from "mongodb";
import { createHttpClient } from "./net";
import { ensureCredentialIndexes, redactText, redactValue, type Integrations } from "./integrations";
import { createSandbox } from "./sandbox";
import { collections, ensureRuntimeIndexes, toStepDoc, type ExecutionDoc, type JobDoc } from "./store";

export interface RuntimeOptions {
  allowPrivateNetwork: boolean;
  /** Days to keep execution logs. */
  retentionDays: number;
  /** Max concurrently running executions per workspace. */
  workspaceConcurrency: number;
  /** Executions processed in parallel by one worker process. */
  workerConcurrency: number;
  maxSubworkflowDepth: number;
  codeTimeoutMs: number;
  codeMemoryMb: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  allowPrivateNetwork: false,
  retentionDays: 7,
  workspaceConcurrency: 4,
  workerConcurrency: 8,
  maxSubworkflowDepth: 5,
  codeTimeoutMs: 10_000,
  codeMemoryMb: 64,
};

const LEASE_MS = 5 * 60_000;

export interface StartInput {
  workspaceId: ObjectId;
  workflowId: ObjectId;
  workflowName: string;
  versionId: ObjectId | null;
  mode: ExecutionMode;
  graph: WorkflowGraph;
  triggerNodeId: string;
  triggerItems: Item[];
  depth?: number;
  parentExecutionId?: ObjectId | null;
  isTest?: boolean;
}

/** Sample payload for triggers that are started by hand in the editor. */
export function triggerItemsFor(type: string, now: Date, extra?: Record<string, unknown>): Item[] {
  switch (type) {
    case "trigger.schedule":
      return [{ json: { firedAt: now.toISOString(), timezone: String(extra?.timezone ?? "UTC") } }];
    case "trigger.subworkflow":
      return [{ json: { input: extra?.input ?? {} } }];
    case "trigger.error":
    case "trigger.telegram":
    case "trigger.form":
    case "trigger.chat":
      return [{ json: getDefinition(type)!.outputSample }];
    default:
      return [{ json: { startedAt: now.toISOString() } }];
  }
}

/** Merges options over defaults, ignoring keys that are present but undefined (unset env vars). */
export function resolveRuntimeOptions(options: Partial<RuntimeOptions> = {}): RuntimeOptions {
  const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_RUNTIME_OPTIONS, ...defined };
}

export function createRuntime(
  db: Db,
  options: Partial<RuntimeOptions> = {},
  ai: { llm?: LlmService } = {},
  apps: { integrations?: Integrations } = {},
) {
  const opts = resolveRuntimeOptions(options);
  // Outbound webhooks need the vault (their signing secrets are encrypted).
  const outbound = apps.integrations ? createOutbound(db, { vault: apps.integrations.vault, http: createHttpClient({ allowPrivateNetwork: opts.allowPrivateNetwork }) }) : null;
  const c = collections(db);
  const http = createHttpClient({ allowPrivateNetwork: opts.allowPrivateNetwork });
  const runCode = createSandbox({ memoryLimitMb: opts.codeMemoryMb, timeoutMs: opts.codeTimeoutMs });
  let indexes: Promise<void> | null = null;
  const ready = () =>
    (indexes ??= Promise.all([ensureRuntimeIndexes(db), ensureMemoryIndexes(db), ensureCredentialIndexes(db)])
      .then(() => undefined)
      .catch((e) => ((indexes = null), Promise.reject(e))));
  const expiry = () => new Date(Date.now() + opts.retentionDays * 86_400_000);

  async function createExecution(input: StartInput, enqueue: boolean): Promise<ObjectId> {
    await ready();
    const now = new Date();
    const trigger = input.graph.nodes.find((n) => n.id === input.triggerNodeId);
    if (!trigger) throw new Error("Trigger step not found");
    const doc: ExecutionDoc = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      versionId: input.versionId,
      mode: input.mode,
      status: "queued",
      triggerNodeId: input.triggerNodeId,
      triggerType: trigger.type,
      triggerItems: input.triggerItems,
      graph: input.graph,
      state: initialState(input.graph, input.triggerNodeId, input.triggerItems),
      response: null,
      error: null,
      depth: input.depth ?? 0,
      parentExecutionId: input.parentExecutionId ?? null,
      isTest: input.isTest ?? input.mode === "test",
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      resumeAt: null,
      expiresAt: expiry(),
    };
    await c.executions.insertOne(doc);
    if (enqueue) await enqueueJob(doc._id, doc.workspaceId, now);
    return doc._id;
  }

  async function enqueueJob(executionId: ObjectId, workspaceId: ObjectId, runAt: Date) {
    await c.jobs.insertOne({
      _id: new ObjectId(),
      executionId,
      workspaceId,
      runAt,
      status: "queued",
      lockedUntil: null,
      attempts: 0,
      createdAt: new Date(),
    });
  }

  /** Loads a workflow's runnable graph: the published version, or the draft for tests. */
  async function loadRunnable(workspaceId: ObjectId, workflowId: string, allowDraft: boolean) {
    if (!ObjectId.isValid(workflowId)) throw new StepError("Workflow not found");
    const wf = await c.workflows.findOne({ _id: new ObjectId(workflowId), workspaceId, archivedAt: null });
    if (!wf) throw new StepError("Workflow not found (it may be archived or deleted)");
    if (wf.publishedVersionId) {
      const v = await c.versions.findOne({ _id: wf.publishedVersionId as ObjectId });
      if (v) return { wf, graph: v.graph, versionId: v._id };
    }
    if (!allowDraft) throw new StepError(`"${String(wf.name)}" isn't published`);
    return { wf, graph: workflowGraphSchema.parse(wf.draft), versionId: null };
  }

  function servicesFor(doc: ExecutionDoc, secrets: Set<string>): EngineServices {
    return {
      http,
      integrations: apps.integrations?.servicesFor(doc.workspaceId, secrets),
      runCode,
      now: () => new Date(),
      llm: ai.llm,
      memory: createMemoryService(db, doc.workflowId),
      executeWorkflow: async ({ workflowId, input, waitForResult }) => {
        if (doc.depth + 1 > opts.maxSubworkflowDepth) {
          throw new StepError(`Workflows can call each other at most ${opts.maxSubworkflowDepth} levels deep`);
        }
        const { wf, graph, versionId } = await loadRunnable(doc.workspaceId, workflowId, doc.isTest);
        const trig = graph.nodes.find((n) => n.type === "trigger.subworkflow");
        if (!trig) throw new StepError(`"${String(wf.name)}" must start with “Called by another workflow”`);
        const childId = await createExecution(
          {
            workspaceId: doc.workspaceId,
            workflowId: wf._id as ObjectId,
            workflowName: String(wf.name),
            versionId,
            mode: "subworkflow",
            graph,
            triggerNodeId: trig.id,
            triggerItems: [{ json: { input } }],
            depth: doc.depth + 1,
            parentExecutionId: doc._id,
            isTest: doc.isTest,
          },
          !waitForResult,
        );
        if (!waitForResult) return [];
        const child = await processExecution(childId);
        if (child.status === "waiting") {
          throw new StepError("A called workflow can't pause with Wait while the caller waits for its result");
        }
        if (child.status !== "success") throw new StepError(`Called workflow failed: ${child.error?.message ?? "unknown error"}`);
        return child.state?.lastOutput ?? [];
      },
    };
  }

  async function startErrorWorkflow(doc: ExecutionDoc) {
    if (doc.mode === "error" || doc.isTest) return;
    const wf = await c.workflows.findOne({ _id: doc.workflowId });
    const errorWorkflowId = (wf?.settings as { errorWorkflowId?: string } | undefined)?.errorWorkflowId;
    if (!errorWorkflowId || errorWorkflowId === doc.workflowId.toHexString()) return;
    try {
      const target = await loadRunnable(doc.workspaceId, errorWorkflowId, false);
      const trig = target.graph.nodes.find((n) => n.type === "trigger.error");
      if (!trig) return;
      await createExecution(
        {
          workspaceId: doc.workspaceId,
          workflowId: target.wf._id as ObjectId,
          workflowName: String(target.wf.name),
          versionId: target.versionId,
          mode: "error",
          graph: target.graph,
          triggerNodeId: trig.id,
          triggerItems: [
            {
              json: {
                workflow: { id: doc.workflowId.toHexString(), name: doc.workflowName },
                execution: { id: doc._id.toHexString(), startedAt: doc.startedAt.toISOString(), mode: doc.mode },
                error: doc.error,
              },
            },
          ],
        },
        true,
      );
    } catch (err) {
      console.error("[runtime] could not start error workflow", err);
    }
  }

  /** Runs an execution until it finishes or waits. Safe to call for queued or waiting executions. */
  async function processExecution(id: ObjectId): Promise<ExecutionDoc> {
    const doc = await c.executions.findOneAndUpdate(
      { _id: id, status: { $in: ["queued", "waiting"] } },
      { $set: { status: "running", resumeAt: null } },
      { returnDocument: "after" },
    );
    if (!doc) {
      const current = await c.executions.findOne({ _id: id });
      if (!current) throw new Error("Execution not found");
      return current;
    }
    if (!doc.state) throw new Error("Execution has no state");
    const exp = doc.expiresAt;
    // Secret values opened during this run; masked in everything stored.
    const secrets = new Set<string>();
    const raw = await runExecution({
      graph: doc.graph,
      state: doc.state,
      services: servicesFor(doc, secrets),
      hooks: {
        onStep: async (r) => {
          const safe = { ...r, input: redactValue(r.input, secrets), output: redactValue(r.output, secrets), logs: redactValue(r.logs, secrets) };
          if (r.error) safe.error = redactText(r.error, secrets);
          await c.steps.insertOne(toStepDoc(doc._id, doc.workspaceId, safe, exp));
        },
      },
    });
    const outcome = secrets.size
      ? ({
          ...raw,
          state: redactValue(raw.state, secrets),
          ...(raw.status === "failed" ? { error: { ...raw.error, message: redactText(raw.error.message, secrets) } } : {}),
        } as typeof raw)
      : raw;

    // Canceled while running: keep the canceled status.
    const latest = await c.executions.findOne({ _id: id }, { projection: { status: 1 } });
    if (latest?.status === "canceled") return (await c.executions.findOne({ _id: id }))!;

    const now = new Date();
    if (outcome.status === "waiting") {
      await c.executions.updateOne(
        { _id: id },
        { $set: { status: "waiting", state: outcome.state, resumeAt: outcome.resumeAt, response: outcome.state.response ?? null } },
      );
      await enqueueJob(id, doc.workspaceId, outcome.resumeAt);
    } else {
      await c.executions.updateOne(
        { _id: id },
        {
          $set: {
            status: outcome.status,
            // Keep the final state only for its last output (sub-workflow results); drop the queue.
            state: { ...outcome.state, queue: [], waits: [], loops: {}, merges: {}, outputs: {} },
            response: outcome.state.response ?? null,
            error: outcome.status === "failed" ? outcome.error : null,
            finishedAt: now,
            durationMs: now.getTime() - doc.startedAt.getTime(),
          },
        },
      );
    }
    const final = (await c.executions.findOne({ _id: id }))!;
    if (final.status === "failed") await startErrorWorkflow(final);
    if (outbound && final.mode === "production" && (final.status === "success" || final.status === "failed")) {
      await outbound
        .enqueue(final.workspaceId, final.status === "success" ? "execution.completed" : "execution.failed", {
          executionId: final._id.toHexString(),
          workflowId: final.workflowId.toHexString(),
          workflowName: final.workflowName,
          status: final.status,
          startedAt: final.startedAt.toISOString(),
          finishedAt: final.finishedAt?.toISOString() ?? null,
          durationMs: final.durationMs,
          error: final.error,
        })
        .catch((err) => console.error("[runtime] could not queue webhooks", err));
    }
    return final;
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  async function claimJob(): Promise<JobDoc | null> {
    const now = new Date();
    const filter: Filter<JobDoc> = {
      $or: [
        { status: "queued", runAt: { $lte: now } },
        { status: "running", lockedUntil: { $lt: now } }, // crashed worker: lease expired
      ],
    };
    return c.jobs.findOneAndUpdate(
      filter,
      { $set: { status: "running", lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { runAt: 1 }, returnDocument: "after" },
    );
  }

  async function handleJob(job: JobDoc) {
    // Workspace concurrency: release the job for later if the workspace is at its limit.
    const running = await c.executions.countDocuments({ workspaceId: job.workspaceId, status: "running" });
    const limit = opts.workspaceConcurrency;
    if (running >= limit) {
      await c.jobs.updateOne({ _id: job._id }, { $set: { status: "queued", lockedUntil: null, runAt: new Date(Date.now() + 1000) } });
      return;
    }
    try {
      const exec = await c.executions.findOne({ _id: job.executionId }, { projection: { status: 1 } });
      if (exec && !FINAL_STATUSES.includes(exec.status)) {
        if (exec.status === "running") {
          // Recovered after a crash mid-run: mark failed rather than replaying side effects.
          await c.executions.updateOne(
            { _id: job.executionId },
            { $set: { status: "failed", error: { message: "The worker stopped while this run was in progress" }, finishedAt: new Date() } },
          );
        } else {
          await processExecution(job.executionId);
        }
      }
    } catch (err) {
      console.error("[runtime] execution crashed", err);
      await c.executions.updateOne(
        { _id: job.executionId, status: { $nin: [...FINAL_STATUSES] } },
        { $set: { status: "failed", error: { message: (err as Error).message ?? "Internal error" }, finishedAt: new Date() } },
      );
    } finally {
      await c.jobs.deleteOne({ _id: job._id });
    }
  }

  async function tickSchedules() {
    const now = new Date();
    for (;;) {
      const t = await c.triggers.findOneAndUpdate(
        { kind: "schedule", nextRunAt: { $lte: now } },
        { $set: { nextRunAt: new Date(now.getTime() + 60_000) } }, // provisional, replaced below
        { returnDocument: "before" },
      );
      if (!t) return;
      try {
        const wf = await c.workflows.findOne({ _id: t.workflowId });
        const version = t.versionId ? await c.versions.findOne({ _id: t.versionId }) : null;
        const node = version?.graph.nodes.find((n) => n.id === t.nodeId);
        if (!wf || !version || !node) {
          await c.triggers.deleteOne({ _id: t._id });
          continue;
        }
        await c.triggers.updateOne({ _id: t._id }, { $set: { nextRunAt: nextScheduleRun(node.parameters, now) } });
        await createExecution(
          {
            workspaceId: t.workspaceId,
            workflowId: t.workflowId,
            workflowName: String(wf.name),
            versionId: version._id,
            mode: "production",
            graph: version.graph,
            triggerNodeId: node.id,
            triggerItems: triggerItemsFor("trigger.schedule", t.nextRunAt ?? now, node.parameters),
          },
          true,
        );
      } catch (err) {
        console.error("[runtime] schedule tick failed", err);
      }
    }
  }

  function startWorker(opts2: { pollMs?: number; scheduleEveryMs?: number } = {}) {
    let stopped = false;
    let active = 0;
    const pollMs = opts2.pollMs ?? 250;
    let lastTick = 0;

    const loop = async () => {
      await ready();
      while (!stopped) {
        try {
          if (outbound) await outbound.tick().catch((err) => console.error("[runtime] webhook delivery failed", err));
          if (Date.now() - lastTick > (opts2.scheduleEveryMs ?? 10_000)) {
            lastTick = Date.now();
            await tickSchedules();
          }
          let claimed = false;
          while (!stopped && active < opts.workerConcurrency) {
            const job = await claimJob();
            if (!job) break;
            claimed = true;
            active++;
            void handleJob(job).finally(() => active--);
          }
          if (!claimed) await new Promise((r) => setTimeout(r, pollMs));
        } catch (err) {
          console.error("[runtime] worker loop error", err);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    void loop();
    return {
      stop: async () => {
        stopped = true;
        while (active > 0) await new Promise((r) => setTimeout(r, 50));
      },
    };
  }

  return {
    options: opts,
    collections: c,
    outbound,
    ready,
    createExecution,
    processExecution,
    startWorker,
    tickSchedules,
    loadRunnable,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
