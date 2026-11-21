"use client";

import type { WorkflowDetail } from "@conduit/core";
import { Panel, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ZapIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Canvas, type MeasuredMap } from "./canvas";
import { ConfigPanel } from "./config-panel";
import { EditorStoreContext, useEditor, useEditorStoreApi } from "./context";
import { computeLayout } from "./layout";
import { NodePicker } from "./node-picker";
import { createEditorStore, type XY } from "./store";
import { EditorToolbar } from "./toolbar";
import { EditorTopBar, SaveProblemBanner } from "./top-bar";
import { RunPanel } from "./run-panel";
import { BuilderPanel } from "./builder-panel";
import { useAutosave } from "./use-autosave";
import { useRun } from "./use-run";
import { useEditorShortcuts } from "./use-shortcuts";
import type { AppInfo } from "@/lib/app-info";
import { AppsContext } from "./apps-context";

export function WorkflowEditor({
  initial,
  ai,
  apps,
}: {
  initial: WorkflowDetail;
  ai: { enabled: boolean; provider: string };
  /** Apps that can be connected on this server. Steps for other apps are hidden. */
  apps: AppInfo[];
}) {
  const [store] = useState(() => createEditorStore(initial, ai));
  return (
    <AppsContext.Provider value={apps}>
    <EditorStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <EditorInner initial={initial} />
      </ReactFlowProvider>
    </EditorStoreContext.Provider>
    </AppsContext.Provider>
  );
}

function EmptyCanvas() {
  const empty = useEditor((s) => s.graph.nodes.length === 0);
  const openPicker = useEditor((s) => s.openPicker);
  if (!empty) return null;
  return (
    <Panel position="center-left" className="!pointer-events-none !m-0 !inset-0 !flex !h-full !w-full items-center justify-center">
      <div className="pointer-events-auto max-w-xs rounded-xl border bg-card/95 p-6 text-center shadow-sm backdrop-blur">
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-signal/15 text-signal">
          <ZapIcon className="size-5" />
        </span>
        <p className="mt-3 font-medium">Start with a trigger</p>
        <p className="mt-1 text-sm text-muted-foreground">Choose what starts this workflow: a webhook, a schedule, or a manual run.</p>
        <Button className="mt-4" onClick={() => openPicker({ triggersOnly: true })}>
          Add a trigger
        </Button>
      </div>
    </Panel>
  );
}

function EditorInner({ initial }: { initial: WorkflowDetail }) {
  const store = useEditorStoreApi();
  const rf = useReactFlow();
  const measuredRef = useRef<MeasuredMap>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [minimap, setMinimap] = useState(false);

  const getViewport = useCallback(() => rf.getViewport(), [rf]);
  const { saveNow } = useAutosave(store, getViewport);
  const runner = useRun(store, saveNow);

  const centerPosition = useCallback((): XY => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const p = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    // Nudge repeated additions so they don't stack exactly.
    const jitter = (store.getState().graph.nodes.length % 5) * 24;
    return { x: Math.round(p.x - 100 + jitter), y: Math.round(p.y - 36 + jitter) };
  }, [rf, store]);

  const pointerPosition = useCallback((): XY | undefined => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const p = pointer.current;
    if (!rect || !p || p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom) return undefined;
    const f = rf.screenToFlowPosition(p);
    return { x: Math.round(f.x), y: Math.round(f.y) };
  }, [rf]);

  useEditorShortcuts(store, pointerPosition);

  const tidy = useCallback(async () => {
    const s = store.getState();
    try {
      const positions = await computeLayout(s.graph, s.graph.orientation, measuredRef.current);
      store.getState().applyLayout(positions);
      requestAnimationFrame(() => rf.fitView({ duration: 300, padding: 0.25, maxZoom: 1 }));
    } catch {
      toast.error("Couldn't arrange the layout");
    }
  }, [rf, store]);

  const toggleOrientation = useCallback(async () => {
    const s = store.getState();
    const next = s.graph.orientation === "horizontal" ? "vertical" : "horizontal";
    try {
      const positions = await computeLayout(s.graph, next, measuredRef.current);
      store.getState().setOrientation(next, positions);
    } catch {
      store.getState().setOrientation(next);
    }
    requestAnimationFrame(() => rf.fitView({ duration: 300, padding: 0.25, maxZoom: 1 }));
  }, [rf, store]);

  return (
    <div className="flex h-dvh flex-col">
      <EditorTopBar
        initial={{ id: initial.id, name: initial.name, description: initial.description, status: initial.status, settings: initial.settings }}
        onStartTest={(nodeId, isWebhook) => void runner.start(nodeId, isWebhook)}
        flush={runner.flush}
      />
      <SaveProblemBanner onRetry={() => void saveNow()} />
      {/* Canvas and config panel sit side by side on desktop so the panel never hides steps. */}
      <div className="relative flex min-h-0 flex-1">
        <BuilderPanel flush={runner.flush} />
        <div
          ref={wrapperRef}
          className="relative min-w-0 flex-1"
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
          }}
        >
          <Canvas measuredRef={measuredRef} showMinimap={minimap}>
            <EditorToolbar
              onTidy={() => void tidy()}
              onToggleOrientation={() => void toggleOrientation()}
              minimap={minimap}
              onToggleMinimap={() => setMinimap((m) => !m)}
              centerPosition={centerPosition}
            />
            <EmptyCanvas />
          </Canvas>
          <RunPanel
            onCancel={() => void runner.cancel()}
            onStopListening={() => void runner.stopListening()}
            onClose={runner.close}
          />
        </div>
        <ConfigPanel />
      </div>
      <NodePicker fallbackPosition={centerPosition} />
    </div>
  );
}
