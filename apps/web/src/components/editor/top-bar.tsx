"use client";

import { workflowNameSchema, type WorkflowDetail } from "@conduit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloudOffIcon,
  HistoryIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RadioIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { LiveTriggersDialog, PublishButton, TestButton, WorkflowSettingsDialog, type LiveTrigger } from "./run-controls";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/workflows/status-badge";
import { WorkflowFormDialog } from "@/components/workflows/workflow-form-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useEditor, useEditorStoreApi } from "./context";

type Meta = Pick<WorkflowDetail, "id" | "name" | "description" | "status" | "settings">;

function SaveIndicator() {
  const state = useEditor((s) => s.saveState);
  const map = {
    saved: { icon: <CheckIcon className="size-3.5" />, text: "Saved", cls: "text-muted-foreground" },
    dirty: { icon: <Loader2Icon className="size-3.5 animate-spin" />, text: "Saving…", cls: "text-muted-foreground" },
    saving: { icon: <Loader2Icon className="size-3.5 animate-spin" />, text: "Saving…", cls: "text-muted-foreground" },
    offline: { icon: <CloudOffIcon className="size-3.5" />, text: "Offline", cls: "text-warning" },
    conflict: { icon: <TriangleAlertIcon className="size-3.5" />, text: "Not saved", cls: "text-destructive" },
    error: { icon: <TriangleAlertIcon className="size-3.5" />, text: "Not saved", cls: "text-destructive" },
  } as const;
  const s = map[state];
  return (
    <span role="status" aria-live="polite" data-testid="save-status" className={cn("flex items-center gap-1 text-xs", s.cls)}>
      {s.icon}
      <span className="hidden sm:inline">{s.text}</span>
    </span>
  );
}

