import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { checkAuthorizeRequest, OAuthError } from "@/lib/mcp-oauth";
import { getSession } from "@/lib/session";
import { sessionNeedsTwoFactor } from "@/lib/two-factor";
import { listUserWorkspaces } from "@/lib/workspaces";

export const metadata: Metadata = { title: "Connect an AI assistant" };
export const dynamic = "force-dynamic";

const SCOPE_TEXT: Record<string, string> = {
  "workflows:read": "See your workflows and their steps",
  "workflows:write": "Create workflows and edit drafts (not the live versions)",
  "executions:read": "See runs and their data",
  "executions:run": "Run workflows: free test runs, and live runs that use credits",
};

export default async function AuthorizePage(props: PageProps<"/oauth/authorize">) {
  const sp = await props.searchParams;
  const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${q.toString()}`)}`);
  if (await sessionNeedsTwoFactor(session.user.id, session.session.id)) redirect(`/2fa?next=${encodeURIComponent(`/oauth/authorize?${q.toString()}`)}`);

  let request;
  let problem: string | null = null;
  try {
    request = await checkAuthorizeRequest(q);
  } catch (err) {
    problem = err instanceof OAuthError ? err.message : "This request isn't valid";
  }
  const workspaces = await listUserWorkspaces(session.user.id); // viewers can connect too, with read-only access

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center gap-6 px-4 py-12">
      <Logo href="/" />
      {!request ? (
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold">Can&apos;t connect this app</h1>
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
          <Link href="/app/workflows" className="text-sm underline underline-offset-2">
            Back to Conduit
          </Link>
        </div>
      ) : (
        <form method="post" action="/api/oauth/authorize" className="grid gap-5" aria-label="Authorize access">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold">Allow “{request.client.name}” to use Conduit?</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {session.user.email}. It will be able to:
            </p>
          </div>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {request.scopes.map((s) => (
              <li key={s}>{SCOPE_TEXT[s] ?? s}</li>
            ))}
          </ul>
          <div className="grid gap-1.5">
            <label htmlFor="ws" className="text-sm font-medium">
              Workspace
            </label>
            <select id="ws" name="workspaceId" className="h-9 rounded-lg border bg-transparent px-2 text-sm">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.role})
                </option>
              ))}
            </select>
          </div>
          {[...q.entries()].map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <p className="text-xs text-muted-foreground">After you choose, you return to {new URL(request.redirectUri).origin}.</p>
          <div className="flex gap-2">
            <Button type="submit" name="decision" value="approve">
              Allow
            </Button>
            <Button type="submit" name="decision" value="deny" variant="outline">
              Deny
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}
