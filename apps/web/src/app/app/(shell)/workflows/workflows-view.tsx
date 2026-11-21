"use client";

import type { ListFilter, WorkflowSummary } from "@conduit/core";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/workflows/status-badge";
import { WorkflowFormDialog, type WorkflowFormValues } from "@/components/workflows/workflow-form-dialog";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const FILTERS: Array<{ value: ListFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function WorkflowsView() {
  const router = useRouter();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [filter, setFilter] = useState<ListFilter>("active");

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<WorkflowSummary | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowSummary | null>(null);

  const list = useInfiniteQuery({
    queryKey: ["workflows", { q, filter }],
    queryFn: ({ pageParam }) => api.listWorkflows({ q: q || undefined, filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["workflows"] });

  const create = useMutation({
    mutationFn: (v: WorkflowFormValues) => api.createWorkflow({ ...v, requestId }),
    onSuccess: (wf) => {
      setCreateOpen(false);
      setRequestId(crypto.randomUUID());
      void invalidate();
      router.push(`/app/workflows/${wf.id}`);
    },
    onError: (err) => setCreateError(errorMessage(err)),
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; description?: string | null; archived?: boolean }) =>
      api.updateWorkflow(id, input),
    onSuccess: (_wf, vars) => {
      void invalidate();
      if (vars.archived === true) toast.success("Workflow archived");
      else if (vars.archived === false) toast.success("Workflow restored");
      else {
        setEditing(null);
        toast.success("Workflow updated");
      }
    },
    onError: (err, vars) => {
      if (vars.archived === undefined) setEditError(errorMessage(err));
      else toast.error(errorMessage(err));
    },
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateWorkflow(id),
    onSuccess: (wf) => {
      void invalidate();
      toast.success(`Created “${wf.name}”`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      setDeleting(null);
      void invalidate();
      toast.success("Workflow deleted");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function openCreate() {
    setCreateError(null);
    setCreateOpen(true);
  }

  const isFiltered = q.length > 0;
  const showEmpty = list.isSuccess && items.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">Automations in this workspace.</p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          New workflow
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search workflows"
            placeholder="Search by name"
            className="h-9 pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>
        <div role="tablist" aria-label="Filter workflows" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              type="button"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                filter === f.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {list.isPending ? (
          <ul aria-label="Loading workflows" className="divide-y rounded-xl border">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/5" />
                </div>
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-8 text-center">
            <p className="font-medium">Couldn&apos;t load workflows</p>
            <p className="mt-1 text-sm text-muted-foreground">{errorMessage(list.error)}</p>
            <Button variant="outline" className="mt-4" onClick={() => list.refetch()}>
              <RefreshCwIcon data-icon="inline-start" /> Try again
            </Button>
          </div>
        ) : showEmpty ? (
          <EmptyState filter={filter} filtered={isFiltered} onCreate={openCreate} onClear={() => setSearch("")} />
        ) : (
          <>
            <ul aria-label="Workflows" className="divide-y overflow-hidden rounded-xl border bg-card">
              <AnimatePresence initial={false}>
                {items.map((wf) => (
                  <motion.li
                    key={wf.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="group relative flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <WorkflowIcon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/app/workflows/${wf.id}`}
                        className="block truncate font-medium after:absolute after:inset-0 focus-visible:outline-none"
                      >
                        {wf.name}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {wf.description ? `${wf.description} · ` : ""}Edited {relativeTime(wf.updatedAt)}
                      </p>
                    </div>
                    <StatusBadge status={wf.status} className="hidden sm:inline-flex" />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="relative z-10"
                            aria-label={`Actions for ${wf.name}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditError(null);
                            setEditing(wf);
                          }}
                        >
                          <PencilIcon /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => duplicate.mutate(wf.id)}>
                          <CopyIcon /> Duplicate
                        </DropdownMenuItem>
                        {wf.status === "archived" ? (
                          <DropdownMenuItem onClick={() => update.mutate({ id: wf.id, archived: false })}>
                            <ArchiveRestoreIcon /> Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => update.mutate({ id: wf.id, archived: true })}>
                            <ArchiveIcon /> Archive
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(wf)}>
                          <Trash2Icon /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
            {list.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage && <Loader2Icon className="animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <WorkflowFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={create.isPending}
        serverError={createError}
        onSubmit={(v) => {
          setCreateError(null);
          create.mutate(v);
        }}
      />
      <WorkflowFormDialog
        mode="edit"
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={editing ? { name: editing.name, description: editing.description } : undefined}
        pending={update.isPending}
        serverError={editError}
        onSubmit={(v) => {
          if (!editing) return;
          setEditError(null);
          update.mutate({ id: editing.id, ...v });
        }}
      />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the workflow. It can&apos;t be undone. Archive it instead if you might need it
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending && <Loader2Icon className="animate-spin" />}
              Delete workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState({
  filter,
  filtered,
  onCreate,
  onClear,
}: {
  filter: ListFilter;
  filtered: boolean;
  onCreate: () => void;
  onClear: () => void;
}) {
  if (filtered) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium">No workflows match your search</p>
        <Button variant="outline" className="mt-4" onClick={onClear}>
          Clear search
        </Button>
      </div>
    );
  }
  if (filter === "archived") {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium">Nothing archived</p>
        <p className="mt-1 text-sm text-muted-foreground">Archived workflows show up here.</p>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed p-12 text-center">
      <div className="bg-dots pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <div className="relative">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <WorkflowIcon className="size-5" />
        </span>
        <p className="mt-4 text-lg font-medium">Create your first workflow</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          A workflow starts with a trigger and runs a chain of steps every time it fires.
        </p>
        <Button className="mt-5" onClick={onCreate}>
          <PlusIcon data-icon="inline-start" /> New workflow
        </Button>
      </div>
    </div>
  );
}