export function EditorTopBar({
  initial,
  onStartTest,
  flush,
}: {
  initial: Meta;
  onStartTest: (nodeId: string, isWebhook: boolean) => void;
  flush: () => Promise<number | null>;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const store = useEditorStoreApi();
  const hasNodes = useEditor((s) => s.graph.nodes.length > 0);
  const publishedRevision = useEditor((s) => s.publishedRevision);
  const aiEnabled = useEditor((s) => s.ai.enabled);
  const builderOpen = useEditor((s) => s.builderOpen);
  const [meta, setMeta] = useState(initial);
  const [nameDraft, setNameDraft] = useState(initial.name);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [live, setLive] = useState<LiveTrigger[] | null>(null);
  const [publishing, setPublishing] = useState(false);

  async function publish() {
    setPublishing(true);
    try {
      const rev = await flush();
      if (rev === null) {
        toast.error("Save your changes before publishing");
        return;
      }
      const res = await fetch(`/api/workflows/${meta.id}/publish`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { publishedRevision: number; triggers: LiveTrigger[]; message?: string; issues?: Array<{ message: string }> }
        | null;
      if (!res.ok || !body) {
        const issues = body?.issues ?? [];
        toast.error(body?.message ?? "Couldn't publish", {
          description: issues.length ? issues.slice(0, 4).map((i) => `• ${i.message}`).join("\n") : undefined,
          duration: 8000,
        });
        return;
      }
      store.getState().setPublishedRevision(body.publishedRevision);
      setMeta((m) => ({ ...m, status: "published" }));
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      setLive(body.triggers);
    } finally {
      setPublishing(false);
    }
  }

  async function unpublish() {
    const res = await fetch(`/api/workflows/${meta.id}/publish`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Couldn't unpublish");
      return;
    }
    store.getState().setPublishedRevision(null);
    setMeta((m) => ({ ...m, status: m.status === "archived" ? "archived" : "draft" }));
    void qc.invalidateQueries({ queryKey: ["workflows"] });
    toast.success("Workflow unpublished. Its triggers are off.");
  }

  async function showLive() {
    const res = await fetch(`/api/workflows/${meta.id}/publish`);
    if (res.ok) setLive(((await res.json()) as { triggers: LiveTrigger[] }).triggers);
  }

  const update = useMutation({
    mutationFn: (input: { name?: string; description?: string | null; archived?: boolean }) => api.updateWorkflow(meta.id, input),
    onSuccess: (wf, vars) => {
      setMeta({ id: wf.id, name: wf.name, description: wf.description, status: wf.status, settings: wf.settings });
      if (vars.archived) store.getState().setPublishedRevision(null);
      setNameDraft(wf.name);
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      if (vars.archived !== undefined) toast.success(vars.archived ? "Workflow archived" : "Workflow restored");
      if (vars.description !== undefined) setDetailsOpen(false);
    },
    onError: (err, vars) => {
      if (vars.description !== undefined) setDetailsError(errorMessage(err));
      else {
        toast.error(errorMessage(err));
        setNameDraft(meta.name);
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteWorkflow(meta.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      toast.success("Workflow deleted");
      router.replace("/app/workflows");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function commitName() {
    const parsed = workflowNameSchema.safeParse(nameDraft);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid name");
      setNameDraft(meta.name);
      return;
    }
    if (parsed.data !== meta.name) update.mutate({ name: parsed.data });
    else setNameDraft(meta.name);
  }

  const archived = meta.status === "archived";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-3">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to workflows"
        nativeButton={false}
        render={<Link href="/app/workflows" />}
      >
        <ArrowLeftIcon />
      </Button>
      <input
        aria-label="Workflow name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setNameDraft(meta.name);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
        className="h-8 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-input focus-visible:border-ring sm:max-w-sm sm:flex-none"
      />
      <StatusBadge status={meta.status} className="hidden md:inline-flex" />
      <SaveIndicator />
      <div className="ml-auto flex items-center gap-1">
        {aiEnabled && (
          <Button variant="ghost" size="sm" aria-pressed={builderOpen} onClick={() => store.getState().setBuilderOpen(!builderOpen)}>
            <SparklesIcon data-icon="inline-start" className="text-violet-500" />
            <span className="hidden lg:inline">Build with AI</span>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => store.getState().openPicker(hasNodes ? {} : { triggersOnly: true })}>
          <PlusIcon data-icon="inline-start" />
          <span className="hidden lg:inline">{hasNodes ? "Add step" : "Add trigger"}</span>
        </Button>
        <TestButton onStart={onStartTest} />
        {meta.status !== "archived" && <PublishButton onPublish={() => void publish()} pending={publishing} />}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Workflow options" />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => {
                setDetailsError(null);
                setDetailsOpen(true);
              }}
            >
              <PencilIcon /> Edit details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <SettingsIcon /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={`/app/executions?workflowId=${meta.id}`} />}>
              <HistoryIcon /> Run history
            </DropdownMenuItem>
            {publishedRevision !== null && (
              <>
                <DropdownMenuItem onClick={() => void showLive()}>
                  <RadioIcon /> Live triggers
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void unpublish()}>
                  <CloudOffIcon /> Unpublish
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={() => update.mutate({ archived: !archived })}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Restore" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon /> Delete workflow
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <LiveTriggersDialog open={live !== null} onOpenChange={(o) => !o && setLive(null)} triggers={live ?? []} />
      <WorkflowSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workflowId={meta.id}
        errorWorkflowId={meta.settings.errorWorkflowId}
        onSaved={(errorWorkflowId) => setMeta((m) => ({ ...m, settings: { errorWorkflowId } }))}
      />
      <WorkflowFormDialog
        mode="edit"
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        initial={{ name: meta.name, description: meta.description }}
        pending={update.isPending}
        serverError={detailsError}
        onSubmit={(v) => {
          setDetailsError(null);
          update.mutate(v);
        }}
      />
      <AlertDialog open={confirmDelete} onOpenChange={(o) => !remove.isPending && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meta.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes the workflow. It can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending && <Loader2Icon className="animate-spin" />}
              Delete workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}

export function SaveProblemBanner({ onRetry }: { onRetry: () => void }) {
  const store = useEditorStoreApi();
  const state = useEditor((s) => s.saveState);
  const message = useEditor((s) => s.saveMessage);
  const workflowId = useEditor((s) => s.workflowId);
  const [busy, setBusy] = useState(false);

  if (state !== "conflict" && state !== "error") return null;

  async function fetchLatest(): Promise<WorkflowDetail | null> {
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`);
      if (!res.ok) throw new Error();
      return (await res.json()) as WorkflowDetail;
    } catch {
      toast.error("Couldn't load the latest version. Check your connection.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
      <TriangleAlertIcon className="size-4 text-destructive" />
      <span className="min-w-0 flex-1">{message}</span>
      {state === "conflict" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              const wf = await fetchLatest();
              if (wf) {
                store.getState().resetFromServer(wf);
                toast.success("Loaded the latest version");
              }
            }}
          >
            Load latest version
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              const wf = await fetchLatest();
              if (wf) store.getState().adoptServerRevision(wf.revision);
            }}
          >
            Keep my version
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
