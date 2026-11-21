"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, KeyRoundIcon, Loader2Icon, SendIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { relativeTime } from "@/lib/format";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

const SCOPE_LABEL: Record<string, string> = {
  "workflows:read": "Read workflows",
  "workflows:write": "Edit workflow drafts",
  "executions:read": "Read runs",
  "executions:run": "Run published workflows",
};

function ShownOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <div role="status" className="grid gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3">
      <p className="text-sm font-medium">{label}. Copy it now: it won&apos;t be shown again.</p>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy"
          onClick={async () => {
            await navigator.clipboard.writeText(value).catch(() => undefined);
            toast.success("Copied");
          }}
        >
          <CopyIcon />
        </Button>
      </div>
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function DeveloperSettings() {
  const qc = useQueryClient();
  const keysQ = useQuery({ queryKey: ["api-keys"], queryFn: () => call<{ keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null }>; scopes: string[] }>("/api/workspace/api-keys") });
  const hooksQ = useQuery({
    queryKey: ["webhooks"],
    queryFn: () =>
      call<{ webhooks: Array<{ id: string; url: string; events: string[]; recent: Array<{ id: string; status: string; lastStatus: number | null; lastError: string | null; createdAt: string }> }>; events: string[] }>(
        "/api/workspace/webhooks",
      ),
  });
  const [keyName, setKeyName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["workflows:read", "executions:read", "executions:run"]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const onError = (e: Error) => toast.error(e.message);

  const createKey = useMutation({
    mutationFn: () => call<{ key: string }>("/api/workspace/api-keys", { method: "POST", body: JSON.stringify({ name: keyName, scopes }) }),
    onSuccess: (r) => {
      setNewKey(r.key);
      setKeyName("");
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError,
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => call(`/api/workspace/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api-keys"] }),
    onError,
  });
  const createHook = useMutation({
    mutationFn: () => call<{ secret: string }>("/api/workspace/webhooks", { method: "POST", body: JSON.stringify({ url: hookUrl, events: ["execution.completed", "execution.failed"] }) }),
    onSuccess: (r) => {
      setNewSecret(r.secret);
      setHookUrl("");
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError,
  });
  const testHook = useMutation({
    mutationFn: (id: string) => call<{ delivery: { status: string; lastError: string | null } | null }>(`/api/workspace/webhooks/${id}/test`, { method: "POST" }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
      if (r.delivery?.status === "delivered") toast.success("Test event delivered");
      else toast.error(r.delivery?.lastError ?? "The endpoint didn't accept the test event");
    },
    onError,
  });
  const removeHook = useMutation({
    mutationFn: (id: string) => call(`/api/workspace/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["webhooks"] }),
    onError,
  });

  return (
    <>
      <section aria-labelledby="keys-h" className="grid gap-3">
        <div>
          <h2 id="keys-h" className="font-medium">
            API keys
          </h2>
          <p className="text-sm text-muted-foreground">
            For the REST API (<code className="text-xs">/api/v1</code>) and MCP clients. Send <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>
        {newKey && <ShownOnce label="New API key" value={newKey} onDone={() => setNewKey(null)} />}
        <form
          aria-label="Create an API key"
          className="grid gap-3 rounded-xl border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            createKey.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">Key name</Label>
            <Input id="key-name" value={keyName} maxLength={80} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Zapier, CI" />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Permissions</legend>
            {(keysQ.data?.scopes ?? Object.keys(SCOPE_LABEL)).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                {SCOPE_LABEL[s] ?? s}
              </label>
            ))}
          </fieldset>
          <div>
            <Button type="submit" disabled={createKey.isPending || !keyName.trim() || !scopes.length}>
              {createKey.isPending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon data-icon="inline-start" />}
              Create key
            </Button>
          </div>
        </form>
        {keysQ.data && keysQ.data.keys.length > 0 && (
          <ul className="grid divide-y rounded-xl border" aria-label="API keys">
            {keysQ.data.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>cdt_{k.prefix}_…</code> · {k.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(", ")} · {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                <Button variant="ghost" size="sm" aria-label={`Revoke ${k.name}`} onClick={() => revokeKey.mutate(k.id)}>
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hooks-h" className="grid gap-3">
        <div>
          <h2 id="hooks-h" className="font-medium">
            Webhooks
          </h2>
          <p className="text-sm text-muted-foreground">
            We POST a signed JSON event to these URLs when a live run succeeds or fails. Verify the <code className="text-xs">Conduit-Signature</code> header:
            HMAC-SHA256 of <code className="text-xs">t.body</code> with your signing secret.
          </p>
        </div>
        {newSecret && <ShownOnce label="Signing secret" value={newSecret} onDone={() => setNewSecret(null)} />}
        <form
          aria-label="Add a webhook"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            createHook.mutate();
          }}
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="hook-url">Endpoint URL</Label>
            <Input id="hook-url" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://example.com/conduit-events" />
          </div>
          <Button type="submit" disabled={createHook.isPending || !hookUrl.trim()}>
            {createHook.isPending ? <Loader2Icon className="animate-spin" /> : <WebhookIcon data-icon="inline-start" />}
            Add webhook
          </Button>
        </form>
        {hooksQ.data && hooksQ.data.webhooks.length > 0 && (
          <ul className="grid divide-y rounded-xl border" aria-label="Webhooks">
            {hooksQ.data.webhooks.map((h) => (
              <li key={h.id} className="grid gap-1 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</p>
                  <Button variant="ghost" size="sm" aria-label={`Send a test event to ${h.url}`} disabled={testHook.isPending} onClick={() => testHook.mutate(h.id)}>
                    {testHook.isPending && testHook.variables === h.id ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${h.url}`} onClick={() => removeHook.mutate(h.id)}>
                    <Trash2Icon />
                  </Button>
                </div>
                {h.recent[0] && (
                  <p className="text-xs text-muted-foreground" data-testid="webhook-last">
                    Last delivery: {h.recent[0].status}
                    {h.recent[0].lastStatus ? ` (${h.recent[0].lastStatus})` : ""}
                    {h.recent[0].lastError ? ` · ${h.recent[0].lastError}` : ""} · {relativeTime(h.recent[0].createdAt)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
