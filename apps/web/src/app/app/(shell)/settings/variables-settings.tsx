"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, LockIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/format";

interface Variable {
  id: string;
  name: string;
  secret: boolean;
  value: string | null;
  updatedAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

const refFor = (name: string) => `\${['$vars']['${name}']}`;

/** Values every workflow in the workspace can use. */
export function VariablesSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["variables"], queryFn: () => call<{ variables: Variable[] }>("/api/workspace/variables") });
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["variables"] });

  const create = useMutation({
    mutationFn: () => call<Variable>("/api/workspace/variables", { method: "POST", body: JSON.stringify({ name: name.trim(), value, secret }) }),
    onSuccess: (v) => {
      toast.success(`Added ${v.name}`);
      setName("");
      setValue("");
      setSecret(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: (e: { id: string; value: string }) => call<Variable>(`/api/workspace/variables/${e.id}`, { method: "PATCH", body: JSON.stringify({ value: e.value }) }),
    onSuccess: (v) => {
      toast.success(`Saved ${v.name}`);
      setEditing(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => call(`/api/workspace/variables/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section aria-labelledby="vars-h" className="grid gap-3">
      <div>
        <h2 id="vars-h" className="font-medium">
          Variables
        </h2>
        <p className="text-sm text-muted-foreground">
          Values any workflow here can use, like a phone number or a sheet link. Type <code className="text-xs">{refFor("NAME")}</code> in a step, or copy one
          below. Change it here and every workflow picks it up on its next run. Secret values are encrypted and hidden in run logs.
        </p>
      </div>
      {canEdit && (
        <form
          aria-label="Add a variable"
          className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_1.4fr_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="var-name">Name</Label>
            <Input id="var-name" value={name} placeholder="SUPPORT_PHONE" maxLength={64} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="var-value">Value</Label>
            <Input id="var-value" value={value} type={secret ? "password" : "text"} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <Switch checked={secret} onCheckedChange={setSecret} aria-label="Secret" /> Secret
          </label>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending && <Loader2Icon className="animate-spin" />}
            Add
          </Button>
        </form>
      )}
      {q.isPending ? null : q.isError ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data.variables.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No variables yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border" aria-label="Variables">
          {q.data.variables.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 p-3 sm:flex-nowrap">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-mono text-sm font-medium">
                  {v.secret && <LockIcon className="size-3.5 text-muted-foreground" aria-label="Secret" />}
                  {v.name}
                </p>
                {editing?.id === v.id ? (
                  <form
                    className="mt-1.5 flex gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      save.mutate(editing);
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label={`New value for ${v.name}`}
                      type={v.secret ? "password" : "text"}
                      value={editing.value}
                      placeholder={v.secret ? "New secret value" : undefined}
                      onChange={(e) => setEditing({ id: v.id, value: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                    />
                    <Button type="submit" size="sm" disabled={save.isPending}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <p className="truncate text-xs text-muted-foreground">
                    {v.secret ? "••••••••" : v.value || <em>empty</em>} · changed {relativeTime(v.updatedAt)}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                title="Copy the reference to paste into a step"
                onClick={() => void navigator.clipboard.writeText(refFor(v.name)).then(() => toast.success("Copied. Paste it into any step."))}
              >
                <CopyIcon data-icon="inline-start" /> Copy
              </Button>
              {canEdit && (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={`Change ${v.name}`} onClick={() => setEditing({ id: v.id, value: v.secret ? "" : (v.value ?? "") })}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${v.name}`} disabled={remove.isPending} onClick={() => remove.mutate(v.id)}>
                    <Trash2Icon />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
