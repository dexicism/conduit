"use client";

import { getApp, type DynamicOptionsSource } from "@conduit/nodes";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ConnectDialog } from "@/components/connections/connect-dialog";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api-client";
import { useApps } from "./apps-context";
import { NativeSelect } from "./param-fields";

/** Picks one of the workspace's accounts for an app, or connects a new one without leaving the editor. */
export function CredentialSelect({
  id,
  app,
  value,
  onChange,
  invalid,
}: {
  id: string;
  app: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  const apps = useApps();
  const info = apps.find((a) => a.id === app);
  const [connecting, setConnecting] = useState(false);
  const q = useQuery({ queryKey: ["credentials", app], queryFn: () => api.listCredentials(app) });
  const list = q.data?.credentials ?? [];

  if (!info) {
    return <p className="text-sm text-muted-foreground">{getApp(app)?.name ?? app} isn&apos;t set up on this server.</p>;
  }
  return (
    <div className="flex gap-2">
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid ? true : undefined} disabled={q.isPending}>
        <option value="">{q.isPending ? "Loading accounts…" : list.length ? "Choose an account" : `No ${info.name} accounts yet`}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
            {c.account ? ` (${c.account})` : ""}
            {c.status === "error" ? " – needs attention" : ""}
          </option>
        ))}
        {value && !q.isPending && !list.some((c) => c.id === value) && <option value={value}>Removed account</option>}
      </NativeSelect>
      <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => setConnecting(true)}>
        <PlusIcon data-icon="inline-start" /> Connect
      </Button>
      <ConnectDialog
        app={connecting ? info : null}
        onOpenChange={(o) => !o && setConnecting(false)}
        onConnected={(c) => {
          setConnecting(false);
          onChange(c.id);
          void q.refetch();
        }}
      />
    </div>
  );
}

const SOURCE_LABEL: Record<DynamicOptionsSource, string> = {
  "slack.channels": "Show channels",
  "google.sheets": "Show sheets",
};

/** Loads live choices (e.g. Slack channels) with the step's account; clicking one fills the field. */
export function DynamicSuggestions({
  source,
  label,
  params,
  onPick,
}: {
  source: DynamicOptionsSource;
  label: string;
  params: Record<string, unknown>;
  onPick: (v: string) => void;
}) {
  const credentialId = typeof params.credential === "string" ? params.credential : "";
  const load = useMutation({ mutationFn: () => api.fieldOptions({ source, credentialId, params }) });
  if (!credentialId) return null;
  return (
    <div className="grid gap-1.5">
      <div>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => load.mutate()} disabled={load.isPending}>
          {load.isPending && <Loader2Icon className="animate-spin" />}
          {SOURCE_LABEL[source]}
        </Button>
      </div>
      {load.isError && <p className="text-xs text-destructive">{errorMessage(load.error)}</p>}
      {load.data &&
        (load.data.options.length ? (
          <ul className="flex flex-wrap gap-1" aria-label={`${label} suggestions`}>
            {load.data.options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => onPick(o.value)}
                  className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing found.</p>
        ))}
    </div>
  );
}
