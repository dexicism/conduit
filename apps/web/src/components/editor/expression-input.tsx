"use client";

import { buildAiFill, buildReference, hasReferences, parseAiFills, parseTemplate, resolveTemplate, type ResolveContext } from "@conduit/core";
import { BracesIcon, ChevronRightIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DataSource } from "./data-context";

function preview(v: unknown): string {
  if (v === undefined) return "(empty)";
  if (typeof v === "string") return v === "" ? "(empty text)" : v;
  return JSON.stringify(v);
}

function JsonTree({
  value,
  path,
  onPick,
  depth = 0,
}: {
  value: unknown;
  path: string[];
  onPick: (path: string[]) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null || typeof value !== "object") {
    return null;
  }
  const entries = Array.isArray(value)
    ? value.slice(0, 5).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (depth > 0 && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="ml-1 text-xs text-muted-foreground hover:text-foreground">
        …
      </button>
    );
  }
  return (
    <ul className={cn("space-y-0.5", depth > 0 && "ml-3 border-l pl-2")}>
      {entries.map(([k, v]) => {
        const p = [...path, k];
        const nested = v !== null && typeof v === "object";
        return (
          <li key={k}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onPick(p)}
                className="rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-accent"
                title={`Insert ${p.join(".")}`}
              >
                {k}
              </button>
              {!nested && <span className="truncate text-xs text-muted-foreground">{preview(v)}</span>}
            </div>
            {nested && <JsonTree value={v} path={p} onPick={onPick} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

export function VariablePicker({
  sources,
  onInsert,
  label,
}: {
  sources: DataSource[];
  onInsert: (ref: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Insert data into ${label}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <BracesIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">Insert data</p>
          <p className="text-xs text-muted-foreground">Pick a field from an earlier step. Values shown are examples.</p>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {sources.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">Connect a step before this one to use its data.</p>
          ) : (
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s.source}>
                  <details open={sources.length <= 2}>
                    <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent">
                      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform [details[open]>summary>&]:rotate-90" />
                      <span className="truncate font-medium">{s.label}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.typeName}</span>
                    </summary>
                    <div className="py-1 pl-4">
                      {s.sample && typeof s.sample === "object" && Object.keys(s.sample).length > 0 ? (
                        <JsonTree
                          value={s.sample}
                          path={[]}
                          onPick={(p) => {
                            onInsert(buildReference(s.source, p));
                            setOpen(false);
                          }}
                        />
                      ) : (
                        <p className="text-xs text-muted-foreground">Passes its input through unchanged.</p>
                      )}
                      <button
                        type="button"
                        className="mt-1 rounded px-1 py-0.5 text-xs text-primary hover:bg-accent"
                        onClick={() => {
                          onInsert(buildReference(s.source));
                          setOpen(false);
                        }}
                      >
                        Insert the whole item
                      </button>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Text input that accepts `${[...]}` references, with an insert-data button and an example preview. */
export function ExpressionInput({
  value,
  onChange,
  label,
  placeholder,
  multiline,
  mono,
  sources,
  ctx,
  allowReferences = true,
  aiFill = false,
  invalid,
  describedBy,
  id: idProp,
}: {
  /** Offer a button that inserts an agent-filled placeholder. */
  aiFill?: boolean;
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  sources: DataSource[];
  ctx: ResolveContext;
  allowReferences?: boolean;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const showPreview = allowReferences && hasReferences(value);
  const resolved = showPreview ? resolveTemplate(value, ctx) : null;
  const invalidRefs = showPreview ? parseTemplate(value).filter((p) => p.kind === "invalid") : [];

  const insert = (refText: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + refText + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + refText.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const common = {
    id,
    ref,
    value,
    placeholder,
    "aria-invalid": invalid || invalidRefs.length > 0 ? true : undefined,
    "aria-describedby": describedBy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    className: cn(mono && "font-mono text-xs", showPreview && "text-primary"),
  };

  return (
    <div className="grid gap-1">
      <div className="flex items-start gap-1.5">
        {multiline ? <Textarea rows={mono ? 6 : 3} {...common} /> : <Input {...common} />}
        {aiFill && (
          <button
            type="button"
            aria-label={`Let the agent fill part of ${label}`}
            title="Insert a value the agent chooses when it calls this tool"
            onClick={() => insert(buildAiFill("value", "Describe what the agent should put here", "string"))}
            className="flex h-7 shrink-0 items-center justify-center rounded-md border px-1.5 text-[10px] font-semibold text-violet-600 hover:bg-accent dark:text-violet-300"
          >
            AI
          </button>
        )}
        {allowReferences && <VariablePicker sources={sources} onInsert={insert} label={label} />}
      </div>
      {aiFill && parseAiFills(value).length > 0 && (
        <p className="text-[11px] text-violet-600 dark:text-violet-300">
          Agent fills: {parseAiFills(value).map((s) => `${s.key} (${s.type})`).join(", ")}
        </p>
      )}
      {resolved && (
        <p className="truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground" title={preview(resolved.value)}>
          <span className="font-sans">Example: </span>
          {preview(resolved.value)}
          {resolved.missing.length > 0 && <span className="ml-1 text-warning">· {resolved.missing.length} not found</span>}
        </p>
      )}
      {invalidRefs.length > 0 && (
        <p className="text-xs text-destructive">
          {invalidRefs[0]!.kind === "invalid" ? invalidRefs[0]!.message : ""}
        </p>
      )}
    </div>
  );
}
