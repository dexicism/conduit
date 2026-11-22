import { collectReferences, hasReferences, INPUT_SOURCE, type WorkflowGraph, type WorkflowNode } from "@conduit/core";
import { codeNode, executeWorkflowNode, httpRequestNode, respondNode, setFieldsNode } from "./definitions/core";
import { filterNode, ifNode, loopNode, mergeNode, switchNode, waitNode } from "./definitions/flow";
import { cryptoNode, dateNode, jsonNode, listNode, mathNode, textNode } from "./definitions/transform";
import { errorTrigger, manualTrigger, scheduleTrigger, subworkflowTrigger, webhookTrigger } from "./definitions/triggers";
import { agentNode, classifyNode, extractNode, moderateNode, sentimentNode } from "./definitions/ai";
import { appActionTool, calculatorTool, codeTool, httpTool, subAgentTool, thinkTool, workflowTool } from "./definitions/tools";
import { APP_ACTION_DEFINITIONS, telegramTrigger } from "./definitions/apps";
import { chatTrigger, formTrigger } from "./definitions/triggers";
import { AGENT_HANDLE, TOOL_HANDLE } from "./types";
import type {
  Assignment,
  ConditionGroup,
  ConditionRule,
  FormQuestion,
  HandleSpec,
  KeyValuePair,
  NodeCategory,
  NodeDefinition,
  ParamField,
  SwitchCase,
} from "./types";
import { CONDITION_OPERATORS } from "./types";

export const NODE_DEFINITIONS: readonly NodeDefinition[] = [
  manualTrigger,
  webhookTrigger,
  scheduleTrigger,
  subworkflowTrigger,
  errorTrigger,
  telegramTrigger,
  formTrigger,
  chatTrigger,
  agentNode,
  classifyNode,
  extractNode,
  sentimentNode,
  moderateNode,
  httpTool,
  calculatorTool,
  workflowTool,
  codeTool,
  subAgentTool,
  thinkTool,
  ...APP_ACTION_DEFINITIONS.filter((d) => d.asTool).map(appActionTool),
  ...APP_ACTION_DEFINITIONS,
  ifNode,
  switchNode,
  filterNode,
  loopNode,
  mergeNode,
  waitNode,
  httpRequestNode,
  codeNode,
  setFieldsNode,
  respondNode,
  executeWorkflowNode,
  textNode,
  mathNode,
  dateNode,
  listNode,
  jsonNode,
  cryptoNode,
];

const BY_TYPE = new Map(NODE_DEFINITIONS.map((d) => [d.type, d]));

export function getDefinition(type: string): NodeDefinition | undefined {
  return BY_TYPE.get(type);
}

export function isTrigger(def: NodeDefinition | undefined): boolean {
  return def?.category === "trigger";
}

