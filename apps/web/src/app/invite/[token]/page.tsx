import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { describeInvitation } from "@/lib/teams";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = { title: "Join a team" };

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const [invite, session] = await Promise.all([describeInvitation(token), getSession()]);
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center gap-6 px-4 py-12">
      <Logo href="/" />
      {!invite ? (
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold">This invitation isn&apos;t valid</h1>
          <p className="text-sm text-muted-foreground">It expired, was cancelled, or was already used. Ask for a new one.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold">Join {invite.workspaceName}</h1>
            <p className="text-sm text-muted-foreground">
              You&apos;re invited as {invite.role}. The invitation is for {invite.email}.
            </p>
          </div>
          {!session ? (
            <Button nativeButton={false} render={<Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} />}>
              Sign in to accept
            </Button>
          ) : session.user.email.toLowerCase() !== invite.email ? (
            <p role="alert" className="text-sm text-destructive">
              You&apos;re signed in as {session.user.email}. Sign out and sign in with {invite.email} to accept.
            </p>
          ) : (
            <AcceptInvite token={token} />
          )}
        </div>
      )}
    </main>
  );
}
