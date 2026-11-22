"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { BotIcon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, type TemplateCard } from "@/lib/api-client";

function whyNot(t: TemplateCard): string | null {
  if (!t.unavailable.length) return null;
  if (t.unavailable.includes("ai")) return "Needs an AI model. Set AI_PROVIDER=ollama (free) first.";
  const names = t.apps.filter((a) => t.unavailable.includes(a.id)).map((a) => a.name);
  return `${names.join(" and ")} ${names.length === 1 ? "isn't" : "aren't"} set up on this server yet.`;
}

/** Pick a ready-made workflow; it opens in the editor so you can plug in your accounts. */
export function TemplatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates(), enabled: open, staleTime: 60_000 });
  const use = useMutation({
    mutationFn: (id: string) => api.createFromTemplate(id),
    onSuccess: (wf) => {
      onOpenChange(false);
      toast.success("Created. Pick your accounts in the highlighted steps, then test it.");
      router.push(`/app/workflows/${wf.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Start from a template</DialogTitle>
          <DialogDescription>Ready-made workflows. You get your own copy to change however you like.</DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Templates">
            {q.data.templates.map((t) => {
              const blocked = whyNot(t);
              return (
                <li key={t.id} className="flex flex-col rounded-xl border bg-card p-4">
                  <p className="font-medium">{t.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {t.needsAi && (
                      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        <BotIcon className="size-3" aria-hidden /> AI
                      </span>
                    )}
                    {t.apps.map((a) => (
                      <span key={a.id} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {a.name}
                      </span>
                    ))}
                    <span className="px-1 py-0.5 text-xs text-muted-foreground">{t.steps} steps</span>
                  </div>
                  {t.setup && <p className="mt-3 text-xs text-muted-foreground">After creating: {t.setup}</p>}
                  {blocked && <p className="mt-3 text-xs text-destructive">{blocked}</p>}
                  <div className="mt-auto pt-4">
                    <Button size="sm" disabled={Boolean(blocked) || use.isPending} onClick={() => use.mutate(t.id)} aria-label={`Use ${t.name}`}>
                      {use.isPending && use.variables === t.id && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
                      Use this
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