export function searchDefinitions(query: string, category?: NodeCategory): NodeDefinition[] {
  const q = query.trim().toLowerCase();
  return NODE_DEFINITIONS.filter((d) => {
    if (category && d.category !== category) return false;
    if (!q) return true;
    const hay = [d.name, d.description, d.type, ...(d.keywords ?? [])].join(" ").toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
}

export function outputsOf(def: NodeDefinition, params: Record<string, unknown>): HandleSpec[] {
  return typeof def.outputs === "function" ? def.outputs(params) : def.outputs;
}

/**
 * A field is visible when its `showIf` matches AND the field it depends on is itself
 * visible (e.g. "JSON body" depends on "Body", which is hidden for GET requests).
 */
export function isFieldVisible(
  field: ParamField,
  params: Record<string, unknown>,
  fields?: readonly ParamField[],
  depth = 0,
): boolean {
  if (!field.showIf) return true;
  if (!field.showIf.equals.includes(params[field.showIf.field])) return false;
  const all = fields ?? getDefinitionByField(field)?.fields;
  const parent = all?.find((f) => f.name === field.showIf!.field);
  if (!parent || depth > 10) return true;
  return isFieldVisible(parent, params, all, depth + 1);
}

function getDefinitionByField(field: ParamField): NodeDefinition | undefined {
  return NODE_DEFINITIONS.find((d) => d.fields.includes(field));
}

// ---------------------------------------------------------------------------
// IDs and defaults
// ---------------------------------------------------------------------------

export function shortId(len = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "step"
  );
}

/** Readable, unique node ID such as `node-http-request` or `node-http-request-2`. */
export function uniqueNodeId(existing: Iterable<string>, label: string): string {
  const taken = new Set(existing);
  const base = `node-${slugify(label)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Label unique among existing labels: "HTTP request", "HTTP request 2", ... */
export function uniqueLabel(existing: Iterable<string>, base: string): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function newConditionRule(): ConditionRule {
  return { id: shortId(), left: "", operator: "equals", right: "" };
}

function fieldDefault(field: ParamField): unknown {
  switch (field.kind) {
    case "conditions":
      return { combinator: "and", rules: [newConditionRule()] } satisfies ConditionGroup;
    case "cases":
      return [{ id: shortId(), value: "" }] satisfies SwitchCase[];
    case "assignments":
      return [{ id: shortId(), name: "", value: "", type: "string" }] satisfies Assignment[];
    case "keyValue":
      return [] satisfies KeyValuePair[];
    case "workflow":
    case "credential":
      return "";
    case "formFields":
      return [
        { id: shortId(), name: "name", label: "Your name", type: "text", required: true },
        { id: shortId(), name: "email", label: "Email", type: "email", required: true },
      ] satisfies FormQuestion[];
    default:
      return field.default;
  }
}

export function defaultParameters(def: NodeDefinition): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = fieldDefault(f);
    if (v !== undefined) params[f.name] = v;
  }
  return { ...params, ...(def.initParameters?.() ?? {}) };
}

// ---------------------------------------------------------------------------
// Parameter validation (non-blocking: drafts may be incomplete)
// ---------------------------------------------------------------------------

export interface ParamIssue {
  field: string;
  message: string;
}

const CRON_ITEM = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;
const CRON_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Validates a standard 5-field cron expression (numbers, `*`, ranges, lists, steps). */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [min, max] = CRON_RANGES[i]!;
    return field.split(",").every((item) => {
      const m = CRON_ITEM.exec(item);
      if (!m) return false;
      const [, , from, to, step] = m;
      if (step !== undefined && Number(step) < 1) return false;
      if (from !== undefined) {
        const a = Number(from);
        if (a < min || a > max) return false;
        if (to !== undefined) {
          const b = Number(to);
          if (b < min || b > max || b < a) return false;
        }
      }
      return true;
    });
  });
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function validateField(field: ParamField, value: unknown): string | null {
  switch (field.kind) {
    case "string": {
      if (field.required && isBlank(value)) return `${field.label} is required`;
      if (typeof value !== "string" || isBlank(value)) return null;
      if (field.expression === false && hasReferences(value)) return `${field.label} can't use references`;
      if (hasReferences(value)) return null;
      if (field.format === "url" && !/^https?:\/\/[^\s]+$/i.test(value.trim())) return "Enter a full URL starting with http:// or https://";
      if (field.format === "cron" && !isValidCron(value)) return "Enter a valid 5-field cron expression";
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return "Enter a valid email address";
      if (field.format === "path-segment" && !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return "Use letters, digits, '-' and '_' only";
      if (field.format === "tool-name" && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return "Use up to 64 letters, digits, '-' and '_'";
      return null;
    }
    case "number": {
      if (isBlank(value)) return field.required ? `${field.label} is required` : null;
      if (typeof value === "string") {
        if (field.expression && hasReferences(value)) return null;
        return `${field.label} must be a number`;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) return `${field.label} must be a number`;
      if (field.min !== undefined && value < field.min) return `${field.label} must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `${field.label} must be at most ${field.max}`;
      return null;
    }
    case "select":
      if (isBlank(value)) return field.required ? `${field.label} is required` : null;
      return field.options.some((o) => o.value === value) ? null : `Choose a valid ${field.label.toLowerCase()}`;
    case "json": {
      if (isBlank(value)) return field.required ? `${field.label} is required` : null;
      if (typeof value !== "string") return null;
      if (hasReferences(value)) return null; // checked after resolution at run time
      try {
        JSON.parse(value);
        return null;
      } catch {
        return `${field.label} is not valid JSON`;
      }
    }
    case "code":
      return field.required && isBlank(value) ? `${field.label} is required` : null;
    case "workflow":
      return field.required && isBlank(value) ? `Choose a workflow` : null;
    case "credential":
      return field.required && isBlank(value) ? `Choose an account to use` : null;
    case "keyValue": {
      const rows = Array.isArray(value) ? (value as KeyValuePair[]) : [];
      if (rows.some((r) => isBlank(r.key) && !isBlank(r.value))) return "Every row with a value needs a name";
      return null;
    }
    case "conditions": {
      const g = value as ConditionGroup | undefined;
      const rules = g?.rules ?? [];
      if (field.required && rules.length === 0) return "Add at least one condition";
      for (const r of rules) {
        const op = CONDITION_OPERATORS.find((o) => o.value === r.operator);
        if (!op) return "A condition has an unknown operator";
        if (isBlank(r.left)) return "Every condition needs a value to check";
        if (!op.unary && isBlank(r.right) && r.operator !== "equals" && r.operator !== "notEquals")
          return "A condition is missing the value to compare with";
        if (r.operator === "matches" && !hasReferences(r.right)) {
          try {
            new RegExp(r.right);
          } catch {
            return "A condition has an invalid regular expression";
          }
        }
      }
      return null;
    }
    case "cases": {
      const cases = Array.isArray(value) ? (value as SwitchCase[]) : [];
      if (field.required && cases.length === 0) return "Add at least one case";
      if (cases.some((c) => isBlank(c.value))) return "Every case needs a value";
      return null;
    }
    case "assignments": {
      const rows = Array.isArray(value) ? (value as Assignment[]) : [];
      if (field.required && rows.length === 0) return "Add at least one field";
      if (rows.some((r) => isBlank(r.name))) return "Every field needs a name";
      const names = rows.map((r) => r.name.trim());
      if (new Set(names).size !== names.length) return "Field names must be unique";
      return null;
    }
    case "formFields": {
      const rows = Array.isArray(value) ? (value as FormQuestion[]) : [];
      if (field.required && rows.length === 0) return "Add at least one question";
      if (rows.some((r) => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(r.name ?? ""))) return "Each question needs a key: letters, digits and _ (start with a letter)";
      if (rows.some((r) => isBlank(r.label))) return "Each question needs a label";
      const names = rows.map((r) => r.name);
      if (new Set(names).size !== names.length) return "Question keys must be unique";
      if (rows.some((r) => r.type === "select" && !(r.options ?? "").split(",").some((o) => o.trim()))) return "Choice questions need options";
      return null;
    }
    case "boolean":
      return null;
  }
}

export function validateNodeParameters(def: NodeDefinition, params: Record<string, unknown>): ParamIssue[] {
  const issues: ParamIssue[] = [];
  for (const f of def.fields) {
    if (!isFieldVisible(f, params)) continue;
    const msg = validateField(f, params[f.name]);
    if (msg) issues.push({ field: f.name, message: msg });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Graph topology
// ---------------------------------------------------------------------------

export interface Edge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export function edgesOf(graph: Pick<WorkflowGraph, "nodes">): Edge[] {
  const edges: Edge[] = [];
  for (const n of graph.nodes) {
    for (const [handle, targets] of Object.entries(n.connections)) {
      for (const t of targets) {
        edges.push({ source: n.id, sourceHandle: handle, target: t.targetId, targetHandle: t.targetHandle ?? "main" });
      }
    }
  }
  return edges;
}

function isLoopBackEdge(e: Edge, nodesById: Map<string, WorkflowNode>): boolean {
  const t = nodesById.get(e.target);
  const def = t && getDefinition(t.type);
  return Boolean(def?.loopInputs?.includes(e.targetHandle));
}

/** True when `to` is reachable from `from` following edges (excluding loop-back edges). */
export function reaches(graph: Pick<WorkflowGraph, "nodes">, from: string, to: string): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const e of edgesOf(graph)) {
    if (isLoopBackEdge(e, byId)) continue;
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(adj.get(cur) ?? []));
  }
  return false;
}

/** Nodes with a path into `nodeId`, nearest first. Loop-back edges count, so loop bodies can see the Loop node. */
export function upstreamNodeIds(graph: Pick<WorkflowGraph, "nodes">, nodeId: string): string[] {
  const incoming = new Map<string, string[]>();
  for (const e of edgesOf(graph)) {
    const list = incoming.get(e.target) ?? [];
    list.push(e.source);
    incoming.set(e.target, list);
  }
  const order: string[] = [];
  const seen = new Set<string>([nodeId]);
  let frontier = incoming.get(nodeId) ?? [];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      next.push(...(incoming.get(id) ?? []));
    }
    frontier = next;
  }
  return order;
}

export function directParents(graph: Pick<WorkflowGraph, "nodes">, nodeId: string): string[] {
  return [...new Set(edgesOf(graph).filter((e) => e.target === nodeId).map((e) => e.source))];
}

export interface ConnectionCheck {
  ok: boolean;
  reason?: string;
}

/** Rules for drawing a new edge in the editor. */
export function canConnect(graph: Pick<WorkflowGraph, "nodes">, e: Edge): ConnectionCheck {
  if (e.source === e.target) return { ok: false, reason: "A step can't connect to itself" };
  const src = graph.nodes.find((n) => n.id === e.source);
  const tgt = graph.nodes.find((n) => n.id === e.target);
  if (!src || !tgt) return { ok: false, reason: "Unknown step" };
  const sdef = getDefinition(src.type);
  const tdef = getDefinition(tgt.type);
  if (!sdef || !tdef) return { ok: false, reason: "Unknown step type" };
  // Tool port: an AI Agent's tools hang off its tool handle and nothing else.
  if (e.sourceHandle === TOOL_HANDLE || tdef.category === "tool") {
    if (e.sourceHandle !== TOOL_HANDLE || !sdef.toolPort) return { ok: false, reason: "Agent tools connect only to an AI Agent's tool port" };
    if (tdef.category !== "tool" || e.targetHandle !== AGENT_HANDLE) return { ok: false, reason: "Only agent tools can connect to the tool port" };
    if (edgesOf(graph).some((x) => x.target === e.target)) return { ok: false, reason: "This tool already belongs to an agent" };
    return { ok: true };
  }
  if (!outputsOf(sdef, src.parameters).some((h) => h.id === e.sourceHandle)) return { ok: false, reason: "Unknown output" };
  if (!tdef.inputs.some((h) => h.id === e.targetHandle)) {
    return { ok: false, reason: tdef.inputs.length === 0 ? "Triggers can't have incoming connections" : "Unknown input" };
  }
  const dup = (src.connections[e.sourceHandle] ?? []).some(
    (t) => t.targetId === e.target && (t.targetHandle ?? "main") === e.targetHandle,
  );
  if (dup) return { ok: false, reason: "Already connected" };
  const loopBack = tdef.loopInputs?.includes(e.targetHandle) ?? false;
  if (!loopBack && reaches(graph, e.target, e.source)) {
    return { ok: false, reason: "That would create a cycle. Use a Loop step to repeat steps." };
  }
  return { ok: true };
}

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

/**
 * Blocking checks applied on save: every type exists, every edge uses real
 * handles, triggers have no inputs, and the only cycles close into a Loop.
 */
export function validateGraphWithRegistry(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    const def = getDefinition(n.type);
    if (!def) {
      issues.push({ nodeId: n.id, message: `Unknown step type "${n.type}"` });
      continue;
    }
    const outs = new Set(outputsOf(def, n.parameters).map((h) => h.id));
    for (const [handle, targets] of Object.entries(n.connections)) {
      if (targets.length === 0) continue;
      if (handle === TOOL_HANDLE) {
        if (!def.toolPort) issues.push({ nodeId: n.id, message: `"${n.label}" has no tool port` });
        for (const t of targets) {
          const tdef = getDefinition(byId.get(t.targetId)?.type ?? "");
          if (tdef && tdef.category !== "tool") issues.push({ nodeId: n.id, message: `"${n.label}" tool port can only connect to agent tools` });
        }
        continue;
      }
      if (!outs.has(handle)) issues.push({ nodeId: n.id, message: `"${n.label}" has no output "${handle}"` });
      for (const t of targets) {
        const target = byId.get(t.targetId);
        const tdef = target && getDefinition(target.type);
        if (!target || !tdef) continue; // reported by structural validation / unknown type
        if (tdef.category === "tool") {
          issues.push({ nodeId: n.id, message: `"${target.label}" is an agent tool; connect it to an AI Agent's tool port` });
          continue;
        }
        const th = t.targetHandle ?? "main";
        if (!tdef.inputs.some((h) => h.id === th)) {
          issues.push({
            nodeId: n.id,
            message:
              tdef.inputs.length === 0
                ? `"${target.label}" is a trigger and can't receive connections`
                : `"${target.label}" has no input "${th}"`,
          });
        }
      }
    }
  }
  // Cycle check ignoring loop-back edges.
  const state = new Map<string, 0 | 1 | 2>();
  const adj = new Map<string, string[]>();
  for (const e of edgesOf(graph)) {
    if (isLoopBackEdge(e, byId)) continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const nxt of adj.get(id) ?? []) {
      const s = state.get(nxt) ?? 0;
      if (s === 1) return true;
      if (s === 0 && visit(nxt)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of graph.nodes) {
    if ((state.get(n.id) ?? 0) === 0 && visit(n.id)) {
      issues.push({ message: "The workflow contains a cycle. Only a Loop step may receive a connection back from later steps." });
      break;
    }
  }
  return issues;
}

