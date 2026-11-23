"use client";

import { canConnect, edgesOf, nodeIssues, TOOL_HANDLE } from "@conduit/nodes";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChangeset,
  type NodeChangeset,
  type OnConnectEnd,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { useEditor, useEditorStoreApi } from "./context";
import { DeletableEdge } from "./deletable-edge";
import { StickyNoteCard, type StickyFlowNode } from "./sticky-node";
import { edgeId, latestSteps, type XY } from "./store";
import { WorkflowNodeCard, type WorkflowFlowNode } from "./workflow-node";

const nodeTypes = { workflow: WorkflowNodeCard, sticky: StickyNoteCard };
const edgeTypes = { deletable: DeletableEdge };

type FlowNode = WorkflowFlowNode | StickyFlowNode;
export type MeasuredMap = Record<string, { width: number; height: number }>;

export function Canvas({
  measuredRef,
  showMinimap,
  children,
}: {
  measuredRef: MutableRefObject<MeasuredMap>;
  showMinimap: boolean;
  children?: React.ReactNode;
}) {
  const store = useEditorStoreApi();
  const graph = useEditor((s) => s.graph);
  const selectedNodeIds = useEditor((s) => s.selectedNodeIds);
  const selectedEdgeIds = useEditor((s) => s.selectedEdgeIds);
  const connectError = useEditor((s) => s.connectError);
  const run = useEditor((s) => s.run);
  const highlight = useEditor((s) => s.highlight);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => store.getState().clearHighlight(), 6000);
    return () => clearTimeout(t);
  }, [highlight, store]);
  const rf = useReactFlow();
  const [measured, setMeasured] = useState<MeasuredMap>({});
  useEffect(() => {
    measuredRef.current = measured;
  }, [measured, measuredRef]);

  useEffect(() => {
    if (connectError) {
      toast.error(connectError);
      store.getState().clearConnectError();
    }
  }, [connectError, store]);

  const nodes = useMemo<FlowNode[]>(() => {
    const sel = new Set(selectedNodeIds);
    const edges = edgesOf(graph);
    const steps = latestSteps(run);
    const sticky: StickyFlowNode[] = graph.stickyNotes.map((n) => ({
      id: n.id,
      type: "sticky",
      position: n.position,
      data: { note: n },
      selected: sel.has(n.id),
      zIndex: -1,
      width: n.size.width,
      height: n.size.height,
      measured: measured[n.id],
    }));
    const wf: WorkflowFlowNode[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "workflow",
      position: n.position,
      data: {
        node: n,
        orientation: graph.orientation,
        issues: nodeIssues(graph, n),
        connectedOutputs: [...new Set(edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle))],
        runStep: steps[n.id]
          ? {
              status: steps[n.id]!.status,
              items: Object.values(steps[n.id]!.outputCounts).reduce((a, b) => a + b, 0),
              error: steps[n.id]!.error,
            }
          : undefined,
        highlight: highlight?.added.includes(n.id) ? "added" : highlight?.updated.includes(n.id) ? "updated" : undefined,
        toolCount: (n.connections[TOOL_HANDLE] ?? []).length,
      },
      selected: sel.has(n.id),
      measured: measured[n.id],
    }));
    return [...sticky, ...wf];
  }, [graph, selectedNodeIds, measured, run, highlight]);

  const edges = useMemo<FlowEdge[]>(() => {
    const sel = new Set(selectedEdgeIds);
    return edgesOf(graph).map((e) => {
      const id = edgeId(e);
      return {
        id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "deletable",
        selected: sel.has(id),
        data: { tool: e.sourceHandle === TOOL_HANDLE },
      };
    });
  }, [graph, selectedEdgeIds]);

  const onNodesChange = useCallback(
    (changes: NodeChangeset<FlowNode>) => {
      const positions: Record<string, XY> = {};
      let selection: Set<string> | null = null;
      const dims: MeasuredMap = {};
      for (const c of changes.toArray()) {
        if (c.type === "dimensions" && c.dimensions) {
          dims[c.id] = c.dimensions;
        } else if (c.type === "position" && c.position) {
          positions[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
        } else if (c.type === "select") {
          selection ??= new Set(store.getState().selectedNodeIds);
          if (c.selected) selection.add(c.id);
          else selection.delete(c.id);
        }
      }
      if (Object.keys(dims).length) setMeasured((m) => ({ ...m, ...dims }));
      if (Object.keys(positions).length) store.getState().moveNodes(positions);
      if (selection) store.getState().setSelection([...selection], store.getState().selectedEdgeIds);
    },
    [store],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChangeset<FlowEdge>) => {
      let selection: Set<string> | null = null;
      for (const c of changes.toArray()) {
        if (c.type === "select") {
          selection ??= new Set(store.getState().selectedEdgeIds);
          if (c.selected) selection.add(c.id);
          else selection.delete(c.id);
        }
      }
      if (selection) store.getState().setSelection(store.getState().selectedNodeIds, [...selection]);
    },
    [store],
  );

  const toEdge = (c: Connection) => ({
    source: c.source,
    sourceHandle: c.sourceHandle ?? "main",
    target: c.target,
    targetHandle: c.targetHandle ?? "main",
  });

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.toNode || !state.fromNode || state.fromHandle?.type !== "source") return;
      const point = "changedTouches" in event ? event.changedTouches[0]! : event;
      const position = rf.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      store.getState().openPicker({
        from: { nodeId: state.fromNode.id, handle: state.fromHandle.id ?? "main" },
        position: { x: Math.round(position.x), y: Math.round(position.y - 30) },
      });
    },
    [rf, store],
  );

  const hasViewport = graph.viewport.x !== 0 || graph.viewport.y !== 0 || graph.viewport.zoom !== 1;

  // The first fit can run before the page around the canvas has settled (panels opening,
  // the sidebar closing), which leaves the steps off-center. Fit once more after nodes are measured.
  const nodesReady = useNodesInitialized();
  const refitted = useRef(false);
  useEffect(() => {
    if (!nodesReady || refitted.current || hasViewport || !graph.nodes.length) return;
    refitted.current = true;
    const t = setTimeout(() => void rf.fitView({ maxZoom: 1, padding: 0.3 }), 120);
    return () => clearTimeout(t);
  }, [nodesReady, hasViewport, graph.nodes.length, rf]);

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(c) => store.getState().connect(toEdge(c))}
      onConnectEnd={onConnectEnd}
      isValidConnection={(c) => canConnect(store.getState().graph, toEdge(c as Connection)).ok}
      onDelete={({ nodes: n, edges: e }) =>
        store.getState().deleteElements(
          n.map((x) => x.id),
          e.map((x) => x.id),
        )
      }
      onNodeDragStart={() => store.getState().beginDrag()}
      onNodeDragStop={() => store.getState().endDrag()}
      onSelectionDragStart={() => store.getState().beginDrag()}
      onSelectionDragStop={() => store.getState().endDrag()}
      onNodeClick={(_e, node) => {
        if (node.type === "workflow") store.getState().openNode(node.id);
      }}
      onPaneClick={() => store.getState().openNode(null)}
      deleteKeyCode={["Backspace", "Delete"]}
      multiSelectionKeyCode={["Shift", "Meta", "Control"]}
      defaultViewport={graph.viewport}
      fitView={!hasViewport && graph.nodes.length > 0}
      fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "deletable" }}
      className="bg-background"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
      {showMinimap && (
        <MiniMap pannable zoomable className="!rounded-lg !border !bg-card" maskColor="rgb(0 0 0 / 0.15)" />
      )}
      {children}
    </ReactFlow>
  );
}
