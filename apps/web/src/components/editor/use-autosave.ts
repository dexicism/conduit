"use client";

import type { SaveDraftResult, WorkflowDetail } from "@conduit/core";
import { useCallback, useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { EditorState } from "./store";

const DEBOUNCE_MS = 700;
const RETRY_MS = 4000;

/**
 * Persists the draft after edits settle. One request at a time; edits made while a
 * save is in flight are picked up by the next save. A 409 stops autosave until the
 * user resolves the conflict.
 */
export function useAutosave(store: StoreApi<EditorState>, getViewport: () => WorkflowDetail["draft"]["viewport"]) {
  const changeCounter = useStore(store, (s) => s.changeCounter);
  const saveState = useStore(store, (s) => s.saveState);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow-up saves are scheduled through this ref so they always call the latest `save`.
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), ms);
  }, []);

  const save = useCallback(async () => {
    const s = store.getState();
    if (inFlight.current || s.saveState === "conflict") return;
    if (s.changeCounter === s.savedCounter) return;
    inFlight.current = true;
    const counter = s.changeCounter;
    s.markSaving();
    try {
      const res = await fetch(`/api/workflows/${s.workflowId}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: s.revision, graph: { ...s.graph, viewport: getViewport() } }),
      });
      if (res.ok) {
        const data = (await res.json()) as SaveDraftResult;
        store.getState().markSaved(data.revision, counter);
      } else if (res.status === 409) {
        store.getState().markSaveFailed("conflict", "This workflow was changed in another tab or by someone else.");
      } else if (res.status === 401) {
        store.getState().markSaveFailed("error", "Your session expired. Sign in again to keep saving.");
      } else {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        store.getState().markSaveFailed("error", body?.message ?? `Save failed (${res.status})`);
      }
    } catch {
      store.getState().markSaveFailed("offline", "You're offline. Changes will save when the connection returns.");
    } finally {
      inFlight.current = false;
    }
    const after = store.getState();
    if (after.saveState === "dirty" && after.changeCounter > after.savedCounter) schedule(DEBOUNCE_MS);
    else if (after.saveState === "offline") schedule(RETRY_MS);
  }, [store, getViewport, schedule]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (changeCounter === 0) return;
    schedule(DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [changeCounter, schedule]);

  useEffect(() => {
    const online = () => {
      if (store.getState().saveState === "offline") void save();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [save, store]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const s = store.getState();
      if (s.changeCounter !== s.savedCounter) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [store]);

  return { saveNow: save, saveState };
}
