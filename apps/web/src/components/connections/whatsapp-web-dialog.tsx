"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, CopyIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CredentialView } from "@/lib/app-info";

interface LinkState {
  status: "idle" | "starting" | "qr" | "open" | "reconnecting" | "logged_out";
  phone: string | null;
  name: string | null;
  error: string | null;
  groups: Array<{ id: string; name: string; members: number }>;
  workerRunning: boolean;
  qrImage: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

/** Linking a phone by QR code (like WhatsApp Web), and its status once linked. */
export function WhatsappWebDialog({ cred, autoLink, onClose }: { cred: CredentialView | null; autoLink?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const id = cred?.id;
  const q = useQuery({
    queryKey: ["whatsapp-web", id],
    queryFn: () => call<LinkState>(`/api/credentials/${id}/whatsapp-web`),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === "open" ? 10_000 : 1500),
  });
  const act = useMutation({
    mutationFn: (action: "link" | "unlink") => call(`/api/credentials/${id}/whatsapp-web`, { method: "POST", body: JSON.stringify({ action }) }),
    onSuccess: (_d, action) => {
      void qc.invalidateQueries({ queryKey: ["whatsapp-web", id] });
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      if (action === "unlink") toast.success("Phone unlinked");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // A brand-new number: show the QR code straight away.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !autoLink || started.current === id) return;
    started.current = id;
    act.mutate("link");
  }, [id, autoLink, act]);

  // Tell the list when it connects.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (q.data?.status === "open" && !wasOpen.current) {
      wasOpen.current = true;
      void qc.invalidateQueries({ queryKey: ["credentials"] });
    }
  }, [q.data?.status, qc]);

  const s = q.data;
  return (
    <Dialog open={cred !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cred?.label ?? "WhatsApp"}</DialogTitle>
          <DialogDescription>Linked like WhatsApp Web: Conduit reads and sends messages as this number while it&apos;s running.</DialogDescription>
        </DialogHeader>

        {!s ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2Icon className="animate-spin text-muted-foreground" />
          </div>
        ) : s.status === "open" ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2Icon className="size-4 text-success" aria-hidden /> Linked{s.phone ? ` as +${s.phone}` : ""}
              {s.name ? ` (${s.name})` : ""}
            </p>
            {s.groups.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">Groups ({s.groups.length}). Use a chat id as the &ldquo;To&rdquo; of a send step.</p>
                <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm" aria-label="Groups">
                  {s.groups.map((g) => (
                    <li key={g.id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      <span className="text-xs text-muted-foreground">{g.members}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Copy chat id of ${g.name}`}
                        onClick={() => void navigator.clipboard.writeText(g.id).then(() => toast.success("Chat id copied"))}
                      >
                        <CopyIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : s.status === "qr" && s.qrImage ? (
          <div className="grid justify-items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made on the server */}
            <img src={s.qrImage} alt="QR code to link WhatsApp" width={240} height={240} className="rounded-lg bg-white p-2" data-testid="whatsapp-qr" />
            <ol className="list-decimal pl-5 text-sm text-muted-foreground">
              <li>Open WhatsApp on the phone with this number.</li>
              <li>Settings, Linked devices, Link a device.</li>
              <li>Scan this code. It refreshes by itself.</li>
            </ol>
          </div>
        ) : s.status === "starting" || s.status === "reconnecting" ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="animate-spin" />
            {s.status === "starting" ? (s.workerRunning ? "Getting a QR code…" : "Waiting for Conduit's worker…") : "Reconnecting to WhatsApp…"}
          </div>
        ) : (
          <div className="grid gap-3">
            {s.error && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden /> {s.error}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {s.status === "logged_out" ? "This number was logged out on the phone." : "Not linked yet."} Press Link phone, then scan the QR code with WhatsApp on that phone.
            </p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          This isn&apos;t Meta&apos;s official API. WhatsApp can ban numbers it thinks are bots, so keep it human: moderate volume, and don&apos;t message lots of strangers first.
        </p>
        <DialogFooter>
          {s?.status === "open" || s?.status === "reconnecting" ? (
            <Button variant="outline" disabled={act.isPending} onClick={() => act.mutate("unlink")}>
              Unlink phone
            </Button>
          ) : (
            s?.status !== "qr" &&
            s?.status !== "starting" && (
              <Button disabled={act.isPending} onClick={() => act.mutate("link")}>
                {act.isPending && <Loader2Icon className="animate-spin" />} Link phone
              </Button>
            )
          )}
          <Button variant={s?.status === "open" ? "default" : "ghost"} onClick={onClose}>
            {s?.status === "open" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
