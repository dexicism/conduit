"use client";

import type { CreditBalanceView, PlanLimits } from "@conduit/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface BillingData {
  plan: string;
  plans: PlanLimits[];
  balance: CreditBalanceView;
  history: Array<{ id: string; kind: string; pool: string; amount: number; reason: string; createdAt: string }>;
  canManage: boolean;
  billingEnabled: boolean;
  invoices: Array<{ id: string; number: string | null; amount: number; currency: string; status: string; createdAt: string; pdfUrl: string | null; pageUrl: string | null }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums" data-testid={`meter-${label}`}>
          {value.toLocaleString()} <span className="text-muted-foreground">/ {max.toLocaleString()}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={cn("h-full rounded-full", pct < 10 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BillingView({ notice }: { notice?: "success" | "canceled" }) {
  const q = useQuery({ queryKey: ["billing"], queryFn: () => call<BillingData>("/api/billing") });
  const checkout = useMutation({
    mutationFn: (plan: string) => call<{ url: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e: Error) => toast.error(e.message),
  });
  const portal = useMutation({
    mutationFn: () => call<{ url: string }>("/api/billing/portal", { method: "POST" }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isPending) return <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"><Skeleton className="h-64" /></div>;
  if (q.isError) return <p className="p-8 text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  const current = d.plans.find((p) => p.id === d.plan) ?? d.plans[0]!;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plan & credits</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live runs use credits per step: HTTP, code and app steps cost 1, AI steps 2 (the AI Agent 5). Triggers, logic and data steps are free. Test runs in the editor are free.
        </p>
      </div>
      {notice === "success" && (
        <p role="status" className="rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
          Payment received. Your plan updates as soon as the payment provider confirms it, usually within a minute.
        </p>
      )}

      <section aria-labelledby="usage-h" className="grid gap-4 rounded-xl border p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="usage-h" className="font-medium">
            {current.name} plan
          </h2>
          <p className="text-xs text-muted-foreground">Credits refill {relativeTime(d.balance.periodResetAt)}</p>
        </div>
        <Meter label="Credits" value={d.balance.plan} max={current.credits} />
        <Meter label="AI Builder credits" value={d.balance.builder} max={current.builderCredits} />
        {d.balance.lifetime > 0 && <p className="text-sm text-muted-foreground">Bonus credits (used after plan credits): {d.balance.lifetime.toLocaleString()}</p>}
        <p className="text-xs text-muted-foreground">
          Up to {current.concurrency} runs at once · run logs kept {current.retentionDays} days · {current.members} member{current.members === 1 ? "" : "s"}
        </p>
        {d.canManage && d.billingEnabled && d.plan !== "free" && (
          <div>
            <Button variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending}>
              {portal.isPending && <Loader2Icon className="animate-spin" />}
              Manage billing <ExternalLinkIcon />
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="plans-h" className="grid gap-3">
        <h2 id="plans-h" className="font-medium">
          Plans
        </h2>
        {!d.billingEnabled && <p className="text-sm text-muted-foreground">Paid plans aren&apos;t available on this server yet.</p>}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Plans">
          {d.plans.map((p) => (
            <li key={p.id} className={cn("grid gap-3 rounded-xl border p-4", p.id === d.plan && "border-primary ring-1 ring-primary")}>
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-2xl font-semibold tabular-nums">
                  ${p.priceUsd}
                  <span className="text-sm font-normal text-muted-foreground">/month</span>
                </p>
              </div>
              <ul className="grid gap-1 text-sm text-muted-foreground">
                <li>{p.credits.toLocaleString()} credits</li>
                <li>{p.builderCredits} AI Builder credits</li>
                <li>{p.concurrency} runs at once</li>
                <li>{p.retentionDays}-day run logs</li>
                <li>
                  {p.members} member{p.members === 1 ? "" : "s"}
                </li>
              </ul>
              {p.id === d.plan ? (
                <p className="text-sm font-medium">Current plan</p>
              ) : (
                d.canManage &&
                d.billingEnabled &&
                p.id !== "free" &&
                d.plan === "free" && (
                  <Button onClick={() => checkout.mutate(p.id)} disabled={checkout.isPending} aria-label={`Upgrade to ${p.name}`}>
                    {checkout.isPending && checkout.variables === p.id && <Loader2Icon className="animate-spin" />}
                    Upgrade
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
        {d.canManage && d.billingEnabled && d.plan !== "free" && <p className="text-xs text-muted-foreground">To switch or cancel a paid plan, use Manage billing.</p>}
      </section>

      {d.invoices.length > 0 && (
        <section aria-labelledby="inv-h" className="grid gap-3">
          <h2 id="inv-h" className="font-medium">
            Invoices
          </h2>
          <ul className="grid divide-y rounded-xl border" aria-label="Invoices">
            {d.invoices.map((i) => (
              <li key={i.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="flex-1">{i.number ?? i.id}</span>
                <span className="tabular-nums">
                  {i.amount.toFixed(2)} {i.currency}
                </span>
                <span className="text-muted-foreground capitalize">{i.status}</span>
                {i.pdfUrl && (
                  <a className="underline underline-offset-2" href={i.pdfUrl} target="_blank" rel="noreferrer">
                    PDF
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="hist-h" className="grid gap-3">
        <h2 id="hist-h" className="font-medium">
          Recent credit activity
        </h2>
        {d.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="grid divide-y rounded-xl border" aria-label="Credit activity">
            {d.history.map((h) => (
              <li key={h.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{h.reason}</span>
                <span className={cn("tabular-nums", h.amount < 0 ? "text-muted-foreground" : "text-success")}>
                  {h.amount > 0 ? "+" : ""}
                  {h.amount.toLocaleString()}
                </span>
                <span className="w-24 text-right text-xs text-muted-foreground">{relativeTime(h.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
