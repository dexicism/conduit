"use client";

import type {
  ExecutionSummary,
  Orientation,
  StepSummary,
  StickyNote,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowNode,
} from "@conduit/core";
import {
  canConnect,
  defaultParameters,
  getDefinition,
  outputsOf,
  shortId,
  TOOL_HANDLE,
  uniqueLabel,
  uniqueNodeId,
  type Edge,
} from "@conduit/nodes";
import { createStore, type StoreApi } from "zustand/vanilla";

export type SaveState = "saved" | "dirty" | "saving" | "offline" | "conflict" | "error";

export interface XY {
  x: number;
  y: number;
}

export interface PickerRequest {
  /** Where to place the new node, in flow coordinates. */
  position?: XY;
  /** Connect the new node from this output. */
  from?: { nodeId: string; handle: string };
  /** Only offer triggers (empty canvas). */
  triggersOnly?: boolean;
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1200;
const PASTE_MIME = "conduit/nodes";

export interface ClipboardPayload {
  kind: typeof PASTE_MIME;
  nodes: WorkflowNode[];
  stickyNotes: StickyNote[];
}

export interface EditorState {
  workflowId: string;
  graph: WorkflowGraph;
  /** Server revision the current graph is based on. */
  revision: number;
  /** Incremented on every persisted change; autosave compares with `savedCounter`. */
  changeCounter: number;
  savedCounter: number;
  saveState: SaveState;
  saveMessage: string | null;

  past: WorkflowGraph[];
  future: WorkflowGraph[];
  coalesceKey: string | null;
  coalesceAt: number;
  dragStart: WorkflowGraph | null;

  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  openNodeId: string | null;
  picker: PickerRequest | null;
  /** Last connection rule violation, shown as a toast by the canvas. */
  connectError: string | null;

  /** Draft revision that is live, or null when unpublished. */
  publishedRevision: number | null;
  run: RunView | null;
  /** Tab to show when the config panel opens (the run panel opens steps on Output). */
  panelTab: "parameters" | "output" | "settings";

  ai: { enabled: boolean; provider: string };
  builderOpen: boolean;
  /** Steps the builder just added or changed, highlighted briefly on the canvas. */
  highlight: { added: string[]; updated: string[]; at: number } | null;

  // --- actions ---
  apply: (mutate: (g: WorkflowGraph) => void, opts?: { coalesce?: string }) => void;
  undo: () => void;
  redo: () => void;
  beginDrag: () => void;
  moveNodes: (positions: Record<string, XY>) => void;
  endDrag: () => void;

  addNode: (type: string, req: PickerRequest | null, fallback: XY) => string | null;
  updateNode: (id: string, patch: Partial<Pick<WorkflowNode, "label" | "disabled" | "notes" | "onError">>) => void;
  setParameter: (id: string, name: string, value: unknown) => void;
  connect: (e: Edge) => boolean;
  deleteElements: (nodeIds: string[], edgeIds: string[]) => void;
  duplicateNodes: (ids: string[]) => void;
  copyPayload: (ids: string[]) => ClipboardPayload | null;
  paste: (payload: ClipboardPayload, at?: XY) => void;

  addSticky: (at: XY) => void;
  updateSticky: (id: string, patch: Partial<Pick<StickyNote, "text" | "size" | "color">>) => void;

  setOrientation: (o: Orientation, positions?: Record<string, XY>) => void;
  applyLayout: (positions: Record<string, XY>) => void;

  setSelection: (nodeIds: string[], edgeIds: string[]) => void;
  openNode: (id: string | null) => void;
  openPicker: (req: PickerRequest | null) => void;
  clearConnectError: () => void;

  markSaving: () => void;
  markSaved: (revision: number, counter: number) => void;
  markSaveFailed: (state: "offline" | "conflict" | "error", message: string) => void;
  resetFromServer: (wf: WorkflowDetail) => void;
  adoptServerRevision: (revision: number) => void;

