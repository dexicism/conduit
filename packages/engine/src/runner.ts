import { resolveParameters, type WorkflowGraph, type WorkflowNode } from "@conduit/core";
import { getDefinition, outputsOf, reaches, TOOL_HANDLE, type NodeDefinition } from "@conduit/nodes";
import { agentExecutor, classifyExecutor, extractExecutor, moderateExecutor, sentimentExecutor } from "./executors/ai";
import { APP_ACTIONS, appActionExecutor } from "./executors/apps";
import { codeExecutor, executeWorkflowExecutor, httpExecutor, respondExecutor, setExecutor } from "./executors/core";
import { combineMerge, filterExecutor, ifExecutor, onlyNewExecutor, switchExecutor, waitExecutor } from "./executors/flow";
import { cryptoExecutor, dateExecutor, jsonExecutor, listExecutor, mathExecutor, textExecutor } from "./executors/transform";
import {
  StepError,
  type EngineServices,
  type ExecContext,
  type Executor,
  type Item,
  type RunHooks,
  type RunOutcome,
  type RunState,
  type StepRecord,
  type Task,
} from "./types";
import { teamCheckExecutor } from "./executors/team";
import { pdfExecutor } from "./executors/documents";
import { toNumber } from "./values";

export const MAX_STEPS = 10_000;

const EXECUTORS: Record<string, Executor> = {
  "flow.if": ifExecutor,
  "flow.filter": filterExecutor,
  "flow.onlyNew": onlyNewExecutor,
  "app.team.check": teamCheckExecutor,
  "doc.pdf": pdfExecutor,
  "flow.switch": switchExecutor,
  "flow.wait": waitExecutor,
  "core.http": httpExecutor,
  "core.code": codeExecutor,
  "core.set": setExecutor,
  "core.respond": respondExecutor,
  "core.execute-workflow": executeWorkflowExecutor,
  "transform.text": textExecutor,
  "transform.math": mathExecutor,
  "transform.date": dateExecutor,
  "transform.crypto": cryptoExecutor,
  "transform.json": jsonExecutor,
  "transform.list": listExecutor,
  "ai.agent": agentExecutor,
  "ai.classify": classifyExecutor,
  "ai.sentiment": sentimentExecutor,
  "ai.moderate": moderateExecutor,
  "ai.extract": extractExecutor,
  ...Object.fromEntries(Object.keys(APP_ACTIONS).map((t) => [t, appActionExecutor])),
};

export function hasExecutor(type: string): boolean {
  return type in EXECUTORS || type.startsWith("trigger.") || type === "flow.loop" || type === "flow.merge";
}

interface WaitEntry {
  task: Task;
  until: string;
}

export interface EngineState extends RunState {
  waits: WaitEntry[];
}

/** Starts a run: the trigger's items become its output and its children are queued. */
export function initialState(graph: WorkflowGraph, triggerNodeId: string, items: Item[]): EngineState {
  const trigger = graph.nodes.find((n) => n.id === triggerNodeId);
  if (!trigger) throw new Error(`Trigger "${triggerNodeId}" not found`);
  const state: EngineState = { queue: [], outputs: {}, loops: {}, merges: {}, steps: 0, lastOutput: items, waits: [] };
  state.queue.push({ nodeId: triggerNodeId, inputHandle: "__trigger", items });
  return state;
}

function enqueueChildren(state: EngineState, node: WorkflowNode, outputs: Record<string, Item[]>) {
  for (const [handle, items] of Object.entries(outputs)) {
    // Tools hang off the agent's tool port and run only when the agent calls them.
    if (!items.length || handle === TOOL_HANDLE) continue;
    for (const t of node.connections[handle] ?? []) {
      state.queue.push({ nodeId: t.targetId, inputHandle: t.targetHandle ?? "main", items, from: node.id });
    }
  }
}

function firstOutputId(def: NodeDefinition, node: WorkflowNode): string {
  return outputsOf(def, node.parameters)[0]?.id ?? "main";
}

