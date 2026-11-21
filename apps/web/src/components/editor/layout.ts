"use client";

import type { Orientation, WorkflowGraph } from "@conduit/core";
import { edgesOf } from "@conduit/nodes";
import type { XY } from "./store";

const DEFAULT_SIZE = { width: 200, height: 72 };

/** Layered auto-layout (ELK). Sticky notes keep their positions. */
export async function computeLayout(
  graph: WorkflowGraph,
  orientation: Orientation,
  measured: Record<string, { width: number; height: number }>,
): Promise<Record<string, XY>> {
  if (graph.nodes.length === 0) return {};
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const ids = new Set(graph.nodes.map((n) => n.id));
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": orientation === "horizontal" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    },
    children: graph.nodes.map((n) => ({ id: n.id, ...(measured[n.id] ?? DEFAULT_SIZE) })),
    edges: edgesOf(graph)
      .filter((e) => ids.has(e.target))
      .map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
  });

  // Keep the laid-out graph anchored where the first node used to be.
  const first = graph.nodes[0]!;
  const laidFirst = result.children?.find((c) => c.id === first.id);
  const dx = first.position.x - (laidFirst?.x ?? 0);
  const dy = first.position.y - (laidFirst?.y ?? 0);
  const out: Record<string, XY> = {};
  for (const c of result.children ?? []) out[c.id] = { x: Math.round((c.x ?? 0) + dx), y: Math.round((c.y ?? 0) + dy) };
  return out;
}
