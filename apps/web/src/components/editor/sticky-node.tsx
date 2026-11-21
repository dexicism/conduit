"use client";

import type { StickyNote } from "@conduit/core";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { useEditorStoreApi } from "./context";

export interface StickyNodeData extends Record<string, unknown> {
  note: StickyNote;
}
export type StickyFlowNode = Node<StickyNodeData, "sticky">;

const COLORS: Record<string, string> = {
  amber: "bg-amber-100/90 border-amber-300 text-amber-950 dark:bg-amber-400/15 dark:border-amber-400/30 dark:text-amber-50",
  sky: "bg-sky-100/90 border-sky-300 text-sky-950 dark:bg-sky-400/15 dark:border-sky-400/30 dark:text-sky-50",
  rose: "bg-rose-100/90 border-rose-300 text-rose-950 dark:bg-rose-400/15 dark:border-rose-400/30 dark:text-rose-50",
  emerald:
    "bg-emerald-100/90 border-emerald-300 text-emerald-950 dark:bg-emerald-400/15 dark:border-emerald-400/30 dark:text-emerald-50",
};
export const STICKY_COLORS = Object.keys(COLORS);

export const StickyNoteCard = memo(function StickyNoteCard({ data, selected }: NodeProps<StickyFlowNode>) {
  const store = useEditorStoreApi();
  const { note } = data;
  const [editing, setEditing] = useState(note.text === "");

  return (
    <div
      data-testid={`sticky-${note.id}`}
      className={cn(
        "relative h-full w-full rounded-lg border p-3 text-sm shadow-sm",
        COLORS[note.color ?? "amber"] ?? COLORS.amber,
        selected && "ring-2 ring-primary/40",
      )}
      style={{ width: note.size.width, height: note.size.height }}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={80}
        lineClassName="!border-primary/40"
        handleClassName="!size-2.5 !rounded-sm !border-primary !bg-background"
        onResizeEnd={(_e, p) =>
          store.getState().updateSticky(note.id, { size: { width: Math.round(p.width), height: Math.round(p.height) } })
        }
      />
      {selected && (
        <div className="nodrag absolute -top-8 left-0 flex gap-1 rounded-md border bg-popover p-1 shadow-sm">
          {STICKY_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={(note.color ?? "amber") === c}
              onClick={() => store.getState().updateSticky(note.id, { color: c })}
              className={cn("size-4 rounded-full border", COLORS[c], (note.color ?? "amber") === c && "ring-2 ring-primary")}
            />
          ))}
        </div>
      )}
      {editing ? (
        <textarea
          autoFocus
          aria-label="Note text"
          className="nodrag nowheel h-full w-full resize-none bg-transparent outline-none placeholder:opacity-60"
          placeholder="Write a note…"
          defaultValue={note.text}
          onChange={(e) => store.getState().updateSticky(note.id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      ) : (
        <p className="h-full overflow-hidden whitespace-pre-wrap">
          {note.text || <span className="opacity-60">Double-click to write a note</span>}
        </p>
      )}
    </div>
  );
});
