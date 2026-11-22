"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CalendarClockIcon, CheckCircle2Icon, LayoutTemplateIcon, PlugIcon, RadioIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatDuration, RunStatus } from "@/components/runs/run-status";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type HomeOverview } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HomeView() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.overview(), refetchInterval: 15_000 });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <p className="mt-1 text-sm text-muted-foreground">How your live workflows did over the last 7 days. Test runs from the editor aren&apos;t counted.</p>
        </div>
        <Link href="/app/workflows?templates=1" className={buttonVariants({ variant: "outline" })}>
          <LayoutTemplateIcon data-icon="inline-start" /> Start from a template
        </Link>
      </div>

      {q.isPending ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
          <Skeleton className="h-56 sm:col-span-4" />
        </div>
      ) : q.isError ? (
        <p className="mt-6 text-sm text-destructive">{errorMessage(q.error)}</p>
      ) : (
        <Overview data={q.data} />
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Overview({ data }: { data: HomeOverview }) {
  const { runs } = data;
  const empty = data.workflows.total === 0;
  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Live runs" value={runs.total.toLocaleString()} hint={runs.running ? `${runs.running} running now` : "last 7 days"} />
        <Tile
          label="Succeeded"
          value={runs.successRate === null ? "—" : `${Math.round(runs.successRate * 100)}%`}
          hint={runs.failed ? `${runs.failed} failed` : runs.total ? "nothing failed" : "no runs yet"}
        />
        <Tile label="Typical run" value={formatDuration(runs.avgDurationMs)} hint="average time" />
        <Tile
          label="Live workflows"
          value={`${data.workflows.live} of ${data.workflows.total}`}
          hint={`${data.connections} connected ${data.connections === 1 ? "account" : "accounts"}`}
        />
      </div>

      {empty ? (
        <div className="mt-6 rounded-xl border border-dashed p-6 text-center">
          <p className="font-medium">Nothing here yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Pick a template to get a working workflow in a minute, then connect your apps.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Link href="/app/workflows?templates=1" className={buttonVariants()}>
              <LayoutTemplateIcon data-icon="inline-start" /> Browse templates
            </Link>
            <Link href="/app/connections" className={buttonVariants({ variant: "outline" })}>
              <PlugIcon data-icon="inline-start" /> Connect an app
            </Link>
          </div>
        </div>
      ) : (
        <>
          <RunsChart days={runs.days} />
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section aria-labelledby="busiest-h">
              <h2 id="busiest-h" className="text-sm font-medium text-muted-foreground">
                Busiest workflows
              </h2>
              {runs.workflows.length === 0 ? (
                <p className="mt-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No live runs this week. Publish a workflow to see it here.</p>
              ) : (
                <ul className="mt-3 divide-y rounded-xl border bg-card">
                  {runs.workflows.map((w) => (
                    <li key={w.id}>
                      <Link href={`/app/workflows/${w.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent">
                        <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                        <span className="tabular-nums text-muted-foreground">{w.runs} runs</span>
                        {w.failed > 0 && <span className="tabular-nums text-destructive">{w.failed} failed</span>}
                        <span className="hidden text-xs text-muted-foreground sm:inline">{relativeTime(w.lastRunAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="failures-h">
              <h2 id="failures-h" className="text-sm font-medium text-muted-foreground">
                Latest failures
              </h2>
              {runs.recentFailures.length === 0 ? (
                <p className="mt-3 flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                  <CheckCircle2Icon className="size-4 text-success" aria-hidden /> No failed runs this week.
                </p>
              ) : (
                <ul className="mt-3 divide-y rounded-xl border bg-card">
                  {runs.recentFailures.map((e) => (
                    <li key={e.id}>
                      <Link href={`/app/executions/${e.id}`} className="block px-3 py-2.5 text-sm hover:bg-accent">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">{e.workflowName}</span>
                          <RunStatus status={e.status} />
                          <span className="text-xs text-muted-foreground">{relativeTime(e.startedAt)}</span>
                        </span>
                        {e.error?.message && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{e.error.message}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div className="mt-6 flex flex-wrap gap-3 text-sm text-muted-foreground">
            {data.nextScheduled && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarClockIcon className="size-4" aria-hidden />
                Next scheduled: <Link href={`/app/workflows/${data.nextScheduled.workflowId}`} className="font-medium text-foreground underline-offset-2 hover:underline">{data.nextScheduled.name}</Link>{" "}
                {relativeTime(data.nextScheduled.at)}
              </span>
            )}
            {runs.running > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <RadioIcon className="size-4 text-primary" aria-hidden /> {runs.running} running now
              </span>
            )}
            <Link href="/app/executions" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
              All runs <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </div>
        </>
      )}
    </>
  );
}

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short" });

/** Live runs per day, succeeded and failed stacked. */
function RunsChart({ days }: { days: HomeOverview["runs"]["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.success + d.failed + d.other));
  const total = days.reduce((t, d) => t + d.success + d.failed + d.other, 0);
  return (
    <section aria-labelledby="chart-h" className="mt-6 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="chart-h" className="text-sm font-medium">
          Runs per day
        </h2>
        <div className="flex gap-3 text-xs text-muted-foreground" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-success" /> <CheckCircle2Icon className="size-3" /> Succeeded
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-destructive" /> <XCircleIcon className="size-3" /> Failed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-muted-foreground/40" /> Other
          </span>
        </div>
      </div>
      {total === 0 ? (
        <p className="mt-6 pb-4 text-center text-sm text-muted-foreground">No live runs in the last 7 days.</p>
      ) : (
        <div className="relative mt-4">
          <div className="flex h-40 items-end gap-2 border-b" role="list" aria-label="Runs per day">
            {days.map((d, i) => {
              const n = d.success + d.failed + d.other;
              const pct = (v: number) => `${(v / max) * 100}%`;
              return (
                <div
                  key={d.day}
                  role="listitem"
                  aria-label={`${dayLabel(d.day)}: ${d.success} succeeded, ${d.failed} failed${d.other ? `, ${d.other} other` : ""}`}
                  tabIndex={0}
                  className="group relative flex h-full flex-1 cursor-default flex-col justify-end outline-none"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <div className="mx-auto flex h-full w-full max-w-10 flex-col justify-end gap-[2px]">
                    {d.other > 0 && <div className="rounded-t-[4px] bg-muted-foreground/40" style={{ height: pct(d.other) }} />}
                    {d.failed > 0 && <div className={cn("bg-destructive", d.other ? "" : "rounded-t-[4px]")} style={{ height: pct(d.failed) }} />}
                    {d.success > 0 && <div className={cn("bg-success", d.other || d.failed ? "" : "rounded-t-[4px]")} style={{ height: pct(d.success) }} />}
                  </div>
                  {hover === i && (
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
                      <p className="font-medium">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
                      <p className="tabular-nums">{n} runs · {d.success} succeeded · {d.failed} failed</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex gap-2 text-center text-xs text-muted-foreground">
            {days.map((d) => (
              <span key={d.day} className="flex-1">
                {dayLabel(d.day)}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
