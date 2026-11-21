"use client";

import { FINAL_STATUSES, type StepSummary } from "@conduit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, CheckCircle2Icon, HourglassIcon, Loader2Icon, RotateCcwIcon, SquareIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { JsonView } from "@/components/runs/json-view";
import { formatDuration, MODE_LABELS, RunStatus } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ClientApiError, errorMessage } from "@/lib/api-client";

function StepRow({ step }: { step: StepSummary }) {
  const out = Object.values(step.outputCounts).reduce((a, b) => a + b, 0);
  return (
    <li>
      <details className="group rounded-lg border bg-card" open={step.status === "failed"}>
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
          {step.status === "success" ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-label="Succeeded" />
          ) : step.status === "failed" ? (
            <XCircleIcon className="size-4 shrink-0 text-destructive" aria-label="Failed" />
          ) : (
            <HourglassIcon className="size-4 shrink-0 text-warning" aria-label="Waiting" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{step.label}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {step.inputCount} in → {out} out
          </span>
          <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">{formatDuration(step.durationMs)}</span>
        </summary>
        <div className="grid gap-3 border-t px-4 py-3 text-sm">
          {step.error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">{step.error}</p>}
          {step.logs.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px]">{step.logs.join("\n")}</pre>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">Input</p>
              <JsonView value={step.input.map((i) => i.json)} label={`${step.label} input`} />
            </div>
            <div className="grid content-start gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">Output</p>
              <JsonView
                value={Object.keys(step.output).length === 1 && step.output.main ? step.output.main.map((i) => i.json) : Object.fromEntries(Object.entries(step.output).map(([h, v]) => [h, v.map((i) => i.json)]))}
                label={`${step.label} output`}
              />
            </div>
          </div>
          {step.truncated && <p className="text-xs text-muted-foreground">Large data was shortened in this log.</p>}
        </div>
      </details>
    </li>
  );
}

export function ExecutionDetailView({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["execution", id],
    queryFn: () => api.getExecution(id),
    refetchInterval: (query) => (query.state.data && !FINAL_STATUSES.includes(query.state.data.status) ? 1500 : false),
    retry: (count, err) => !(err instanceof ClientApiError && err.status === 404) && count < 1,
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelExecution(id),
    onSuccess: () => {
      toast.success("Run canceled");
      void qc.invalidateQueries({ queryKey: ["execution", id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: () => api.retryExecution(id),
    onSuccess: ({ executionId }) => {
      toast.success("Started a new run");
      router.push(`/app/executions/${executionId}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isPending) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3 px-4 py-8 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (q.isError) {
    const notFound = q.error instanceof ClientApiError && q.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-16 text-center sm:px-6">
        <p className="font-medium">{notFound ? "Run not found" : "Couldn't load this run"}</p>
        <p className="mt-1 text-sm text-muted-foreground">{notFound ? "It may have expired; logs are kept for 7 days." : errorMessage(q.error)}</p>
        <Button className="mt-4" variant="outline" nativeButton={false} render={<Link href="/app/executions" />}>
          Back to runs
        </Button>
      </div>
    );
  }

  const e = q.data;
  const active = !FINAL_STATUSES.includes(e.status);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <Link href="/app/executions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" /> Runs
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{e.workflowName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <RunStatus status={e.status} />
            <span className="rounded-full border px-2 py-0.5 text-xs">{MODE_LABELS[e.mode]}</span>
            <span>Started {new Date(e.startedAt).toLocaleString()}</span>
            <span>{formatDuration(e.durationMs)}</span>
            {e.status === "waiting" && e.resumeAt && <span>Resumes {new Date(e.resumeAt).toLocaleString()}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href={`/app/workflows/${e.workflowId}`} />}>
            Open workflow
          </Button>
          {active ? (
            <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2Icon className="animate-spin" /> : <SquareIcon data-icon="inline-start" />} Cancel run
            </Button>
          ) : (
            <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon data-icon="inline-start" />} Run again
            </Button>
          )}
        </div>
      </div>

      {e.error && e.status === "failed" && (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {e.error.message}
        </p>
      )}
      {e.response && (
        <div className="mt-6 grid gap-1.5">
          <p className="text-sm font-medium">Webhook response · {e.response.status}</p>
          <JsonView value={e.response.body} label="Webhook response" />
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-medium">Steps</h2>
      {e.steps.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {active ? "Waiting for the first step…" : "No steps were recorded."}
        </p>
      ) : (
        <ol aria-label="Steps" className="grid gap-2">
          {e.steps.map((s) => (
            <StepRow key={s.index} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}
