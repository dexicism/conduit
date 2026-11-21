"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { XIcon } from "lucide-react";
import { useEditorStoreApi } from "./context";

/** Bezier edge with a delete button while selected. */
export function DeletableEdge(props: EdgeProps) {
  const store = useEditorStoreApi();
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          strokeWidth: props.selected ? 2.5 : 1.75,
          stroke: props.selected
            ? "var(--primary)"
            : props.data?.tool
              ? "color-mix(in oklch, oklch(0.6 0.2 300) 70%, transparent)"
              : "color-mix(in oklch, var(--foreground) 35%, transparent)",
          strokeDasharray: props.data?.tool ? "5 4" : undefined,
        }}
        interactionWidth={18}
      />
      {props.selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete connection"
            className="nodrag nopan pointer-events-auto absolute flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-destructive"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => store.getState().deleteElements([], [props.id])}
          >
            <XIcon className="size-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
