"use client";

import { cn } from "@/lib/utils";

/** Read-only, selectable JSON block. */
export function JsonView({ value, className, label }: { value: unknown; className?: string; label?: string }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    text = String(value);
  }
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
        className,
      )}
    >
      {text}
    </pre>
  );
}
