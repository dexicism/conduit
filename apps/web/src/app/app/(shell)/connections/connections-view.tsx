"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, CopyIcon, InboxIcon, KeyRoundIcon, Loader2Icon, PencilIcon, PlugIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectDialog, type OAuthDoneMessage } from "@/components/connections/connect-dialog";
import { ICONS } from "@/components/editor/node-visuals";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ClientApiError, errorMessage } from "@/lib/api-client";
import type { AppInfo, CredentialView } from "@/lib/app-info";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AppIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? CircleHelp;
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-300", className)}>
      <Icon className="size-4.5" aria-hidden />
    </span>
  );
}

export function ConnectionsView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["credentials", "all"], queryFn: () => api.listCredentials() });
  const [connecting, setConnecting] = useState<AppInfo | null>(null);
  const [renaming, setRenaming] = useState<CredentialView | null>(null);
  const [editingKeys, setEditingKeys] = useState<CredentialView | null>(null);
  const [whatsappSetup, setWhatsappSetup] = useState<CredentialView | null>(null);
  const [removing, setRemoving] = useState<{ cred: CredentialView; inUse?: string } | null>(null);

  const [reconnecting, setReconnecting] = useState<string | null>(null);

  // The sign-in tab reports back when a reconnect finishes.
  useEffect(() => {
    if (!reconnecting) return;
    const onMessage = (e: MessageEvent<OAuthDoneMessage>) => {
      if (e.origin !== window.location.origin || e.data?.type !== "conduit:oauth-done") return;
      setReconnecting(null);
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      if (e.data.error) toast.error(e.data.error);
      else toast.success("Reconnected");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reconnecting, qc]);

  const apps = q.data?.apps ?? [];
  const byId = new Map(apps.map((a) => [a.id, a]));

  const test = useMutation({
    mutationFn: (id: string) => api.testCredential(id),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      if (c.status === "ok") toast.success(`${c.label} works`);
      else toast.error(c.lastError ?? "The account didn't work");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.deleteCredential(id, force),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      toast.success("Account removed");
      setRemoving(null);
    },
    onError: (e) => {
      if (e instanceof ClientApiError && e.body.error === "in_use" && removing) setRemoving({ ...removing, inUse: e.body.message });
      else toast.error(errorMessage(e));
    },
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connected apps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Accounts your workflows use. Secrets are encrypted and never shown again after you save them.
        </p>
      </div>

      <section aria-labelledby="accounts-h" className="mt-6">
        <h2 id="accounts-h" className="text-sm font-medium text-muted-foreground">
          Your accounts
        </h2>
        {q.isPending ? (
          <div className="mt-3 grid gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : q.isError ? (
          <p className="mt-3 text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : q.data.credentials.length === 0 ? (
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            <PlugIcon className="size-5 shrink-0" aria-hidden />
            No accounts yet. Connect an app below, or from any step that needs one.
          </div>
        ) : (
          <ul className="mt-3 grid gap-2" aria-label="Accounts">
            {q.data.credentials.map((c) => {
              const app = byId.get(c.app);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 sm:flex-nowrap">
                  <AppIcon icon={app?.icon ?? "CircleHelp"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {app?.name ?? c.app}
                      {c.account ? ` · ${c.account}` : ""}
                      {c.testedAt ? ` · checked ${relativeTime(c.testedAt)}` : ""}
                    </p>
                    {c.status === "error" && c.lastError && (
                      <p className="mt-0.5 text-xs text-destructive" data-testid="credential-error">
                        {c.lastError}
                      </p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
                    )}
                    data-testid="credential-status"
                  >
                    <span className={cn("size-1.5 rounded-full", c.status === "ok" ? "bg-success" : "bg-destructive")} aria-hidden />
                    {c.status === "ok" ? "Working" : "Needs attention"}
                  </span>
                  <div className="flex gap-1">
                    {app?.auth.kind === "oauth2" && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Reconnect ${c.label}`}
                        title="Sign in again, e.g. to grant new permissions"
                        disabled={reconnecting === c.id}
                        onClick={() => {
                          setReconnecting(c.id);
                          window.open(`/api/credentials/oauth/${c.app}/start?reconnect=${c.id}`, "_blank");
                        }}
                      >
                        {reconnecting === c.id ? <Loader2Icon className="animate-spin" /> : null}
                        Reconnect
                      </Button>
                    )}
                    {c.app === "whatsapp" && (
                      <Button variant="outline" size="sm" onClick={() => setWhatsappSetup(c)}>
                        <InboxIcon data-icon="inline-start" /> Receive messages
                      </Button>
                    )}
                    {app?.auth.kind === "fields" && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Update keys for ${c.label}`} title="Update keys" onClick={() => setEditingKeys(c)}>
                        <KeyRoundIcon />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" aria-label={`Check ${c.label}`} disabled={test.isPending} onClick={() => test.mutate(c.id)}>
                      {test.isPending && test.variables === c.id ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Rename ${c.label}`} onClick={() => setRenaming(c)}>
                      <PencilIcon />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.label}`} onClick={() => setRemoving({ cred: c })}>
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="apps-h" className="mt-8">
        <h2 id="apps-h" className="text-sm font-medium text-muted-foreground">
          Connect an app
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Apps">
          {apps.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setConnecting(a)}
                className="flex h-full w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <AppIcon icon={a.icon} />
                <span className="min-w-0">
                  <span className="block font-medium">{a.name}</span>
                  <span className="block text-xs text-muted-foreground">{a.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <ConnectDialog
        app={connecting}
        onOpenChange={(o) => !o && setConnecting(null)}
        onConnected={(c) => {
          setConnecting(null);
          toast.success(`${c.label} connected`);
        }}
      />
      <ConnectDialog
        app={editingKeys ? (byId.get(editingKeys.app) ?? null) : null}
        editing={editingKeys}
        onOpenChange={(o) => !o && setEditingKeys(null)}
        onConnected={(c) => {
          setEditingKeys(null);
          toast.success(`${c.label} updated`);
        }}
      />
      <WhatsappSetupDialog cred={whatsappSetup} publicUrl={q.data?.publicUrl ?? ""} onClose={() => setWhatsappSetup(null)} />
      <RenameDialog cred={renaming} onClose={() => setRenaming(null)} />
      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && !remove.isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.cred.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.inUse ?? "Steps that use this account will stop working until you choose another one. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate({ id: removing.cred.id, force: Boolean(removing.inUse) })}
            >
              {remove.isPending && <Loader2Icon className="animate-spin" />}
              {removing?.inUse ? "Remove anyway" : "Remove account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 text-xs" title={value}>
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success("Copied"))}
        >
          <CopyIcon />
        </Button>
      </div>
    </div>
  );
}

/** What to paste into Meta so messages to the number start workflows. */
function WhatsappSetupDialog({ cred, publicUrl, onClose }: { cred: CredentialView | null; publicUrl: string; onClose: () => void }) {
  const url = cred ? `${publicUrl}/hook/whatsapp/${cred.id}` : "";
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicUrl);
  return (
    <Dialog open={cred !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Receive WhatsApp messages</DialogTitle>
          <DialogDescription>Meta sends each new message to this address, and a workflow with a WhatsApp trigger picks it up.</DialogDescription>
        </DialogHeader>
        {local && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            This server's address is {publicUrl}, which Meta can't reach. Run <code>cloudflared tunnel --url http://localhost:3000</code>, put the
            address it prints in <code>PUBLIC_URL</code>, restart Conduit and open this again.
          </p>
        )}
        <CopyRow label="Callback URL" value={url} />
        <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>Update this connection's keys with your App secret (Meta app: App settings, Basic) and a verify token you make up.</li>
          <li>In Meta for Developers, open WhatsApp, Configuration. Paste the callback URL and the same verify token, then Verify and save.</li>
          <li>Under Webhook fields, subscribe to <strong>messages</strong>.</li>
          <li>Publish a workflow that starts with "WhatsApp message", or use the "AI WhatsApp assistant" template.</li>
        </ol>
        <p className="text-xs text-muted-foreground">Meta's free test number can message up to 5 numbers you verify. Replies within 24 hours of a customer's message need no template.</p>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ cred, onClose }: { cred: CredentialView | null; onClose: () => void }) {
  return (
    <Dialog open={cred !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">{cred && <RenameForm cred={cred} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm({ cred, onClose }: { cred: CredentialView; onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(cred.label);
  const m = useMutation({
    mutationFn: () => api.renameCredential(cred.id, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      onClose();
    },
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename account</DialogTitle>
        <DialogDescription>Only the name changes. Steps keep using the same account.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="rename-cred">Account name</Label>
        <Input id="rename-cred" autoFocus value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        {m.isError && <p className="text-xs text-destructive">{errorMessage(m.error)}</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={m.isPending}>
          {m.isPending && <Loader2Icon className="animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
