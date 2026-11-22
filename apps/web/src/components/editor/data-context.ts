"use client";

import { INPUT_SOURCE, VARS_SOURCE, type ResolveContext, type StepSummary, type WorkflowGraph } from "@conduit/core";
import { agentOfTool, directParents, getDefinition, upstreamNodeIds } from "@conduit/nodes";

export interface DataSource {
  /** `$input` or a node ID. */
  source: string;
  label: string;
  typeName: string;
  sample: unknown;
  /** True when the sample is real data from the last test run. */
  fromRun: boolean;
}

function sampleFor(nodeId: string, type: string, steps: Record<string, StepSummary>): { sample: unknown; fromRun: boolean } {
  const step = steps[nodeId];
  const first = step ? Object.values(step.output).flat()[0] : undefined;
  if (first) return { sample: first.json, fromRun: true };
  return { sample: getDefinition(type)?.outputSample ?? {}, fromRun: false };
}

/**
 * Data available to a node's parameters: the previous step's item ($input) and every
 * upstream step by ID. Uses real output from the latest test run when there is one,
 * otherwise each step type's example output.
 */
export function dataSourcesFor(graph: WorkflowGraph, nodeId: string, steps: Record<string, StepSummary> = {}): DataSource[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A tool runs inside its agent's turn: it sees the agent's input, not the agent's (unfinished) output.
  const self = byId.get(nodeId);
  if (self && getDefinition(self.type)?.category === "tool") {
    const agent = agentOfTool(graph, nodeId);
    return agent ? dataSourcesFor(graph, agent.id, steps) : [];
  }
  const out: DataSource[] = [];
  const parents = directParents(graph, nodeId);
  const first = parents[0] && byId.get(parents[0]);
  if (first) {
    out.push({
      source: INPUT_SOURCE,
      label: parents.length > 1 ? "Previous step (whichever ran)" : `Previous step · ${first.label}`,
      typeName: getDefinition(first.type)?.name ?? first.type,
      ...sampleFor(first.id, first.type, steps),
    });
  }
  for (const id of upstreamNodeIds(graph, nodeId)) {
    const n = byId.get(id);
    if (!n) continue;
    out.push({ source: id, label: n.label, typeName: getDefinition(n.type)?.name ?? n.type, ...sampleFor(n.id, n.type, steps) });
  }
  return out;
}

/** Workspace variables as a data source. Secret values show as a placeholder. */
export function variablesSource(vars: Array<{ name: string; secret: boolean; value: string | null }>): DataSource | null {
  if (!vars.length) return null;
  return {
    source: VARS_SOURCE,
    label: "Workspace variables",
    typeName: "Settings",
    sample: Object.fromEntries(vars.map((v) => [v.name, v.secret ? "(secret)" : (v.value ?? "")])),
    fromRun: false,
  };
}

export function resolveContextFor(sources: DataSource[]): ResolveContext {
  const ctx: ResolveContext = { nodes: {} };
  for (const s of sources) {
    if (s.source === INPUT_SOURCE) ctx.input = s.sample;
    else if (s.source === VARS_SOURCE) ctx.vars = s.sample as Record<string, unknown>;
    else ctx.nodes[s.source] = s.sample;
  }
  return ctx;
}