/** References in a node's parameters that point to steps that are not upstream of it. */
export function validateNodeReferences(graph: WorkflowGraph, node: WorkflowNode): ParamIssue[] {
  const upstream = new Set(upstreamNodeIds(graph, node.id));
  const hasInput = directParents(graph, node.id).length > 0;
  const issues: ParamIssue[] = [];
  for (const [field, value] of Object.entries(node.parameters)) {
    for (const ref of collectReferences(value)) {
      if (ref.source === INPUT_SOURCE) {
        if (!hasInput) issues.push({ field, message: "Uses the previous step's data, but nothing is connected before this step" });
      } else if (!upstream.has(ref.source)) {
        const exists = graph.nodes.some((n) => n.id === ref.source);
        issues.push({
          field,
          message: exists ? `References "${ref.source}", which doesn't run before this step` : `References a deleted step "${ref.source}"`,
        });
      }
    }
  }
  return issues;
}

/** The AI Agent a tool step is attached to, if any. */
export function agentOfTool(graph: Pick<WorkflowGraph, "nodes">, toolId: string): WorkflowNode | undefined {
  return graph.nodes.find((n) => (n.connections[TOOL_HANDLE] ?? []).some((t) => t.targetId === toolId));
}

/** Tool steps attached to an agent, in connection order. */
export function toolsOfAgent(graph: Pick<WorkflowGraph, "nodes">, agent: WorkflowNode): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (agent.connections[TOOL_HANDLE] ?? []).map((t) => byId.get(t.targetId)).filter((n): n is WorkflowNode => Boolean(n));
}

