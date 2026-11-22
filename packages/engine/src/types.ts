import type { WorkflowGraph, WorkflowNode } from "@conduit/core";
import type { NodeDefinition } from "@conduit/nodes";

/** One unit of data flowing between steps. */
export interface Item {
  json: Record<string, unknown>;
}

export type ExecutionMode = "test" | "production" | "subworkflow" | "error";

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Header names (beyond Authorization and Cookie) dropped if a redirect leaves the original origin. */
  sensitiveHeaders?: string[];
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface CodeRunResult {
  items: Record<string, unknown>[];
  logs: string[];
}

// ---------------------------------------------------------------------------
// Language model service (provider-neutral)
// ---------------------------------------------------------------------------

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** Provider-specific block (e.g. thinking) that must be sent back unchanged. */
  | { type: "opaque"; raw: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmBlock[];
}

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Strict schema validation (default true). Off for tools with free-form objects. */
  strict?: boolean;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** Constrain the final answer to this JSON schema. */
  jsonSchema?: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTokens: number;
}

export interface LlmResult {
  content: LlmBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmService {
  chat(req: LlmRequest): Promise<LlmResult>;
}

export interface MemoryTurn {
  role: "user" | "assistant";
  text: string;
}

/** Conversation memory for agents, scoped by the runtime to the workflow and step. */
export interface MemoryService {
  load(nodeId: string, sessionKey: string): Promise<MemoryTurn[]>;
  append(nodeId: string, sessionKey: string, turns: MemoryTurn[], keep: number): Promise<void>;
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  command: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Connected apps: credentials and the drivers that can't go through `http`. */
export interface IntegrationServices {
  /** Decrypted values of a credential in this run's workspace; refreshes OAuth tokens as needed. */
  credential(id: string, app: string): Promise<Record<string, string>>;
  /** Maps a public API URL to where requests should go (a local test server in development). */
  apiUrl(url: string): string;
  sqlQuery(cfg: Record<string, string>, sql: string, values: unknown[], timeoutMs: number): Promise<SqlResult>;
  sendMail(cfg: Record<string, string>, msg: MailMessage): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
}

/** Side effects the engine needs, injected so the engine stays testable. */
export interface EngineServices {
  http(req: HttpRequest): Promise<HttpResponse>;
  runCode(input: { code: string; mode: "perItem" | "all"; items: Item[] }): Promise<CodeRunResult>;
  executeWorkflow(input: { workflowId: string; input: unknown; waitForResult: boolean }): Promise<Item[]>;
  now(): Date;
  /** Undefined when no AI model is configured. */
  llm?: LlmService;
  memory?: MemoryService;
  /** Undefined when connected apps aren't available (no encryption key). */
  integrations?: IntegrationServices;
}

export interface ResponseSpec {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Task {
  nodeId: string;
  inputHandle: string;
  items: Item[];
  /** Node that produced these items (undefined for the trigger). */
  from?: string;
  /** Set when a Wait step resumes: emit `items` on main without re-waiting. */
  resume?: boolean;
}

export interface LoopState {
  batches: Item[][];
  next: number;
  collected: Item[];
  original: Item[];
}

export interface RunState {
  queue: Task[];
  /** Latest output items of each executed node, used by `${['node-id']...}` references. */
  outputs: Record<string, Item[]>;
  loops: Record<string, LoopState>;
  merges: Record<string, { a?: Item[]; b?: Item[] }>;
  steps: number;
  response?: ResponseSpec;
  lastOutput: Item[];
}

export interface StepRecord {
  index: number;
  nodeId: string;
  label: string;
  type: string;
  status: "success" | "failed" | "waiting";
  startedAt: Date;
  durationMs: number;
  input: Item[];
  /** Output items per handle. */
  output: Record<string, Item[]>;
  error?: string;
  logs: string[];
}

export interface RunHooks {
  onStepStart?(nodeId: string): void | Promise<void>;
  /** Called right before a step's executor runs (not for triggers, disabled steps, merges or loops). Throwing fails the step. */
  beforeExecute?(node: WorkflowNode, def: NodeDefinition): void | Promise<void>;
  onStep?(record: StepRecord): void | Promise<void>;
}

export type RunOutcome =
  | { status: "success"; state: RunState }
  | { status: "failed"; state: RunState; error: { nodeId?: string; message: string } }
  | { status: "waiting"; state: RunState; resumeAt: Date };

export interface ExecContext {
  graph: WorkflowGraph;
  node: WorkflowNode;
  def: NodeDefinition;
  items: Item[];
  inputHandle: string;
  from?: string;
  state: RunState;
  services: EngineServices;
  /** Parameters resolved against item `i` (references substituted). */
  params(i: number): Record<string, unknown>;
  log(message: string): void;
}

export type ExecResult =
  | { outputs: Record<string, Item[]> }
  | { wait: { until: Date } };

export type Executor = (ctx: ExecContext) => Promise<ExecResult> | ExecResult;

export class StepError extends Error {
  override name = "StepError";
}
