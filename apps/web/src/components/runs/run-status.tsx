import type { ExecutionStatus } from "@conduit/core";
import { CheckCircle2Icon, CircleDashedIcon, CircleSlashIcon, HourglassIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const MAP: Record<ExecutionStatus, { label: string; icon: React.ReactNode; cls: string }> = {
  queued: { label: "Queued", icon: <CircleDashedIcon className="size-3.5" />, cls: "text-muted-foreground" },
  running: { label: "Running", icon: <Loader2Icon className="size-3.5 animate-spin" />, cls: "text-primary" },
  waiting: { label: "Waiting", icon: <HourglassIcon className="size-3.5" />, cls: "text-warning" },
  success: { label: "Succeeded", icon: <CheckCircle2Icon className="size-3.5" />, cls: "text-success" },
  failed: { label: "Failed", icon: <XCircleIcon className="size-3.5" />, cls: "text-destructive" },
  canceled: { label: "Canceled", icon: <CircleSlashIcon className="size-3.5" />, cls: "text-muted-foreground" },
};

export function RunStatus({ status, className }: { status: ExecutionStatus; className?: string }) {
  const s = MAP[status];
  return (
    <span data-testid="run-status" className={cn("inline-flex items-center gap-1 text-xs font-medium", s.cls, className)}>
      {s.icon}
      {s.label}
    </span>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const MODE_LABELS = { test: "Test", production: "Live", subworkflow: "Called", error: "Error handler" } as const;
