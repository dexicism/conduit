"use client";

import { FINAL_STATUSES, type ExecutionSummary, type StepSummary } from "@conduit/core";
import { useCallback, useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { EditorState } from "./store";

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `Request failed (${res.status})`;
}

/**
 * Test runs from the editor: flushes autosave, starts the run (or arms a webhook
 * test URL), then streams steps over SSE into the store.
 */
export function useRun(store: StoreApi<EditorState>, saveNow: () => Promise<void>) {
  const source = useRef<EventSource | null>(null);
  const listenTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopStreams = useCallback(() => {
    source.current?.close();
    source.current = null;
    if (listenTimer.current) clearInterval(listenTimer.current);
    listenTimer.current = null;
  }, []);

  useEffect(() => stopStreams, [stopStreams]);

  const follow = useCallback(
    (executionId: string) => {
      stopStreams();
      store.getState().patchRun({ executionId, phase: "running", listening: null });
      const es = new EventSource(`/api/executions/${executionId}/stream`);
      source.current = es;
      es.addEventListener("step", (e) => store.getState().addRunStep(JSON.parse((e as MessageEvent).data) as StepSummary));
      es.addEventListener("status", (e) => {
        const summary = JSON.parse((e as MessageEvent).data) as ExecutionSummary;
        store.getState().patchRun({ summary });
        if (FINAL_STATUSES.includes(summary.status)) {
          store.getState().patchRun({ phase: "done" });
          es.close();
        }
      });
      es.addEventListener("error", () => {
        // EventSource reconnects on its own while the run continues; a closed stream after "done" is expected.
        const run = store.getState().run;
        if (run?.phase === "done") es.close();
      });
    },
    [store, stopStreams],
  );

  /** Waits for autosave to persist every edit so the server runs exactly what is on screen. */
  const flush = useCallback(async (): Promise<number | null> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const s = store.getState();
      if (s.saveState === "conflict" || s.saveState === "error") return null;
      if (s.changeCounter === s.savedCounter && s.saveState === "saved") return s.revision;
      if (Date.now() > deadline) return null;
      if (s.saveState !== "saving") await saveNow();
      await new Promise((r) => setTimeout(r, 100));
    }
  }, [store, saveNow]);

  const start = useCallback(
    async (triggerNodeId: string, isWebhook: boolean) => {
      stopStreams();
      const s = store.getState();
      s.setRun({ executionId: null, summary: null, steps: [], listening: null, phase: "saving", error: null });
      const revision = await flush();
      if (revision === null) {
        store.getState().patchRun({ phase: "done", error: "Save your changes before running (see the message above)." });
        return;
      }
      store.getState().patchRun({ phase: "starting" });
      const id = s.workflowId;
      if (!isWebhook) {
        const res = await fetch(`/api/workflows/${id}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ triggerNodeId, expectedRevision: revision }),
        });
        if (!res.ok) {
          store.getState().patchRun({ phase: "done", error: await readError(res) });
          return;
        }
        const { executionId } = (await res.json()) as { executionId: string };
        follow(executionId);
        return;
      }
      const res = await fetch(`/api/workflows/${id}/test/listen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ triggerNodeId }),
      });
      if (!res.ok) {
        store.getState().patchRun({ phase: "done", error: await readError(res) });
        return;
      }
      const l = (await res.json()) as { testUrl: string; method: string; expiresAt: string };
      store.getState().patchRun({ phase: "listening", listening: { ...l, nodeId: triggerNodeId } });
      listenTimer.current = setInterval(async () => {
        const run = store.getState().run;
        if (!run?.listening) return stopStreams();
        if (new Date(run.listening.expiresAt).getTime() < Date.now()) {
          stopStreams();
          store.getState().patchRun({ phase: "done", listening: null, error: "Stopped listening: no request arrived within 2 minutes." });
          return;
        }
        const st = await fetch(`/api/workflows/${id}/test/listen`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (st?.executionId) follow(st.executionId as string);
      }, 1000);
    },
    [store, flush, follow, stopStreams],
  );

  const stopListening = useCallback(async () => {
    stopStreams();
    const s = store.getState();
    await fetch(`/api/workflows/${s.workflowId}/test/listen`, { method: "DELETE" }).catch(() => undefined);
    s.setRun(null);
  }, [store, stopStreams]);

  const cancel = useCallback(async () => {
    const run = store.getState().run;
    if (!run?.executionId) return;
    const res = await fetch(`/api/executions/${run.executionId}/cancel`, { method: "POST" });
    if (res.ok) store.getState().patchRun({ summary: (await res.json()) as ExecutionSummary, phase: "done" });
    stopStreams();
  }, [store, stopStreams]);

  const close = useCallback(() => {
    stopStreams();
    store.getState().setRun(null);
  }, [store, stopStreams]);

  return { start, stopListening, cancel, close, flush };
}
