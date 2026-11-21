"use client";

import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OAuthDoneMessage } from "@/components/connections/connect-dialog";
import { Button } from "@/components/ui/button";

/** Landing tab after an OAuth sign-in: tells the tab that started it, then tries to close itself. */
export function OAuthDone({ id, app, error }: { id?: string; app?: string; error?: string }) {
  const [hasOpener, setHasOpener] = useState(false);
  const sent = useRef(false);
  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener || sent.current) return;
    sent.current = true;
    const msg: OAuthDoneMessage = { type: "conduit:oauth-done", id, app, error: id ? undefined : (error ?? "The sign-in didn't finish.") };
    opener.postMessage(msg, window.location.origin);
    setHasOpener(true);
    if (id) window.setTimeout(() => window.close(), 600);
  }, [id, app, error]);

  const ok = Boolean(id);
  return (
    <div className="mx-auto grid w-full max-w-md gap-4 px-4 py-16 text-center">
      {ok ? <CheckCircle2Icon className="mx-auto size-10 text-success" aria-hidden /> : <CircleAlertIcon className="mx-auto size-10 text-destructive" aria-hidden />}
      <h1 className="text-xl font-semibold">{ok ? "Account connected" : "Couldn't connect the account"}</h1>
      <p className="text-sm text-muted-foreground">
        {ok ? (hasOpener ? "You can close this tab and continue where you were." : "It's ready to use in your workflows.") : (error ?? "The sign-in didn't finish.")}
      </p>
      <Button nativeButton={false} render={<Link href="/app/connections" />} variant="outline" className="mx-auto">
        Go to Connected apps
      </Button>
    </div>
  );
}
