"use client";

import { EXECUTION_STATUSES, type ExecutionStatus } from "@conduit/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { HistoryIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NativeSelect } from "@/components/editor/param-fields";
import { formatDuration, MODE_LABELS, RunStatus } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  success: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function ExecutionsView({ initialWorkflowId }: { initialWorkflowId?: string }) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState(initialWorkflowId ?? "");
  const [status, setStatus] = useState("");

  const workflows = useQuery({ queryKey: ["workflows", "picker"], queryFn: () => api.listWorkflows({ filter: "active", limit: 100 }) });
  const list = useInfiniteQuery({
    queryKey: ["executions", { workflowId, status }],
    queryFn: ({ pageParam }) => api.listExecutions({ workflowId: workflowId || undefined, status: status || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) => {
      const items = q.state.data?.pages.flatMap((p) => p.data) ?? [];
      return items.some((e) => e.status === "running" || e.status === "queued" || e.status === "waiting") ? 2000 : false;
    },
  });
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">Test and live runs of your workflows. Logs are kept for 7 days.</p>
        </div>
        <Button variant="outline" onClick={() => list.refetch()} disabled={list.isFetching}>
          <RefreshCwIcon data-icon="inline-start" className={list.isFetching ? "animate-spin" : undefined} /> Refresh
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <NativeSelect
          aria-label="Filter by workflow"
          className="h-9 sm:w-72"
          value={workflowId}
          onChange={(e) => {
            setWorkflowId(e.target.value);
            router.replace(e.target.value ? `/app/executions?workflowId=${e.target.value}` : "/app/executions");
          }}
        >
          <option value="">All workflows</option>
          {(workflows.data?.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {workflowId && !workflows.data?.data.some((w) => w.id === workflowId) && <option value={workflowId}>Selected workflow</option>}
        </NativeSelect>
        <NativeSelect aria-label="Filter by status" className="h-9 sm:w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {EXECUTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="mt-4">
        {list.isPending ? (
          <div className="grid gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : list.isError ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-8 text-center">
            <p className="font-medium">Couldn&apos;t load runs</p>
            <p className="mt-1 text-sm text-muted-foreground">{errorMessage(list.error)}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-12 text-center">
            <HistoryIcon className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 font-medium">No runs yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Test a workflow in the editor, or publish it to run on its triggers.</p>
          </div>
        ) : (
          <>
            <ul aria-label="Runs" className="divide-y overflow-hidden rounded-xl border bg-card">
              {items.map((e) => (
                <li key={e.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/40">
                  <RunStatus status={e.status} className="w-24" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/app/executions/${e.id}`} className="block truncate font-medium after:absolute after:inset-0">
                      {e.workflowName}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.error?.message ?? `Started ${relativeTime(e.startedAt)}`}
                    </p>
                  </div>
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{MODE_LABELS[e.mode]}</span>
                  <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">{formatDuration(e.durationMs)}</span>
                  <time className="hidden w-32 text-right text-xs text-muted-foreground sm:block" dateTime={e.startedAt}>
                    {new Date(e.startedAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage && <Loader2Icon className="animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
