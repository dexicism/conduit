import type { ExecutionDetail, ExecutionMode, ExecutionStatus, ExecutionSummary, StepItem, StepSummary, WorkflowGraph } from "@conduit/core";
import type { EngineState, Item, ResponseSpec, StepRecord } from "@conduit/engine";
import { ObjectId, type Db } from "mongodb";

export interface ExecutionDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  workflowId: ObjectId;
  workflowName: string;
  versionId: ObjectId | null;
  mode: ExecutionMode;
  status: ExecutionStatus;
  triggerNodeId: string;
  triggerType: string;
  triggerItems: Item[];
  graph: WorkflowGraph;
  state: EngineState | null;
  response: ResponseSpec | null;
  error: { nodeId?: string; message: string } | null;
  depth: number;
  parentExecutionId: ObjectId | null;
  /** True for editor test runs and every sub-workflow they call (drafts allowed, no error workflow). */
  isTest: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  resumeAt: Date | null;
  expiresAt: Date;
}

export interface StepDoc {
  _id?: ObjectId;
  executionId: ObjectId;
  workspaceId: ObjectId;
  index: number;
  nodeId: string;
  label: string;
  type: string;
  status: StepRecord["status"];
  startedAt: Date;
  durationMs: number;
  inputCount: number;
  outputCounts: Record<string, number>;
  input: StepItem[];
  output: Record<string, StepItem[]>;
  truncated: boolean;
  error: string | null;
  logs: string[];
  expiresAt: Date;
}

export interface JobDoc {
  _id: ObjectId;
  executionId: ObjectId;
  workspaceId: ObjectId;
  runAt: Date;
  status: "queued" | "running";
  lockedUntil: Date | null;
  attempts: number;
  createdAt: Date;
}

export interface TriggerDoc {
  _id?: ObjectId;
  workspaceId: ObjectId;
  workflowId: ObjectId;
  versionId: ObjectId | null;
  nodeId: string;
  kind: "webhook" | "webhook-test" | "schedule" | "telegram" | "whatsapp" | "form" | "chat";
  method?: string;
  path?: string;
  nextRunAt?: Date;
  /** For test listeners. */
  expiresAt?: Date;
  /** Test listener: execution created by the first request. */
  executionId?: ObjectId | null;
  createdBy?: string;
  /** Telegram and WhatsApp: the connected account. Telegram also gets and the secret Telegram sends back on every update. */
  credentialId?: string;
  secretToken?: string;
  /** Telegram polling mode: the next update id to ask for. */
  pollOffset?: number;
  createdAt: Date;
}

export interface VersionDoc {
  _id: ObjectId;
  workflowId: ObjectId;
  workspaceId: ObjectId;
  revision: number;
  graph: WorkflowGraph;
  publishedBy: string;
  publishedAt: Date;
}

export function collections(db: Db) {
  return {
    workflows: db.collection("workflows"),
    versions: db.collection<VersionDoc>("workflow_versions"),
    executions: db.collection<ExecutionDoc>("executions"),
    steps: db.collection<StepDoc>("execution_steps"),
    jobs: db.collection<JobDoc>("jobs"),
    triggers: db.collection<TriggerDoc>("triggers"),
  };
}
export type Collections = ReturnType<typeof collections>;

export async function ensureRuntimeIndexes(db: Db): Promise<void> {
  const c = collections(db);
  await Promise.all([
    c.executions.createIndex({ workspaceId: 1, startedAt: -1, _id: -1 }),
    c.executions.createIndex({ workflowId: 1, startedAt: -1 }),
    c.executions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.steps.createIndex({ executionId: 1, index: 1 }),
    c.steps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.jobs.createIndex({ status: 1, runAt: 1 }),
    c.jobs.createIndex({ executionId: 1 }),
    c.versions.createIndex({ workflowId: 1, publishedAt: -1 }),
    c.triggers.createIndex({ workflowId: 1 }),
    c.triggers.createIndex({ kind: 1, nextRunAt: 1 }),
    c.triggers.createIndex({ path: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: "webhook" } }),
    c.triggers.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { kind: "webhook-test" } }),
  ]);
}

// ---------------------------------------------------------------------------
// Step storage limits
// ---------------------------------------------------------------------------

const MAX_ITEMS = 20;
const MAX_STEP_BYTES = 200_000;

function capItems(items: Item[]): { items: StepItem[]; truncated: boolean } {
  return { items: items.slice(0, MAX_ITEMS).map((i) => ({ json: i.json })), truncated: items.length > MAX_ITEMS };
}

export function toStepDoc(executionId: ObjectId, workspaceId: ObjectId, r: StepRecord, expiresAt: Date): StepDoc {
  const input = capItems(r.input);
  let truncated = input.truncated;
  const output: Record<string, StepItem[]> = {};
  const outputCounts: Record<string, number> = {};
  for (const [h, items] of Object.entries(r.output)) {
    const c = capItems(items);
    output[h] = c.items;
    outputCounts[h] = items.length;
    truncated ||= c.truncated;
  }
  let doc: StepDoc = {
    executionId,
    workspaceId,
    index: r.index,
    nodeId: r.nodeId,
    label: r.label,
    type: r.type,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    inputCount: r.input.length,
    outputCounts,
    input: input.items,
    output,
    truncated,
    error: r.error ?? null,
    logs: r.logs.slice(0, 100),
    expiresAt,
  };
  // Keep step documents small: drop item data beyond the byte budget.
  if (Buffer.byteLength(JSON.stringify({ i: doc.input, o: doc.output })) > MAX_STEP_BYTES) {
    const note = { json: { _truncated: "Data too large to keep in the run log" } };
    doc = {
      ...doc,
      input: doc.input.length ? [note] : [],
      output: Object.fromEntries(Object.entries(doc.output).map(([h, v]) => [h, v.length ? [note] : []])),
      truncated: true,
    };
  }
  return doc;
}

export function toSummary(d: ExecutionDoc): ExecutionSummary {
  return {
    id: d._id.toHexString(),
    workflowId: d.workflowId.toHexString(),
    workflowName: d.workflowName,
    mode: d.mode,
    status: d.status,
    triggerNodeId: d.triggerNodeId,
    triggerType: d.triggerType,
    startedAt: d.startedAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
    durationMs: d.durationMs,
    resumeAt: d.resumeAt?.toISOString() ?? null,
    error: d.error,
    parentExecutionId: d.parentExecutionId?.toHexString() ?? null,
  };
}

export function toStepSummary(s: StepDoc): StepSummary {
  return {
    index: s.index,
    nodeId: s.nodeId,
    label: s.label,
    type: s.type,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    durationMs: s.durationMs,
    inputCount: s.inputCount,
    outputCounts: s.outputCounts,
    input: s.input,
    output: s.output,
    truncated: s.truncated,
    error: s.error,
    logs: s.logs,
  };
}

export function toDetail(d: ExecutionDoc, steps: StepDoc[]): ExecutionDetail {
  return { ...toSummary(d), graph: d.graph, steps: steps.map(toStepSummary), response: d.response };
}
