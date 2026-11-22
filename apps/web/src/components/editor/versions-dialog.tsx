"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { HistoryIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { useEditorStoreApi } from "./context";

/** Every publish of the workflow; any of them can be put back into the editor. */
export function VersionsDialog({
  workflowId,
  open,
  onOpenChange,
  flush,
}: {
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flush: () => Promise<number | null>;
}) {
  const store = useEditorStoreApi();
  const q = useQuery({ queryKey: ["versions", workflowId], queryFn: () => api.listVersions(workflowId), enabled: open });
  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      // Save what's on the canvas first, so the restore can be undone back to it.
      if ((await flush()) === null) throw new Error("Save your changes before restoring a version");
      return api.restoreVersion(workflowId, versionId);
    },
    onSuccess: (wf, versionId) => {
      store.getState().applyBuilderResult(wf.draft, wf.revision, { added: [], updated: [] });
      const v = q.data?.versions.find((x) => x.id === versionId);
      toast.success(v ? `The version from ${new Date(v.publishedAt).toLocaleString()} is back in the editor` : "Version restored", {
        description: "Live runs don't change until you publish. Press Ctrl+Z to undo.",
      });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>A copy is saved every time you publish. Restoring puts it in the editor; publish again to make it live.</DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : q.data.versions.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <HistoryIcon className="size-4" aria-hidden /> No versions yet. Publish the workflow to save one.
          </p>
        ) : (
          <ul className="grid max-h-[60vh] gap-1.5 overflow-y-auto" aria-label="Versions">
            {q.data.versions.map((v, i) => (
              <li key={v.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {new Date(v.publishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    {v.live && <span className="ml-2 rounded-full bg-success/15 px-1.5 py-0.5 text-xs font-medium text-success">Live</span>}
                    {!v.live && i === 0 && <span className="ml-2 text-xs text-muted-foreground">latest</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {relativeTime(v.publishedAt)} · {v.stepCount} {v.stepCount === 1 ? "step" : "steps"}
                    {v.publishedBy ? ` · by ${v.publishedBy}` : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => restore.mutate(v.id)}>
                  {restore.isPending && restore.variables === v.id ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon data-icon="inline-start" />}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
