import { z } from "zod";
import {
  connectionsSchema,
  nodeIdSchema,
  positionSchema,
  workflowGraphSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from "./workflow";

/**
 * A batch of edits to a workflow graph, produced by the AI builder (and later the
 * MCP server). New nodes go in `nodes`, edits to existing nodes in `updates`,
 * removals in `deleted`. Connections are keyed by source handle on the source node.
 */
export const changeSetSchema = z.object({
  response: z.string().trim().min(1).max(16_000),
  nodes: z
    .array(
      z.object({
        id: nodeIdSchema,
        type: z.string().min(1).max(250),
        label: z.string().trim().min(1).max(200),
        parameters: z.record(z.string(), z.unknown()).default({}),
        position: positionSchema.optional(),
        connections: connectionsSchema.default({}),
      }),
    )
    .max(100)
    .default([]),
  updates: z
    .array(
      z.object({
        id: nodeIdSchema,
        label: z.string().trim().min(1).max(200).optional(),
        /** Merged into the node's parameters; a key set to null is removed. */
        parameters: z.record(z.string(), z.unknown()).optional(),
        position: positionSchema.optional(),
        /** Replaces all outgoing connections when present. */
        connections: connectionsSchema.optional(),
      }),
    )
    .max(250)
    .default([]),
  deleted: z.array(nodeIdSchema).max(250).default([]),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export interface ChangeSummary {
  added: string[];
  updated: string[];
  deleted: string[];
}

export class ChangeSetError extends Error {}

const GAP_X = 260;

/**
 * Applies a change set to a copy of the graph. Throws ChangeSetError for references
 * to missing nodes or ID clashes; schema/registry validation is the caller's job.
 */
export function applyChangeSet(graph: WorkflowGraph, changes: ChangeSet): { graph: WorkflowGraph; summary: ChangeSummary } {
  const g: WorkflowGraph = structuredClone(graph);
  const ids = new Set(g.nodes.map((n) => n.id));
  const deleted = new Set(changes.deleted);
  for (const id of deleted) if (!ids.has(id)) throw new ChangeSetError(`Can't delete "${id}": no such step`);

  // Deletions first, including edges pointing at deleted nodes.
  g.nodes = g.nodes.filter((n) => !deleted.has(n.id));
  for (const n of g.nodes) {
    for (const [h, list] of Object.entries(n.connections)) {
      const kept = list.filter((t) => !deleted.has(t.targetId));
      if (kept.length) n.connections[h] = kept;
      else delete n.connections[h];
    }
  }

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const u of changes.updates) {
    const n = byId.get(u.id);
    if (!n) throw new ChangeSetError(`Can't update "${u.id}": no such step`);
    if (u.label !== undefined) n.label = u.label;
    if (u.position) n.position = u.position;
    if (u.parameters) {
      for (const [k, v] of Object.entries(u.parameters)) {
        if (v === null) delete n.parameters[k];
        else n.parameters[k] = v;
      }
    }
    if (u.connections) n.connections = u.connections;
  }

  // New nodes: place unpositioned ones in a row to the right of the existing graph.
  const maxX = g.nodes.length ? Math.max(...g.nodes.map((n) => n.position.x)) : -GAP_X;
  const baseY = g.nodes.length ? Math.min(...g.nodes.map((n) => n.position.y)) : 0;
  let col = 1;
  for (const add of changes.nodes) {
    if (byId.has(add.id)) throw new ChangeSetError(`A step with ID "${add.id}" already exists`);
    const node: WorkflowNode = {
      id: add.id,
      type: add.type,
      typeVersion: 1,
      label: add.label,
      parameters: add.parameters,
      position: add.position ?? { x: maxX + GAP_X * col++, y: baseY },
      connections: add.connections,
    };
    g.nodes.push(node);
    byId.set(node.id, node);
  }

  const parsed = workflowGraphSchema.safeParse(g);
  if (!parsed.success) throw new ChangeSetError(parsed.error.issues[0]?.message ?? "Invalid change set");
  return {
    graph: parsed.data,
    summary: { added: changes.nodes.map((n) => n.id), updated: changes.updates.map((u) => u.id), deleted: [...deleted] },
  };
}
