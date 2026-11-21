"use client";

import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { NativeSelect } from "@/components/editor/param-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Q {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options: string;
}

export function PublicForm({ path, title, description, questions, submitLabel }: { path: string; title: string; description: string; questions: Q[]; submitLabel: string }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [website, setWebsite] = useState("");

  if (done) {
    return (
      <div role="status" className="grid gap-3 rounded-xl border p-6 text-center">
        <CheckCircle2Icon className="mx-auto size-8 text-success" aria-hidden />
        <p className="whitespace-pre-line">{done}</p>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="grid gap-5"
      aria-label={title}
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setFormError(null);
        try {
          const res = await fetch(`/api/forms/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ values, website }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok) setDone(String(data?.message ?? "Thanks!"));
          else {
            setErrors(data?.fields ?? {});
            setFormError(data?.message ?? "Something went wrong. Please try again.");
          }
        } catch {
          setFormError("Network error. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="whitespace-pre-line text-sm text-muted-foreground">{description}</p>}
      </div>
      {questions.map((q) => {
        const id = `q-${q.name}`;
        const err = errors[q.name];
        const set = (v: string | boolean) => setValues((s) => ({ ...s, [q.name]: v }));
        const common = { id, "aria-invalid": err ? true : undefined, "aria-describedby": err ? `${id}-err` : undefined } as const;
        return (
          <div key={q.name} className="grid gap-1.5">
            {q.type === "checkbox" ? (
              <label className="flex items-start gap-2 text-sm">
                <input {...common} type="checkbox" className="mt-0.5" checked={values[q.name] === true} onChange={(e) => set(e.target.checked)} />
                <span>
                  {q.label}
                  {q.required && <span className="text-muted-foreground">*</span>}
                </span>
              </label>
            ) : (
              <>
                <Label htmlFor={id}>
                  {q.label}
                  {q.required && <span className="text-muted-foreground">*</span>}
                </Label>
                {q.type === "textarea" ? (
                  <Textarea {...common} rows={4} value={String(values[q.name] ?? "")} onChange={(e) => set(e.target.value)} />
                ) : q.type === "select" ? (
                  <NativeSelect {...common} className="h-9" value={String(values[q.name] ?? "")} onChange={(e) => set(e.target.value)}>
                    <option value="">Choose…</option>
                    {q.options
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean)
                      .map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                  </NativeSelect>
                ) : (
                  <Input
                    {...common}
                    type={q.type === "email" ? "email" : q.type === "number" ? "number" : "text"}
                    autoComplete={q.type === "email" ? "email" : undefined}
                    value={String(values[q.name] ?? "")}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </>
            )}
            {err && (
              <p id={`${id}-err`} className="text-xs text-destructive">
                {err}
              </p>
            )}
          </div>
        );
      })}
      <div aria-hidden className="absolute left-[-10000px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending && <Loader2Icon className="animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
