"use client";

import { getDefinition } from "@conduit/nodes";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon, Loader2Icon, PlayIcon, RadioIcon, RocketIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { useEditor } from "./context";
import { NativeSelect } from "./param-fields";

/** "Test" button: runs from the only trigger, or offers a choice when there are several. */
export function TestButton({ onStart }: { onStart: (nodeId: string, isWebhook: boolean) => void }) {
  const nodes = useEditor((s) => s.graph.nodes);
  const run = useEditor((s) => s.run);
  const triggers = nodes.filter((n) => getDefinition(n.type)?.category === "trigger" && !n.disabled);
  const busy = run !== null && run.phase !== "done";
  if (!triggers.length) return null;

  const label = (n: (typeof triggers)[number]) => (n.type === "trigger.webhook" ? `Listen for a request · ${n.label}` : `Run from ${n.label}`);

  if (triggers.length === 1) {
    const t = triggers[0]!;
    const hook = t.type === "trigger.webhook";
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onStart(t.id, hook)}>
        {busy ? <Loader2Icon className="animate-spin" /> : hook ? <RadioIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
        <span className="hidden sm:inline">{hook ? "Listen for test request" : "Test workflow"}</span>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
        {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon data-icon="inline-start" />}
        <span className="hidden sm:inline">Test workflow</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Start from</DropdownMenuLabel>
        </DropdownMenuGroup>
        {triggers.map((t) => (
          <DropdownMenuItem key={t.id} onClick={() => onStart(t.id, t.type === "trigger.webhook")}>
            {t.type === "trigger.webhook" ? <RadioIcon /> : <PlayIcon />}
            {label(t)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface LiveTrigger {
  nodeId: string;
  kind: "webhook" | "schedule" | "telegram" | "form";
  method?: string;
  url?: string;
  nextRunAt?: string;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy. Select the text and copy it manually.");
  }
}

export function LiveTriggersDialog({ open, onOpenChange, triggers }: { open: boolean; onOpenChange: (o: boolean) => void; triggers: LiveTrigger[] }) {
  const nodes = useEditor((s) => s.graph.nodes);
  const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workflow is live</DialogTitle>
          <DialogDescription>
            {triggers.length ? "These triggers now start the published version." : "It has no webhook, form, bot or schedule; it runs when another workflow or the API calls it."}
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-3">
          {triggers.map((t) => (
            <li key={t.nodeId} className="grid gap-1 rounded-lg border p-3 text-sm">
              <span className="font-medium">{label(t.nodeId)}</span>
              {t.kind === "webhook" || t.kind === "form" ? (
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{t.kind === "form" ? "FORM" : t.method}</span>
                  <code data-testid="live-url" className="min-w-0 flex-1 truncate text-xs">
                    {t.url}
                  </code>
                  {t.kind === "form" && t.url && (
                    <Button variant="outline" size="icon-sm" aria-label="Open the form" nativeButton={false} render={<a href={t.url} target="_blank" rel="noreferrer" />}>
                      <ExternalLinkIcon />
                    </Button>
                  )}
                  <Button variant="outline" size="icon-sm" aria-label={t.kind === "form" ? "Copy form link" : "Copy production URL"} onClick={() => copy(t.url ?? "")}>
                    <CopyIcon />
                  </Button>
                </div>
              ) : t.kind === "telegram" ? (
                <span className="text-muted-foreground">Messages to your bot start this workflow.</span>
              ) : (
                <span className="text-muted-foreground">Next run {t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}</span>
              )}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Publish button reflecting whether the live version matches the draft. */
export function PublishButton({ onPublish, pending }: { onPublish: () => void; pending: boolean }) {
  const revision = useEditor((s) => s.revision);
  const published = useEditor((s) => s.publishedRevision);
  const saveState = useEditor((s) => s.saveState);
  const upToDate = published !== null && published === revision && saveState === "saved";
  if (upToDate) {
    return (
      <span data-testid="publish-state" className="flex items-center gap-1 rounded-md px-2 text-xs font-medium text-success">
        <CheckIcon className="size-3.5" /> Published
      </span>
    );
  }
  return (
    <Button size="sm" onClick={onPublish} disabled={pending}>
      {pending ? <Loader2Icon className="animate-spin" /> : <RocketIcon data-icon="inline-start" />}
      <span className="hidden sm:inline">{published === null ? "Publish" : "Publish changes"}</span>
    </Button>
  );
}

export function WorkflowSettingsDialog({
  open,
  onOpenChange,
  workflowId,
  errorWorkflowId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflowId: string;
  errorWorkflowId: string | null;
  onSaved: (errorWorkflowId: string | null) => void;
}) {
  const [value, setValue] = useState(errorWorkflowId ?? "");
  const [saving, setSaving] = useState(false);
  const list = useQuery({
    queryKey: ["workflows", "picker"],
    queryFn: () => api.listWorkflows({ filter: "active", limit: 100 }),
    enabled: open,
  });
  const options = (list.data?.data ?? []).filter((w) => w.id !== workflowId);

  async function save() {
    setSaving(true);
    try {
      await api.updateWorkflow(workflowId, { settings: { errorWorkflowId: value || null } });
      onSaved(value || null);
      toast.success("Settings saved");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Workflow settings</DialogTitle>
          <DialogDescription>Applies to live runs of the published version.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="error-workflow">When a live run fails, start</Label>
          <NativeSelect id="error-workflow" value={value} onChange={(e) => setValue(e.target.value)} disabled={list.isPending}>
            <option value="">Nothing</option>
            {options.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            The chosen workflow must be published and start with “On workflow error”. It receives the error and run details.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2Icon className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
