"use client";

import { Panel, useReactFlow } from "@xyflow/react";
import {
  ArrowDownUpIcon,
  ArrowRightLeftIcon,
  LayoutGridIcon,
  MapIcon,
  MaximizeIcon,
  PlusIcon,
  Redo2Icon,
  StickyNoteIcon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditor, useEditorStoreApi } from "./context";
import type { XY } from "./store";

function ToolButton({
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(pressed && "bg-accent text-accent-foreground")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function EditorToolbar({
  onTidy,
  onToggleOrientation,
  minimap,
  onToggleMinimap,
  centerPosition,
}: {
  onTidy: () => void;
  onToggleOrientation: () => void;
  minimap: boolean;
  onToggleMinimap: () => void;
  centerPosition: () => XY;
}) {
  const store = useEditorStoreApi();
  const rf = useReactFlow();
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const orientation = useEditor((s) => s.graph.orientation);
  const hasNodes = useEditor((s) => s.graph.nodes.length > 0);

  return (
    <Panel position="bottom-center" className="!mb-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-0.5 rounded-xl border bg-card/95 p-1 shadow-sm backdrop-blur">
      <ToolButton label="Add step" shortcut="Tab" onClick={() => store.getState().openPicker(hasNodes ? {} : { triggersOnly: true })}>
        <PlusIcon />
      </ToolButton>
      <ToolButton label="Add note" onClick={() => store.getState().addSticky(centerPosition())}>
        <StickyNoteIcon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => store.getState().undo()}>
        <Undo2Icon />
      </ToolButton>
      <ToolButton label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => store.getState().redo()}>
        <Redo2Icon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton label="Zoom out" onClick={() => rf.zoomOut({ duration: 150 })}>
        <ZoomOutIcon />
      </ToolButton>
      <ToolButton label="Zoom in" onClick={() => rf.zoomIn({ duration: 150 })}>
        <ZoomInIcon />
      </ToolButton>
      <ToolButton label="Fit to screen" shortcut="Shift+1" onClick={() => rf.fitView({ duration: 250, padding: 0.25, maxZoom: 1 })}>
        <MaximizeIcon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton label="Tidy up layout" disabled={!hasNodes} onClick={onTidy}>
        <LayoutGridIcon />
      </ToolButton>
      <ToolButton
        label={orientation === "horizontal" ? "Switch to vertical layout" : "Switch to horizontal layout"}
        onClick={onToggleOrientation}
      >
        {orientation === "horizontal" ? <ArrowDownUpIcon /> : <ArrowRightLeftIcon />}
      </ToolButton>
      <ToolButton label={minimap ? "Hide minimap" : "Show minimap"} pressed={minimap} onClick={onToggleMinimap}>
        <MapIcon />
      </ToolButton>
    </Panel>
  );
}