  setPublishedRevision: (rev: number | null) => void;
  setRun: (run: RunView | null) => void;
  patchRun: (patch: Partial<RunView>) => void;
  addRunStep: (step: StepSummary) => void;
  openNodeTab: (id: string, tab: EditorState["panelTab"]) => void;
  setBuilderOpen: (open: boolean) => void;
  /** Adopts a graph the builder already saved server-side, as one undoable change. */
  applyBuilderResult: (graph: WorkflowGraph, revision: number, summary: { added: string[]; updated: string[] }) => void;
  clearHighlight: () => void;
}

export interface RunView {
  executionId: string | null;
  summary: ExecutionSummary | null;
  steps: StepSummary[];
  /** Webhook test listener, while waiting for the request. */
  listening: { testUrl: string; method: string; expiresAt: string; nodeId: string } | null;
  /** UI phase before an execution exists. */
  phase: "saving" | "starting" | "listening" | "running" | "done";
  error: string | null;
}

/** Latest step per node from the current run. */
export function latestSteps(run: RunView | null): Record<string, StepSummary> {
  const out: Record<string, StepSummary> = {};
  for (const s of run?.steps ?? []) out[s.nodeId] = s;
  return out;
}

export function edgeId(e: Edge): string {
  return `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`;
}

export function parseEdgeId(id: string): Edge | null {
  const m = /^(.+?):(.+?)->(.+?):(.+)$/.exec(id);
  return m ? { source: m[1]!, sourceHandle: m[2]!, target: m[3]!, targetHandle: m[4]! } : null;
}

function removeEdge(g: WorkflowGraph, e: Edge): void {
  const src = g.nodes.find((n) => n.id === e.source);
  if (!src) return;
  const list = src.connections[e.sourceHandle];
  if (!list) return;
  const next = list.filter((t) => !(t.targetId === e.target && (t.targetHandle ?? "main") === e.targetHandle));
  if (next.length) src.connections[e.sourceHandle] = next;
  else delete src.connections[e.sourceHandle];
}

/** Drops edges whose source handle no longer exists (e.g. a removed Switch case). */
function pruneDeadHandles(node: WorkflowNode): void {
  const def = getDefinition(node.type);
  if (!def) return;
  const valid = new Set(outputsOf(def, node.parameters).map((h) => h.id));
  for (const h of Object.keys(node.connections)) if (!valid.has(h)) delete node.connections[h];
}

/**
 * Where a step added after `from` on `handle` goes: one column over, fanned out by
 * output index (true above false, Switch cases in order) so branches never cover
 * each other's add buttons.
 */
function nextPosition(from: WorkflowNode, handle: string, orientation: Orientation): XY {
  if (handle === TOOL_HANDLE) {
    // Tools fan out below (or beside, when vertical) the agent.
    const n = (from.connections[TOOL_HANDLE] ?? []).length;
    return orientation === "horizontal"
      ? { x: from.position.x - 40 + n * 220, y: from.position.y + 170 }
      : { x: from.position.x + 280, y: from.position.y + 40 + n * 110 };
  }
  const def = getDefinition(from.type);
  const outs = def ? outputsOf(def, from.parameters) : [];
  const index = Math.max(0, outs.findIndex((o) => o.id === handle));
  const fan = index - (outs.length - 1) / 2;
  const onHandle = (from.connections[handle] ?? []).length;
  return orientation === "horizontal"
    ? { x: from.position.x + 300, y: Math.round(from.position.y + fan * 130 + onHandle * 110) }
    : { x: Math.round(from.position.x + fan * 260 + onHandle * 240), y: from.position.y + 170 };
}

export function createEditorStore(
  wf: WorkflowDetail,
  ai: EditorState["ai"] = { enabled: false, provider: "none" },
): StoreApi<EditorState> {
  return createStore<EditorState>()((set, get) => {
    const commit = (next: WorkflowGraph, prev: WorkflowGraph, coalesce?: string) => {
      const s = get();
      const now = Date.now();
      const merge = coalesce && s.coalesceKey === coalesce && now - s.coalesceAt < COALESCE_MS;
      set({
        graph: next,
        past: merge ? s.past : [...s.past, prev].slice(-HISTORY_LIMIT),
        future: [],
        coalesceKey: coalesce ?? null,
        coalesceAt: now,
        changeCounter: s.changeCounter + 1,
        saveState: s.saveState === "conflict" ? "conflict" : "dirty",
      });
    };

    const keepSelectionValid = (g: WorkflowGraph) => {
      const ids = new Set([...g.nodes.map((n) => n.id), ...g.stickyNotes.map((n) => n.id)]);
      const s = get();
      return {
        selectedNodeIds: s.selectedNodeIds.filter((id) => ids.has(id)),
        selectedEdgeIds: [],
        openNodeId: s.openNodeId && g.nodes.some((n) => n.id === s.openNodeId) ? s.openNodeId : null,
      };
    };

    return {
      workflowId: wf.id,
      graph: wf.draft,
      revision: wf.revision,
      changeCounter: 0,
      savedCounter: 0,
      saveState: "saved",
      saveMessage: null,
      past: [],
      future: [],
      coalesceKey: null,
      coalesceAt: 0,
      dragStart: null,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      openNodeId: null,
      picker: null,
      connectError: null,
      publishedRevision: wf.publishedRevision,
      run: null,
      panelTab: "parameters",
      ai,
      builderOpen: false,
      highlight: null,

      apply: (mutate, opts) => {
        const prev = get().graph;
        const next = structuredClone(prev);
        mutate(next);
        commit(next, prev, opts?.coalesce);
      },

      undo: () => {
        const s = get();
        const prev = s.past[s.past.length - 1];
        if (!prev) return;
        set({
          graph: prev,
          past: s.past.slice(0, -1),
          future: [s.graph, ...s.future].slice(0, HISTORY_LIMIT),
          coalesceKey: null,
          changeCounter: s.changeCounter + 1,
          saveState: s.saveState === "conflict" ? "conflict" : "dirty",
          ...keepSelectionValid(prev),
        });
      },

      redo: () => {
        const s = get();
        const next = s.future[0];
        if (!next) return;
        set({
          graph: next,
          past: [...s.past, s.graph].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          coalesceKey: null,
          changeCounter: s.changeCounter + 1,
          saveState: s.saveState === "conflict" ? "conflict" : "dirty",
          ...keepSelectionValid(next),
        });
      },

      beginDrag: () => set({ dragStart: get().graph }),

      moveNodes: (positions) => {
        const g = structuredClone(get().graph);
        let changed = false;
        for (const n of g.nodes) {
          const p = positions[n.id];
          if (p) {
            n.position = p;
            changed = true;
          }
        }
        for (const n of g.stickyNotes) {
          const p = positions[n.id];
          if (p) {
            n.position = p;
            changed = true;
          }
        }
        if (changed) set({ graph: g });
      },

      endDrag: () => {
        const s = get();
        if (!s.dragStart) return;
        const before = s.dragStart;
        set({ dragStart: null });
        if (JSON.stringify(before) !== JSON.stringify(s.graph)) commit(s.graph, before);
      },

      addNode: (type, req, fallback) => {
        const def = getDefinition(type);
        if (!def) return null;
        const s = get();
        const g = s.graph;
        const from = req?.from ? g.nodes.find((n) => n.id === req.from!.nodeId) : undefined;
        const label = uniqueLabel(
          g.nodes.map((n) => n.label),
          def.name,
        );
        const id = uniqueNodeId(
          [...g.nodes.map((n) => n.id), ...g.stickyNotes.map((n) => n.id)],
          label,
        );
        const position = req?.position ?? (from && req?.from ? nextPosition(from, req.from.handle, g.orientation) : fallback);
        const node: WorkflowNode = {
          id,
          type,
          typeVersion: def.version,
          label,
          parameters: defaultParameters(def),
          position,
          connections: {},
        };
        let connected = true;
        get().apply((draft) => {
          draft.nodes.push(node);
          if (from && req?.from && def.inputs[0]) {
            const edge = { source: from.id, sourceHandle: req.from.handle, target: id, targetHandle: def.inputs[0].id };
            const check = canConnect(draft, edge);
            if (check.ok) {
              const src = draft.nodes.find((n) => n.id === from.id)!;
              (src.connections[edge.sourceHandle] ??= []).push(
                edge.targetHandle === "main" ? { targetId: id } : { targetId: id, targetHandle: edge.targetHandle },
              );
            } else connected = false;
          }
        });
        set({ selectedNodeIds: [id], selectedEdgeIds: [], openNodeId: id, picker: null });
        if (!connected) set({ connectError: "Added the step, but it couldn't be connected there" });
        return id;
      },

      updateNode: (id, patch) => {
        get().apply(
          (g) => {
            const n = g.nodes.find((x) => x.id === id);
            if (!n) return;
            if (patch.label !== undefined) n.label = patch.label;
            if (patch.notes !== undefined) n.notes = patch.notes || undefined;
            if (patch.disabled !== undefined) n.disabled = patch.disabled || undefined;
            if (patch.onError !== undefined) n.onError = patch.onError;
          },
          { coalesce: `node:${id}:${Object.keys(patch).join(",")}` },
        );
      },

      setParameter: (id, name, value) => {
        get().apply(
          (g) => {
            const n = g.nodes.find((x) => x.id === id);
            if (!n) return;
            if (value === undefined) delete n.parameters[name];
            else n.parameters[name] = value;
            pruneDeadHandles(n);
          },
          { coalesce: `param:${id}:${name}` },
        );
      },

      connect: (e) => {
        const check = canConnect(get().graph, e);
        if (!check.ok) {
          set({ connectError: check.reason ?? "Can't connect those steps" });
          return false;
        }
        get().apply((g) => {
          const src = g.nodes.find((n) => n.id === e.source)!;
          (src.connections[e.sourceHandle] ??= []).push(
            e.targetHandle === "main" ? { targetId: e.target } : { targetId: e.target, targetHandle: e.targetHandle },
          );
        });
        return true;
      },

      deleteElements: (nodeIds, edgeIds) => {
        if (nodeIds.length === 0 && edgeIds.length === 0) return;
        const gone = new Set(nodeIds);
        get().apply((g) => {
          for (const id of edgeIds) {
            const e = parseEdgeId(id);
            if (e) removeEdge(g, e);
          }
          g.nodes = g.nodes.filter((n) => !gone.has(n.id));
          g.stickyNotes = g.stickyNotes.filter((n) => !gone.has(n.id));
          for (const n of g.nodes) {
            for (const [h, list] of Object.entries(n.connections)) {
              const next = list.filter((t) => !gone.has(t.targetId));
              if (next.length) n.connections[h] = next;
              else delete n.connections[h];
            }
          }
        });
        set(keepSelectionValid(get().graph));
      },

      copyPayload: (ids) => {
        const g = get().graph;
        const set_ = new Set(ids);
        const nodes = g.nodes.filter((n) => set_.has(n.id));
        const stickyNotes = g.stickyNotes.filter((n) => set_.has(n.id));
        if (!nodes.length && !stickyNotes.length) return null;
        return { kind: PASTE_MIME, nodes: structuredClone(nodes), stickyNotes: structuredClone(stickyNotes) };
      },

      paste: (payload, at) => {
        const g = get().graph;
        const taken = new Set([...g.nodes.map((n) => n.id), ...g.stickyNotes.map((n) => n.id)]);
        const labels = g.nodes.map((n) => n.label);
        const all = [...payload.nodes.map((n) => n.position), ...payload.stickyNotes.map((n) => n.position)];
        const minX = Math.min(...all.map((p) => p.x));
        const minY = Math.min(...all.map((p) => p.y));
        const offset = at ? { x: at.x - minX, y: at.y - minY } : { x: 48, y: 48 };
        const idMap = new Map<string, string>();
        const newNodes: WorkflowNode[] = [];
        for (const n of payload.nodes) {
          if (!getDefinition(n.type)) continue;
          const label = uniqueLabel(labels, n.label);
          labels.push(label);
          const id = uniqueNodeId(taken, label);
          taken.add(id);
          idMap.set(n.id, id);
          newNodes.push({ ...structuredClone(n), id, label, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } });
        }
        for (const n of newNodes) {
          const conns: WorkflowNode["connections"] = {};
          for (const [h, list] of Object.entries(n.connections)) {
            const kept = list.filter((t) => idMap.has(t.targetId)).map((t) => ({ ...t, targetId: idMap.get(t.targetId)! }));
            if (kept.length) conns[h] = kept;
          }
          n.connections = conns;
        }
        const newNotes = payload.stickyNotes.map((s) => {
          const id = `note-${shortId()}`;
          idMap.set(s.id, id);
          return { ...structuredClone(s), id, position: { x: s.position.x + offset.x, y: s.position.y + offset.y } };
        });
        if (!newNodes.length && !newNotes.length) return;
        get().apply((d) => {
          d.nodes.push(...newNodes);
          d.stickyNotes.push(...newNotes);
        });
        set({ selectedNodeIds: [...idMap.values()], selectedEdgeIds: [] });
      },

      duplicateNodes: (ids) => {
        const payload = get().copyPayload(ids);
        if (payload) get().paste(payload);
      },

      addSticky: (at) => {
        const id = `note-${shortId()}`;
        get().apply((g) => {
          g.stickyNotes.push({ id, text: "", position: at, size: { width: 240, height: 140 }, color: "amber" });
        });
        set({ selectedNodeIds: [id], selectedEdgeIds: [] });
      },

      updateSticky: (id, patch) => {
        get().apply(
          (g) => {
            const n = g.stickyNotes.find((x) => x.id === id);
            if (!n) return;
            Object.assign(n, patch);
          },
          { coalesce: `sticky:${id}:${Object.keys(patch).join(",")}` },
        );
      },

      setOrientation: (o, positions) => {
        get().apply((g) => {
          g.orientation = o;
          if (positions) for (const n of g.nodes) if (positions[n.id]) n.position = positions[n.id]!;
        });
      },

      applyLayout: (positions) => {
        get().apply((g) => {
          for (const n of g.nodes) if (positions[n.id]) n.position = positions[n.id]!;
        });
      },

      setSelection: (nodeIds, edgeIds) => set({ selectedNodeIds: nodeIds, selectedEdgeIds: edgeIds }),
      openNode: (id) => set({ openNodeId: id, panelTab: "parameters" }),
      openPicker: (req) => set({ picker: req }),
      clearConnectError: () => set({ connectError: null }),

      markSaving: () => set({ saveState: "saving", saveMessage: null }),
      markSaved: (revision, counter) =>
        set((s) => ({
          revision,
          savedCounter: counter,
          saveState: s.changeCounter > counter ? "dirty" : "saved",
          saveMessage: null,
        })),
      markSaveFailed: (state, message) => set({ saveState: state, saveMessage: message }),
      resetFromServer: (w) =>
        set({
          graph: w.draft,
          revision: w.revision,
          past: [],
          future: [],
          changeCounter: 0,
          savedCounter: 0,
          saveState: "saved",
          saveMessage: null,
          selectedNodeIds: [],
          selectedEdgeIds: [],
          openNodeId: null,
        }),
      adoptServerRevision: (revision) =>
        set((s) => ({ revision, saveState: "dirty", saveMessage: null, changeCounter: s.changeCounter + 1 })),

      setPublishedRevision: (rev) => set({ publishedRevision: rev }),
      setRun: (run) => set({ run }),
      patchRun: (patch) => set((s) => (s.run ? { run: { ...s.run, ...patch } } : {})),
      addRunStep: (step) =>
        set((s) =>
          s.run && !s.run.steps.some((x) => x.index === step.index) ? { run: { ...s.run, steps: [...s.run.steps, step] } } : {},
        ),
      openNodeTab: (id, tab) => set({ openNodeId: id, panelTab: tab, selectedNodeIds: [id], selectedEdgeIds: [] }),
      setBuilderOpen: (open) => set({ builderOpen: open }),
      applyBuilderResult: (graph, revision, summary) => {
        const s = get();
        const counter = s.changeCounter + 1;
        const ids = new Set(graph.nodes.map((n) => n.id));
        set({
          graph,
          past: [...s.past, s.graph].slice(-HISTORY_LIMIT),
          future: [],
          coalesceKey: null,
          // Already saved by the server at `revision`; nothing for autosave to do.
          changeCounter: counter,
          savedCounter: counter,
          revision,
          saveState: "saved",
          saveMessage: null,
          highlight: { added: summary.added, updated: summary.updated, at: Date.now() },
          selectedNodeIds: s.selectedNodeIds.filter((id) => ids.has(id)),
          selectedEdgeIds: [],
          openNodeId: s.openNodeId && ids.has(s.openNodeId) ? s.openNodeId : null,
        });
      },
      clearHighlight: () => set({ highlight: null }),
    };
  });
}

export function isClipboardPayload(v: unknown): v is ClipboardPayload {
  return Boolean(v && typeof v === "object" && (v as { kind?: unknown }).kind === PASTE_MIME);
}