/** Every problem the editor should flag on a node card. */
export function nodeIssues(graph: WorkflowGraph, node: WorkflowNode): ParamIssue[] {
  const def = getDefinition(node.type);
  if (!def) return [{ field: "", message: `Unknown step type "${node.type}"` }];
  const issues = [...validateNodeParameters(def, node.parameters), ...validateNodeReferences(graph, node)];
  if (def.category === "tool") {
    const agent = agentOfTool(graph, node.id);
    if (!agent) issues.push({ field: "", message: "Connect this tool to an AI Agent's tool port" });
    else {
      for (const ref of collectReferences(node.parameters)) {
        if (ref.source === agent.id) {
          issues.push({ field: "", message: "A tool can't use its own agent's output: the agent hasn't answered yet when it calls tools" });
          break;
        }
      }
    }
  }
  if (def.toolPort) {
    const names = toolsOfAgent(graph, node).map((t) => String(t.parameters.toolName ?? ""));
    const dup = names.find((n, i) => n && names.indexOf(n) !== i);
    if (dup) issues.push({ field: "", message: `Two tools are named "${dup}". Tool names must be unique per agent.` });
  }
  return issues;
}

/**
 * Credits a step costs per run. Triggers, flow control, data transforms and tools
 * (paid for by their agent) are free; calls out (HTTP, code, apps) cost 1; AI costs more.
 */
export function creditCost(def: NodeDefinition): number {
  if (def.credits !== undefined) return def.credits;
  switch (def.category) {
    case "trigger":
    case "flow":
    case "transform":
    case "tool":
      return 0;
    case "ai":
      return def.type === "ai.agent" ? 5 : 2;
    default:
      return def.type === "core.set" || def.type === "core.respond" ? 0 : 1;
  }
}
