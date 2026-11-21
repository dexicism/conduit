"use client";

import { CheckCircle2Icon, CopyIcon, ExternalLinkIcon, HourglassIcon, Loader2Icon, RadioIcon, XCircleIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDuration, RunStatus } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditor, useEditorStoreApi } from "./context";

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return <span>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</span>;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy. Select the text and copy it manually.");
  }
}

export function RunPanel({ onCancel, onStopListening, onClose }: { onCancel: () => void; onStopListening: () => void; onClose: () => void }) {
  const store = useEditorStoreApi();
  const run = useEditor((s) => s.run);
  if (!run) return null;

  const status = run.summary?.status;
  const active = status === "queued" || status === "running" || status === "waiting";
  const curl = run.listening
    ? `curl -X ${run.listening.method} "${run.listening.testUrl}" -H "content-type: application/json" -d '{"hello":"world"}'`
    : "";

  return (
    <section
      aria-label="Test run"
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[45%] flex-col border-t bg-background/95 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.3)] backdrop-blur"
    >
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <span className="text-sm font-medium">Test run</span>
        {run.phase === "saving" && <span className="text-xs text-muted-foreground">Saving changes…</span>}
        {run.phase === "starting" && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Starting…
          </span>
        )}
        {run.phase === "listening" && (
          <span className="flex items-center gap-1 text-xs font-medium text-primary">
            <RadioIcon className="size-3.5 animate-pulse" /> Listening for a request
          </span>
        )}
        {status && <RunStatus status={status} />}
        {run.summary?.durationMs != null && <span className="text-xs text-muted-foreground">{formatDuration(run.summary.durationMs)}</span>}
        {run.summary?.status === "waiting" && run.summary.resumeAt && (
          <span className="text-xs text-muted-foreground">resumes {new Date(run.summary.resumeAt).toLocaleTimeString()}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {run.executionId && (
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/app/executions/${run.executionId}`} target="_blank" />}>
              <ExternalLinkIcon data-icon="inline-start" /> Open run
            </Button>
          )}
          {active && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel run
            </Button>
          )}
          {run.phase === "listening" && (
            <Button variant="outline" size="sm" onClick={onStopListening}>
              Stop listening
            </Button>
          )}
          {!active && run.phase !== "listening" && (
            <Button variant="ghost" size="icon-sm" aria-label="Close test run" onClick={onClose}>
              <XIcon />
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {run.error && (
          <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {run.error}
          </p>
        )}
        {run.listening && (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">
              Send a <span className="font-mono">{run.listening.method}</span> request to this test URL. The first request runs the
              workflow once. Stops in <Countdown until={run.listening.expiresAt} />.
            </p>
            <div className="flex items-center gap-2">
              <code data-testid="test-url" className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
                {run.listening.testUrl}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy(run.listening!.testUrl, "Test URL")}>
                <CopyIcon data-icon="inline-start" /> Copy URL
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{curl}</code>
              <Button variant="outline" size="sm" onClick={() => copy(curl, "curl command")}>
                <CopyIcon data-icon="inline-start" /> Copy curl
              </Button>
            </div>
          </div>
        )}
        {run.summary?.error && run.summary.status === "failed" && (
          <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{run.summary.error.message}</p>
        )}
        {run.steps.length > 0 && (
          <ol aria-label="Steps" className="grid gap-1">
            {run.steps.map((s) => {
              const out = Object.values(s.outputCounts).reduce((a, b) => a + b, 0);
              return (
                <li key={s.index}>
                  <button
                    type="button"
                    onClick={() => store.getState().openNodeTab(s.nodeId, "output")}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    {s.status === "success" ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-label="Succeeded" />
                    ) : s.status === "failed" ? (
                      <XCircleIcon className="size-4 shrink-0 text-destructive" aria-label="Failed" />
                    ) : (
                      <HourglassIcon className="size-4 shrink-0 text-warning" aria-label="Waiting" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                    <span className={cn("shrink-0 text-xs text-muted-foreground", s.error && "max-w-[50%] truncate text-destructive")}>
                      {s.error ?? `${s.inputCount} in → ${out} out`}
                    </span>
                    <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{formatDuration(s.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {run.phase === "running" && run.steps.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Waiting for the first step…
          </p>
        )}
      </div>
    </section>
  );
}
