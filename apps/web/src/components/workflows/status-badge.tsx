import type { WorkflowStatus } from "@conduit/core";
import { cn } from "@/lib/utils";

const STYLES: Record<WorkflowStatus, { label: string; dot: string }> = {
  draft: { label: "Draft", dot: "bg-muted-foreground/60" },
  published: { label: "Live", dot: "bg-success" },
  archived: { label: "Archived", dot: "bg-warning" },
};

export function StatusBadge({ status, className }: { status: WorkflowStatus; className?: string }) {
  const s = STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}