function makeParams(graph: WorkflowGraph, node: WorkflowNode, items: Item[], state: RunState, vars?: Record<string, string>) {
  const cache = new Map<number, Record<string, unknown>>();
  return (i: number) => {
    const hit = cache.get(i);
    if (hit) return hit;
    const nodes: Record<string, unknown> = {};
    for (const [id, out] of Object.entries(state.outputs)) {
      if (!out.length) continue;
      nodes[id] = out[Math.min(i, out.length - 1)]!.json;
    }
    const { value } = resolveParameters(node.parameters, { input: items[i]?.json, nodes, vars });
    cache.set(i, value);
    return value;
  };
}

function hasLoopBack(graph: WorkflowGraph, loopId: string): boolean {
  return graph.nodes.some(
    (n) => n.id !== loopId && Object.values(n.connections).some((ts) => ts.some((t) => t.targetId === loopId)) && reaches(graph, loopId, n.id),
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function runLoop(graph: WorkflowGraph, node: WorkflowNode, task: Task, state: EngineState, params: (i: number) => Record<string, unknown>) {
  const isBack = Boolean(task.from && reaches(graph, node.id, task.from) && state.loops[node.id]);
  if (isBack) return advanceLoop(node.id, state, task.items);

  const elements: Item[] = [];
  task.items.forEach((item, i) => {
    const p = params(i);
    if (p.mode === "count") {
      const n = Math.floor(toNumber(p.count ?? 0, "Times"));
      if (n < 0 || n > 100_000) throw new StepError("Times must be between 0 and 100000");
      for (let k = 0; k < n; k++) elements.push({ json: { item: item.json, index: k, total: n } });
    } else {
      const list = p.list;
      if (!Array.isArray(list)) throw new StepError(`List must be a list (got ${JSON.stringify(list)?.slice(0, 80) ?? "nothing"})`);
      list.forEach((el, k) => elements.push({ json: { item: el, index: k, total: list.length } }));
    }
  });
  const size = Math.max(1, Math.floor(toNumber(params(0).batchSize ?? 1, "Elements per iteration")));
  const batches = chunk(elements, size);
  if (!batches.length) return { loop: [], done: task.items };
  if (!hasLoopBack(graph, node.id)) return { loop: elements, done: task.items };
  state.loops[node.id] = { batches, next: 1, collected: [], original: task.items };
  return { loop: batches[0]!, done: [] };
}

function advanceLoop(loopId: string, state: EngineState, returned: Item[]): Record<string, Item[]> {
  const ls = state.loops[loopId];
  if (!ls) return { loop: [], done: returned };
  ls.collected.push(...returned);
  if (ls.next < ls.batches.length) return { loop: ls.batches[ls.next++]!, done: [] };
  delete state.loops[loopId];
  return { loop: [], done: ls.collected.length ? ls.collected : ls.original };
}

function record(
  state: EngineState,
  node: WorkflowNode,
  started: number,
  services: EngineServices,
  input: Item[],
  output: Record<string, Item[]>,
  status: StepRecord["status"],
  logs: string[],
  error?: string,
): StepRecord {
  return {
    index: state.steps,
    nodeId: node.id,
    label: node.label,
    type: node.type,
    status,
    startedAt: new Date(started),
    durationMs: Math.max(0, services.now().getTime() - started),
    input,
    output,
    error,
    logs,
  };
}

/**
 * Runs (or resumes) an execution until it finishes, fails, or every remaining
 * branch is waiting. Persisting state between calls is the caller's job.
 */
export async function runExecution(opts: {
  graph: WorkflowGraph;
  state: EngineState;
  services: EngineServices;
  hooks?: RunHooks;
}): Promise<RunOutcome & { state: EngineState }> {
  const { graph, services, hooks } = opts;
  const state = opts.state;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Resume any waits that are due.
  const now = services.now().getTime();
  const due = state.waits.filter((w) => new Date(w.until).getTime() <= now);
  state.waits = state.waits.filter((w) => new Date(w.until).getTime() > now);
  for (const w of due) state.queue.push({ ...w.task, resume: true });

  for (;;) {
    const task = state.queue.shift();
    if (!task) {
      // Nothing runnable. Pending waits come first: a loop body may be waiting.
      if (state.waits.length) {
        const resumeAt = new Date(Math.min(...state.waits.map((w) => new Date(w.until).getTime())));
        return { status: "waiting", state, resumeAt };
      }
      // Then advance loops whose body ended without looping back, and flush
      // merges that will never receive their second input.
      const loopId = Object.keys(state.loops)[0];
      if (loopId) {
        const node = byId.get(loopId)!;
        enqueueChildren(state, node, advanceLoop(loopId, state, []));
        continue;
      }
      const mergeId = Object.keys(state.merges)[0];
      if (mergeId) {
        const node = byId.get(mergeId)!;
        const buf = state.merges[mergeId]!;
        delete state.merges[mergeId];
        const items = combineMerge(node.parameters.mode, buf.a, buf.b);
        state.outputs[node.id] = items;
        state.lastOutput = items;
        enqueueChildren(state, node, { main: items });
        continue;
      }
      return { status: "success", state };
    }

    if (++state.steps > MAX_STEPS) {
      return { status: "failed", state, error: { message: `Stopped after ${MAX_STEPS} steps. Check for a loop that never ends.` } };
    }
    const node = byId.get(task.nodeId);
    if (!node) continue;
    const def = getDefinition(node.type);
    const started = services.now().getTime();
    const logs: string[] = [];
    await hooks?.onStepStart?.(node.id);

    try {
      if (!def) throw new StepError(`Unknown step type "${node.type}"`);
      let outputs: Record<string, Item[]>;

      if (task.resume) {
        outputs = { main: task.items };
      } else if (def.category === "trigger") {
        outputs = { main: task.items };
      } else if (node.disabled) {
        outputs = { [firstOutputId(def, node)]: task.items };
      } else if (node.type === "flow.merge") {
        const buf = (state.merges[node.id] ??= {});
        const key = task.inputHandle === "b" ? "b" : "a";
        buf[key] = [...(buf[key] ?? []), ...task.items];
        if (!buf.a || !buf.b) {
          const rec = record(state, node, started, services, task.items, {}, "waiting", [`Waiting for input ${key === "a" ? "B" : "A"}`]);
          await hooks?.onStep?.(rec);
          continue;
        }
        delete state.merges[node.id];
        outputs = { main: combineMerge(node.parameters.mode, buf.a, buf.b) };
      } else if (node.type === "flow.loop") {
        outputs = runLoop(graph, node, task, state, makeParams(graph, node, task.items, state, services.vars));
      } else {
        const exec = EXECUTORS[node.type];
        if (!exec) throw new StepError(`"${def.name}" can't run yet`);
        await hooks?.beforeExecute?.(node, def);
        const ctx: ExecContext = {
          graph,
          node,
          def,
          items: task.items,
          inputHandle: task.inputHandle,
          from: task.from,
          state,
          services,
          params: makeParams(graph, node, task.items, state, services.vars),
          log: (m) => logs.push(m),
        };
        const res = await exec(ctx);
        if ("wait" in res) {
          state.waits.push({ task: { ...task }, until: res.wait.until.toISOString() });
          await hooks?.onStep?.(
            record(state, node, started, services, task.items, {}, "waiting", [`Waiting until ${res.wait.until.toISOString()}`]),
          );
          continue;
        }
        outputs = res.outputs;
      }

      const all = Object.values(outputs).flat();
      state.outputs[node.id] = all;
      if (all.length) state.lastOutput = all;
      await hooks?.onStep?.(record(state, node, started, services, task.items, outputs, "success", logs));
      enqueueChildren(state, node, outputs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (node.onError === "continue" && def) {
        const items = task.items.map((it) => ({ json: { ...it.json, error: message } }));
        const outputs = { [firstOutputId(def, node)]: items };
        state.outputs[node.id] = items;
        await hooks?.onStep?.(record(state, node, started, services, task.items, outputs, "failed", logs, message));
        enqueueChildren(state, node, outputs);
        continue;
      }
      await hooks?.onStep?.(record(state, node, started, services, task.items, {}, "failed", logs, message));
      return { status: "failed", state, error: { nodeId: node.id, message } };
    }
  }
}
