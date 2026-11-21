"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

/** Two-step verification for the signed-in user (applies to every workspace). */
export function SecuritySettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["2fa"], queryFn: () => call<{ enabled: boolean; recoveryCodesLeft: number }>("/api/account/2fa") });
  const [setup, setSetup] = useState<{ key: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ["2fa"] });

  const begin = useMutation({ mutationFn: () => call<{ key: string; qr: string }>("/api/account/2fa/setup", {}), onSuccess: setSetup, onError: (e: Error) => toast.error(e.message) });
  const enable = useMutation({
    mutationFn: () => call<{ recoveryCodes: string[] }>("/api/account/2fa/enable", { code }),
    onSuccess: (r) => {
      setRecovery(r.recoveryCodes);
      setSetup(null);
      setCode("");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const disable = useMutation({
    mutationFn: () => call("/api/account/2fa/disable", { code }),
    onSuccess: () => {
      setCode("");
      toast.success("Two-step verification is off");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section aria-labelledby="sec-h" className="grid gap-3">
      <div>
        <h2 id="sec-h" className="font-medium">
          Two-step verification
        </h2>
        <p className="text-sm text-muted-foreground">After signing in, also ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…).</p>
      </div>
      {recovery && (
        <div role="status" className="grid gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3">
          <p className="text-sm font-medium">Recovery codes. Each works once if you lose your phone. Save them now: they won&apos;t be shown again.</p>
          <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setRecovery(null)}>
              I saved them
            </Button>
          </div>
        </div>
      )}
      {status.data?.enabled ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <p className="flex items-center gap-2 text-sm sm:mr-auto">
            <ShieldCheckIcon className="size-4 text-success" aria-hidden /> On · {status.data.recoveryCodesLeft} recovery codes left
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="off-code">Code to turn off</Label>
            <Input id="off-code" value={code} onChange={(e) => setCode(e.target.value)} className="sm:w-40" />
          </div>
          <Button type="submit" variant="outline" disabled={disable.isPending || code.trim().length < 6}>
            Turn off
          </Button>
        </form>
      ) : setup ? (
        <form
          className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[auto_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL QR code */}
          <img src={setup.qr} alt="QR code to scan with your authenticator app" width={180} height={180} className="rounded bg-white" />
          <div className="grid content-start gap-2">
            <p className="text-sm">Scan the code, or enter this key in your app:</p>
            <code data-testid="totp-key" className="break-all rounded bg-muted px-2 py-1 text-xs">
              {setup.key}
            </code>
            <Label htmlFor="setup-code">Code from the app</Label>
            <Input id="setup-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <div>
              <Button type="submit" disabled={enable.isPending || code.trim().length !== 6}>
                {enable.isPending && <Loader2Icon className="animate-spin" />}
                Turn on
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => begin.mutate()} disabled={begin.isPending || status.isPending}>
            {begin.isPending && <Loader2Icon className="animate-spin" />}
            Set up two-step verification
          </Button>
        </div>
      )}
    </section>
  );
}
