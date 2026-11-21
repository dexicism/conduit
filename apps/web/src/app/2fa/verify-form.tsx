"use client";

import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function VerifyForm({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const res = await fetch("/api/account/2fa/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
        if (res.ok) {
          router.replace(next);
          router.refresh();
          return;
        }
        setError((await res.json().catch(() => null))?.message ?? "That code isn't right");
        setPending(false);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="code">Code</Label>
        <Input id="code" autoFocus autoComplete="one-time-code" inputMode="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || code.trim().length < 6}>
        {pending && <Loader2Icon className="animate-spin" />}
        Verify
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={async () => {
          await authClient.signOut();
          router.replace("/login");
        }}
      >
        Sign out
      </Button>
    </form>
  );
}
