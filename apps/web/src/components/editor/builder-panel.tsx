"use client";

import { ChevronDownIcon, EraserIcon, Loader2Icon, SendHorizontalIcon, SparklesIcon, Undo2Icon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEditor, useEditorStoreApi } from "./context";
import type { WorkflowGraph } from "@conduit/core";

interface Msg {
  role: "user" | "assistant";
  text: string;
  at: string;
  summary?: { added: string[]; updated: string[]; deleted: string[] };
  steps?: string[];
  error?: boolean;
}

const EXAMPLES = [
  "When a webhook receives a support message, classify it as billing, bug or other and reply with a short answer",
  "Every morning at 9, call our status API and email a summary if anything is down",
  "Add an AI agent that answers questions with a calculator tool",
];

function summaryText(s: NonNullable<Msg["summary"]>): string {
  const parts = [s.added.length && `${s.added.length} added`, s.updated.length && `${s.updated.length} changed`, s.deleted.length && `${s.deleted.length} removed`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No changes";
}

export function BuilderPanel({ flush }: { flush: () => Promise<number | null> }) {
  const store = useEditorStoreApi();
  const open = useEditor((s) => s.builderOpen);
  const provider = useEditor((s) => s.ai.provider);
  const workflowId = useEditor((s) => s.workflowId);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [undoable, setUndoable] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || messages !== null) return;
    let alive = true;
    fetch(`/api/workflows/${workflowId}/builder`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages: Msg[] }) => alive && setMessages(d.messages))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [open, messages, workflowId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setDraft("");
    setMessages((m) => [...(m ?? []), { role: "user", text: message, at: new Date().toISOString() }]);
    try {
      const revision = await flush();
      if (revision === null) throw new Error("Save your latest changes first (see the message above the canvas).");
      const res = await fetch(`/api/workflows/${workflowId}/builder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, expectedRevision: revision }),
      });
      const body = (await res.json().catch(() => null)) as
        | { message: Msg; steps: string[]; applied: { graph: WorkflowGraph; summary: Msg["summary"] & object; revision: number } | null; message_?: string }
        | { message?: string; error?: string }
        | null;
      if (!res.ok || !body || typeof body.message !== "object") {
        throw new Error((body as { message?: string } | null)?.message ?? `Request failed (${res.status})`);
      }
      const ok = body as { message: Msg; steps: string[]; applied: { graph: WorkflowGraph; summary: Msg["summary"] & object; revision: number } | null };
      if (ok.applied) {
        store.getState().applyBuilderResult(ok.applied.graph, ok.applied.revision, ok.applied.summary);
      }
      setMessages((m) => {
        const next = [...(m ?? []), { ...ok.message, steps: ok.steps }];
        setUndoable(ok.applied ? next.length - 1 : null);
        return next;
      });
    } catch (err) {
      setMessages((m) => [...(m ?? []), { role: "assistant", text: (err as Error).message, at: new Date().toISOString(), error: true }]);
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    const res = await fetch(`/api/workflows/${workflowId}/builder`, { method: "DELETE" });
    if (res.ok) {
      setMessages([]);
      setUndoable(null);
    } else toast.error("Couldn't clear the conversation");
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="builder"
          aria-label="Build with AI"
          initial={{ x: -24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -24, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="absolute inset-0 z-20 flex flex-col border-r bg-background sm:static sm:z-auto sm:w-[380px] sm:shrink-0"
        >
          <header className="flex items-center gap-2 border-b px-4 py-3">
            <SparklesIcon className="size-4 text-violet-500" />
            <h2 className="text-sm font-medium">Build with AI</h2>
            {provider === "fake" && (
              <span className="rounded-full border border-dashed px-2 py-0.5 text-[10px] text-muted-foreground" title="AI_PROVIDER=fake: rule-based answers for testing">
                test model
              </span>
            )}
            {provider === "ollama" && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground" title="AI_PROVIDER=ollama: a free model running on this computer. Slower, and less reliable than Claude at building workflows.">
                local model
              </span>
            )}
            <div className="ml-auto flex gap-1">
              {!!messages?.length && (
                <Button variant="ghost" size="icon-sm" aria-label="Clear conversation" onClick={() => void clear()} disabled={pending}>
                  <EraserIcon />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Close builder" onClick={() => store.getState().setBuilderOpen(false)}>
                <XIcon />
              </Button>
            </div>
          </header>

          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            {messages === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Loading…
              </p>
            ) : messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Describe what the workflow should do. The builder adds and connects steps on your canvas. You review and test before publishing.
                </p>
                {EXAMPLES.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setDraft(e)}
                    className="block w-full rounded-lg border p-3 text-left text-sm hover:bg-accent"
                  >
                    {e}
                  </button>
                ))}
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  <div
                    data-testid={m.role === "assistant" ? "builder-reply" : undefined}
                    className={cn(
                      "max-w-[88%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                      m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card",
                      m.error && "border-destructive/40 bg-destructive/10 text-destructive",
                    )}
                  >
                    {m.text}
                    {m.summary && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span data-testid="builder-summary">{summaryText(m.summary)}</span>
                        {undoable === i && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              store.getState().undo();
                              setUndoable(null);
                              toast.success("Builder changes undone");
                            }}
                          >
                            <Undo2Icon data-icon="inline-start" /> Undo
                          </Button>
                        )}
                      </div>
                    )}
                    {!!m.steps?.length && (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="flex cursor-pointer list-none items-center gap-1">
                          <ChevronDownIcon className="size-3" /> {m.steps.length} steps taken
                        </summary>
                        <ul className="mt-1 list-disc pl-4">
                          {m.steps.map((s, k) => (
                            <li key={k}>{s}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </div>
              ))
            )}
            {pending && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Building… this can take a minute.
              </p>
            )}
          </div>

          <form
            className="border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <div className="flex items-end gap-2">
              <Textarea
                aria-label="Message to the builder"
                rows={3}
                maxLength={4000}
                value={draft}
                placeholder="e.g. Add a step that emails me when the total is over 1000"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                disabled={pending}
              />
              <Button type="submit" size="icon" aria-label="Send" disabled={pending || !draft.trim()}>
                {pending ? <Loader2Icon className="animate-spin" /> : <SendHorizontalIcon />}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line. Changes are saved as a draft you can undo.</p>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
