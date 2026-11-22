"use client";

import type { ResolveContext } from "@conduit/core";
import {
  CONDITION_OPERATORS,
  FORM_FIELD_TYPES,
  newConditionRule,
  shortId,
  type Assignment,
  type ConditionGroup,
  type FormQuestion,
  type KeyValuePair,
  type ParamField,
  type SwitchCase,
} from "@conduit/nodes";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import { CredentialSelect, DynamicSuggestions } from "./credential-field";
import type { DataSource } from "./data-context";
import { ExpressionInput } from "./expression-input";

// CodeMirror is big; only load it when a Code step's panel is open.
const CodeEditor = dynamic(() => import("./code-editor").then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <div className="h-[262px] animate-pulse rounded-lg border bg-muted/40" aria-label="Loading code editor" />,
});

export function NativeSelect({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover",
        className,
      )}
    />
  );
}

interface FieldProps {
  field: ParamField;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  sources: DataSource[];
  ctx: ResolveContext;
  workflowId: string;
  /** All of the step's parameters (dynamic options depend on the chosen account). */
  params?: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function RowRemove({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2Icon className="size-3.5" />
    </button>
  );
}

export function ParamFieldView(props: FieldProps) {
  const { field, value, onChange, error, sources, ctx, workflowId, params } = props;
  const id = useId();
  const errId = `${id}-err`;
  const descId = `${id}-desc`;

  let control: React.ReactNode;
  switch (field.kind) {
    case "string":
      control = (
        <ExpressionInput
          id={id}
          label={field.label}
          value={str(value)}
          onChange={onChange}
          placeholder={field.placeholder}
          multiline={field.multiline}
          sources={sources}
          ctx={ctx}
          allowReferences={field.expression !== false}
          aiFill={field.aiFill}
          invalid={Boolean(error)}
          describedBy={error ? errId : field.description ? descId : undefined}
        />
      );
      if (field.dynamicOptions) {
        control = (
          <div className="grid gap-1.5">
            {control}
            <DynamicSuggestions source={field.dynamicOptions} label={field.label} params={params ?? {}} onPick={onChange} />
          </div>
        );
      }
      break;
    case "credential":
      control = <CredentialSelect id={id} app={field.app} value={str(value)} onChange={onChange} invalid={Boolean(error)} />;
      break;
    case "number":
      control = (
        <Input
          id={id}
          inputMode="decimal"
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={field.default !== undefined ? String(field.default) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw.trim() === "") onChange(undefined);
            else if (/^-?\d+(\.\d+)?$/.test(raw.trim())) onChange(Number(raw));
            else onChange(raw);
          }}
        />
      );
      break;
    case "boolean":
      return (
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor={id} className="leading-snug font-normal">
            {field.label}
          </Label>
          <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(Boolean(c))} />
        </div>
      );
    case "select":
      control = (
        <NativeSelect id={id} value={str(value)} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      );
      break;
    case "json":
      control = (
        <ExpressionInput
          id={id}
          label={field.label}
          value={str(value)}
          onChange={onChange}
          placeholder={field.placeholder ?? "{ }"}
          multiline
          mono
          sources={sources}
          ctx={ctx}
          aiFill={field.name === "input" || field.name === "jsonBody"}
          invalid={Boolean(error)}
          describedBy={error ? errId : undefined}
        />
      );
      break;
    case "code":
      control = (
        <div className="grid gap-1.5">
          <CodeEditor id={id} label={field.label} value={str(value)} onChange={onChange} invalid={Boolean(error)} />
          <p className="text-xs text-muted-foreground">
            Runs in an isolated sandbox with no network or file access, a 10 s time limit and 64 MB of memory. Use{" "}
            <code>console.log</code> to debug.
          </p>
        </div>
      );
      break;
    case "keyValue": {
      const rows = Array.isArray(value) ? (value as KeyValuePair[]) : [];
      const set = (next: KeyValuePair[]) => onChange(next);
      control = (
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <Input
                aria-label={`${field.label} name ${i + 1}`}
                className="w-2/5 shrink-0"
                placeholder={field.keyPlaceholder ?? "name"}
                value={r.key}
                onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <div className="min-w-0 flex-1">
                <ExpressionInput
                  label={`${field.label} value ${i + 1}`}
                  value={r.value}
                  placeholder={field.valuePlaceholder ?? "value"}
                  onChange={(v) => set(rows.map((x, j) => (j === i ? { ...x, value: v } : x)))}
                  sources={sources}
                  ctx={ctx}
                />
              </div>
              <RowRemove label={`Remove ${field.label} row ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set([...rows, { key: "", value: "" }])}>
            <PlusIcon data-icon="inline-start" /> Add {field.label.toLowerCase().replace(/s$/, "")}
          </Button>
        </div>
      );
      break;
    }
    case "conditions": {
      const g: ConditionGroup = (value as ConditionGroup) ?? { combinator: "and", rules: [] };
      const set = (next: ConditionGroup) => onChange(next);
      control = (
        <div className="grid gap-2">
          {g.rules.length > 1 && (
            <div className="flex items-center gap-2 text-sm">
              Match
              <NativeSelect
                aria-label="Match all or any condition"
                className="w-auto"
                value={g.combinator}
                onChange={(e) => set({ ...g, combinator: e.target.value as "and" | "or" })}
              >
                <option value="and">all conditions</option>
                <option value="or">any condition</option>
              </NativeSelect>
            </div>
          )}
          {g.rules.map((r, i) => {
            const unary = CONDITION_OPERATORS.find((o) => o.value === r.operator)?.unary ?? false;
            const upd = (patch: Partial<typeof r>) =>
              set({ ...g, rules: g.rules.map((x) => (x.id === r.id ? { ...x, ...patch } : x)) });
            return (
              <div key={r.id} className="grid gap-1.5 rounded-lg border p-2">
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <ExpressionInput
                      label={`Condition ${i + 1} value`}
                      value={r.left}
                      placeholder="Value to check, e.g. ${['$input']['status']}"
                      onChange={(v) => upd({ left: v })}
                      sources={sources}
                      ctx={ctx}
                    />
                  </div>
                  <RowRemove label={`Remove condition ${i + 1}`} onClick={() => set({ ...g, rules: g.rules.filter((x) => x.id !== r.id) })} />
                </div>
                <NativeSelect
                  aria-label={`Condition ${i + 1} operator`}
                  value={r.operator}
                  onChange={(e) => upd({ operator: e.target.value as typeof r.operator })}
                >
                  {CONDITION_OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                {!unary && (
                  <ExpressionInput
                    label={`Condition ${i + 1} comparison`}
                    value={r.right}
                    placeholder="Compare with"
                    onChange={(v) => upd({ right: v })}
                    sources={sources}
                    ctx={ctx}
                  />
                )}
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => set({ ...g, rules: [...g.rules, newConditionRule()] })}
          >
            <PlusIcon data-icon="inline-start" /> Add condition
          </Button>
        </div>
      );
      break;
    }
    case "cases": {
      const cases = Array.isArray(value) ? (value as SwitchCase[]) : [];
      control = (
        <div className="grid gap-2">
          {cases.map((c, i) => (
            <div key={c.id} className="flex items-center gap-1.5">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">Case {i + 1}</span>
              <Input
                aria-label={`Case ${i + 1} value`}
                placeholder="Matches this value"
                value={c.value}
                onChange={(e) => onChange(cases.map((x) => (x.id === c.id ? { ...x, value: e.target.value } : x)))}
              />
              <RowRemove label={`Remove case ${i + 1}`} onClick={() => onChange(cases.filter((x) => x.id !== c.id))} />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onChange([...cases, { id: shortId(), value: "" }])}
          >
            <PlusIcon data-icon="inline-start" /> Add case
          </Button>
        </div>
      );
      break;
    }
    case "assignments": {
      const rows = Array.isArray(value) ? (value as Assignment[]) : [];
      const upd = (rid: string, patch: Partial<Assignment>) => onChange(rows.map((x) => (x.id === rid ? { ...x, ...patch } : x)));
      control = (
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={r.id} className="grid gap-1.5 rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label={`Field ${i + 1} name`}
                  placeholder="Field name"
                  value={r.name}
                  onChange={(e) => upd(r.id, { name: e.target.value })}
                />
                <NativeSelect
                  aria-label={`Field ${i + 1} type`}
                  className="w-28 shrink-0"
                  value={r.type}
                  onChange={(e) => upd(r.id, { type: e.target.value as Assignment["type"] })}
                >
                  <option value="string">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">True/false</option>
                  <option value="json">JSON</option>
                </NativeSelect>
                <RowRemove label={`Remove field ${i + 1}`} onClick={() => onChange(rows.filter((x) => x.id !== r.id))} />
              </div>
              <ExpressionInput
                label={`Field ${i + 1} value`}
                value={r.value}
                placeholder="Value"
                onChange={(v) => upd(r.id, { value: v })}
                sources={sources}
                ctx={ctx}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onChange([...rows, { id: shortId(), name: "", value: "", type: "string" }])}
          >
            <PlusIcon data-icon="inline-start" /> Add field
          </Button>
        </div>
      );
      break;
    }
    case "workflow":
      control = <WorkflowSelect id={id} value={str(value)} onChange={onChange} currentId={workflowId} invalid={Boolean(error)} />;
      break;
    case "formFields": {
      const rows = Array.isArray(value) ? (value as FormQuestion[]) : [];
      const upd = (rid: string, patch: Partial<FormQuestion>) => onChange(rows.map((x) => (x.id === rid ? { ...x, ...patch } : x)));
      control = (
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={r.id} className="grid gap-1.5 rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <Input aria-label={`Question ${i + 1} label`} placeholder="Question" value={r.label} onChange={(e) => upd(r.id, { label: e.target.value })} />
                <RowRemove label={`Remove question ${i + 1}`} onClick={() => onChange(rows.filter((x) => x.id !== r.id))} />
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label={`Question ${i + 1} key`}
                  placeholder="key"
                  className="font-mono text-xs"
                  value={r.name}
                  onChange={(e) => upd(r.id, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                />
                <NativeSelect aria-label={`Question ${i + 1} type`} className="w-32 shrink-0" value={r.type} onChange={(e) => upd(r.id, { type: e.target.value as FormQuestion["type"] })}>
                  {FORM_FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {r.type === "select" && (
                <Input aria-label={`Question ${i + 1} options`} placeholder="Options, separated by commas" value={r.options ?? ""} onChange={(e) => upd(r.id, { options: e.target.value })} />
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={r.required} onChange={(e) => upd(r.id, { required: e.target.checked })} /> Required
              </label>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onChange([...rows, { id: shortId(), name: `field${rows.length + 1}`, label: "", type: "text", required: false }])}
          >
            <PlusIcon data-icon="inline-start" /> Add question
          </Button>
        </div>
      );
      break;
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-muted-foreground">*</span>}
      </Label>
      {control}
      {error ? (
        <p id={errId} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        field.description && (
          <p id={descId} className="text-xs text-muted-foreground">
            {field.description}
          </p>
        )
      )}
    </div>
  );
}

function WorkflowSelect({
  id,
  value,
  onChange,
  currentId,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  currentId: string;
  invalid: boolean;
}) {
  const q = useQuery({
    queryKey: ["workflows", "picker"],
    queryFn: () => api.listWorkflows({ filter: "active", limit: 100 }),
  });
  const options = (q.data?.data ?? []).filter((w) => w.id !== currentId);
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid ? true : undefined} disabled={q.isPending}>
      <option value="">{q.isPending ? "Loading workflows…" : options.length ? "Choose a workflow" : "No other workflows yet"}</option>
      {options.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
      {value && !options.some((w) => w.id === value) && !q.isPending && <option value={value}>Unavailable workflow</option>}
    </NativeSelect>
  );
}
