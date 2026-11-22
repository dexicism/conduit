import { z } from "zod";
import type { WorkflowGraph } from "./workflow";

export const EXECUTION_STATUSES = ["queued", "running", "waiting", "success", "failed", "canceled"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const FINAL_STATUSES: readonly ExecutionStatus[] = ["success", "failed", "canceled"];

export const EXECUTION_MODES = ["test", "production", "subworkflow", "error"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  triggerNodeId: string;
  triggerType: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resumeAt: string | null;
  error: { nodeId?: string; message: string } | null;
  parentExecutionId: string | null;
}

export interface StepItem {
  json: Record<string, unknown>;
}

export interface StepSummary {
  index: number;
  nodeId: string;
  label: string;
  type: string;
  status: "success" | "failed" | "waiting";
  startedAt: string;
  durationMs: number;
  inputCount: number;
  outputCounts: Record<string, number>;
  /** Up to 20 items each; `truncated` is set when more existed or data was too large. */
  input: StepItem[];
  output: Record<string, StepItem[]>;
  truncated: boolean;
  error: string | null;
  logs: string[];
}

export interface ExecutionDetail extends ExecutionSummary {
  graph: WorkflowGraph;
  steps: StepSummary[];
  response: { status: number; headers: Record<string, string>; body: unknown } | null;
}

export const listExecutionsQuerySchema = z.object({
  workflowId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  status: z.enum(EXECUTION_STATUSES).optional(),
  mode: z.enum(EXECUTION_MODES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type ListExecutionsQuery = z.infer<typeof listExecutionsQuerySchema>;

export const testRunInputSchema = z.object({
  triggerNodeId: z.string().min(1).max(150).optional(),
  /** Must match the saved draft revision so the run uses what the user sees. */
  expectedRevision: z.number().int().min(0).optional(),
});

export const workflowSettingsSchema = z.object({
  errorWorkflowId: z.string().regex(/^[a-f\d]{24}$/i).nullable().optional(),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

/** One webhook / schedule that went live on publish. */
export interface ActiveTrigger {
  nodeId: string;
  label: string;
  kind: "webhook" | "schedule" | "telegram" | "whatsapp" | "form" | "chat";
  method?: string;
  path?: string;
  nextRunAt?: string;
}

export interface PublishResult {
  versionId: string;
  publishedRevision: number;
  publishedAt: string;
  triggers: ActiveTrigger[];
}
