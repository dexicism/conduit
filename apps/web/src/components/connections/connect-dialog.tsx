"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/editor/param-fields";
import { api, ClientApiError, errorMessage } from "@/lib/api-client";
import type { AppInfo, CredentialView } from "@/lib/app-info";

/** Message the OAuth "done" tab posts back to the tab that opened it. */
export interface OAuthDoneMessage {
  type: "conduit:oauth-done";
  id?: string;
  app?: string;
  error?: string;
}

interface Props {
  app: AppInfo | null;
  onOpenChange: (open: boolean) => void;
  onConnected: (cred: Pick<CredentialView, "id" | "app" | "label">) => void;
}

export function ConnectDialog({ app, onOpenChange, onConnected }: Props) {
  return (
    <Dialog open={app !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{app && <ConnectForm app={app} onDone={onConnected} onCancel={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ConnectForm({ app, onDone, onCancel }: { app: AppInfo; onDone: Props["onConnected"]; onCancel: () => void }) {
  const qc = useQueryClient();
  const ids = { label: useId(), err: useId() };
  const fields = app.auth.kind === "fields" ? app.auth.fields : [];
  const [label, setLabel] = useState(app.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.default !== undefined ? String(f.default) : ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);
  const finished = useRef(false);

  // OAuth: the sign-in runs in a new tab, which posts back when it's done.
  useEffect(() => {
    if (!waitingForSignIn) return;
    const onMessage = (e: MessageEvent<OAuthDoneMessage>) => {
      if (e.origin !== window.location.origin || e.data?.type !== "conduit:oauth-done" || finished.current) return;
      setWaitingForSignIn(false);
      if (e.data.error || !e.data.id) {
        setFormError(e.data.error ?? "The sign-in didn't finish.");
        return;
      }
      finished.current = true;
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      onDone({ id: e.data.id, app: app.id, label });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [waitingForSignIn, app.id, label, onDone, qc]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!label.trim()) {
      setErrors({ _label: "Give the account a name" });
      return;
    }
    if (app.auth.kind === "oauth2") {
      setWaitingForSignIn(true);
      window.open(`/api/credentials/oauth/${app.id}/start?label=${encodeURIComponent(label.trim())}`, "_blank");
      return;
    }
    const missing = Object.fromEntries(fields.filter((f) => f.required && !values[f.name]?.trim()).map((f) => [f.name, `${f.label} is required`]));
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setPending(true);
    try {
      const cred = await api.createCredential({ app: app.id, label: label.trim(), values });
      await qc.invalidateQueries({ queryKey: ["credentials"] });
      onDone(cred);
    } catch (err) {
      if (err instanceof ClientApiError && err.body.issues?.length) {
        setErrors(Object.fromEntries(err.body.issues.map((i) => [i.path.replace(/^values\./, ""), i.message])));
      }
      setFormError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4" aria-label={`Connect ${app.name}`}>
      <DialogHeader>
        <DialogTitle>Connect {app.name}</DialogTitle>
        <DialogDescription>{app.help ?? app.description}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.label}>Account name</Label>
        <Input id={ids.label} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-invalid={errors._label ? true : undefined} />
        {errors._label && <p className="text-xs text-destructive">{errors._label}</p>}
      </div>
      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name] ?? ""} error={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      ))}
      {app.auth.kind === "oauth2" && (
        <p className="text-sm text-muted-foreground">
          {waitingForSignIn ? "Finish signing in in the new tab. This window updates when you're done." : `You'll sign in to ${app.name} in a new tab and approve access.`}
        </p>
      )}
      {formError && (
        <p id={ids.err} role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {app.auth.kind === "oauth2" ? (
            <>
              {waitingForSignIn ? "Open sign-in again" : `Sign in with ${app.name}`}
              <ExternalLinkIcon />
            </>
          ) : pending ? (
            "Checking…"
          ) : (
            "Connect"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: Extract<AppInfo["auth"], { kind: "fields" }>["fields"][number];
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-muted-foreground">*</span>}
      </Label>
      {field.kind === "select" ? (
        <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          id={id}
          type={field.kind === "secret" ? "password" : "text"}
          inputMode={field.kind === "number" ? "numeric" : undefined}
          autoComplete={field.kind === "secret" ? "new-password" : "off"}
          spellCheck={false}
          value={value}
          placeholder={field.placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}
