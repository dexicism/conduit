"use client";

import { createContext, useContext } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { EditorState } from "./store";

export const EditorStoreContext = createContext<StoreApi<EditorState> | null>(null);

export function useEditorStoreApi(): StoreApi<EditorState> {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditor must be used inside the workflow editor");
  return store;
}

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditorStoreApi(), selector);
}
