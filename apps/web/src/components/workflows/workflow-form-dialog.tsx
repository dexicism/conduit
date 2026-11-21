"use client";

import { WORKFLOW_DESCRIPTION_MAX, WORKFLOW_NAME_MAX, workflowNameSchema } from "@conduit/core";
import { Loader2Icon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface WorkflowFormValues {
  name: string;
  description: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initial?: WorkflowFormValues;
  pending: boolean;
  /** Server-side error to show under the form. */
  serverError?: string | null;
  onSubmit: (values: WorkflowFormValues) => void;
}

export function WorkflowFormDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !rest.pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        {/* The popup unmounts when closed, so the form starts fresh from `initial` on every open. */}
        <WorkflowForm {...rest} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function WorkflowForm({
  mode,
  initial,
  pending,
  serverError,
  onSubmit,
  onCancel,
}: Omit<Props, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const ids = { name: useId(), desc: useId(), err: useId() };
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = workflowNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    const desc = description.trim();
    onSubmit({ name: parsed.data, description: desc === "" ? null : desc });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "New workflow" : "Workflow details"}</DialogTitle>
        <DialogDescription>
          {mode === "create"
            ? "Give it a name that says what it does. You can change it later."
            : "Update the name and description."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          id={ids.name}
          autoFocus
          value={name}
          maxLength={WORKFLOW_NAME_MAX + 20}
          placeholder="e.g. Route new leads to Sales"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? ids.err : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {nameError && (
          <p id={ids.err} role="alert" className="text-sm text-destructive">
            {nameError}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.desc}>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={ids.desc}
          rows={3}
          value={description}
          maxLength={WORKFLOW_DESCRIPTION_MAX}
          placeholder="What triggers it and what should happen"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {serverError && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {mode === "create" ? "Create workflow" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
