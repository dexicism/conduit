"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { toast } from "sonner";
import type { StoreApi } from "zustand/vanilla";
import { isClipboardPayload, type EditorState, type XY } from "./store";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function inOverlay(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]"));
}

/** Editor keyboard shortcuts plus system copy/paste of steps. */
export function useEditorShortcuts(store: StoreApi<EditorState>, pointerPosition: () => XY | undefined) {
  const rf = useReactFlow();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || inOverlay(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const s = store.getState();
      const key = e.key.toLowerCase();
      if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && ((key === "z" && e.shiftKey) || key === "y")) {
        e.preventDefault();
        s.redo();
      } else if (mod && key === "d") {
        e.preventDefault();
        if (s.selectedNodeIds.length) s.duplicateNodes(s.selectedNodeIds);
      } else if (mod && key === "a") {
        e.preventDefault();
        s.setSelection([...s.graph.nodes.map((n) => n.id), ...s.graph.stickyNotes.map((n) => n.id)], []);
      } else if (e.key === "Tab" && !mod && !e.shiftKey) {
        e.preventDefault();
        s.openPicker(s.graph.nodes.length ? {} : { triggersOnly: true });
      } else if (e.key === "Escape") {
        if (s.openNodeId) s.openNode(null);
        else s.setSelection([], []);
      } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) {
        rf.fitView({ duration: 250, padding: 0.25, maxZoom: 1 });
      }
    };

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (isTyping(e.target) || inOverlay(e.target)) return;
      const s = store.getState();
      if (!s.selectedNodeIds.length) return;
      const payload = s.copyPayload(s.selectedNodeIds);
      if (!payload || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", JSON.stringify(payload));
      if (cut) s.deleteElements(s.selectedNodeIds, []);
      toast.success(`${cut ? "Cut" : "Copied"} ${payload.nodes.length + payload.stickyNotes.length} item(s)`);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || inOverlay(e.target)) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      if (!isClipboardPayload(data)) return;
      e.preventDefault();
      store.getState().paste(data, pointerPosition());
    };

    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", onPaste);
    };
  }, [store, rf, pointerPosition]);
}
