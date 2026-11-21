import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { emailMode, oauthProviders } from "@/lib/env";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/** Only same-origin relative paths are allowed as post-login destinations. */
function safeNext(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/app/workflows";
  return v;
}

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await getSession()) redirect(next);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden overflow-hidden border-r bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div className="bg-dots pointer-events-none absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <Logo className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            Every repetitive task is a workflow waiting to happen.
          </h2>
          <ol className="mt-8 space-y-3 text-sm">
            {["A form is submitted", "AI sorts it and drafts a reply", "The right person gets pinged"].map((s, i) => (
              <li key={s} className="flex items-center gap-3 rounded-lg border bg-card/70 px-4 py-3 backdrop-blur">
                <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-xs font-medium text-primary">
                  {i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <p className="relative text-xs text-muted-foreground">Passwordless by design. We email you a code.</p>
      </aside>

      <main className="flex flex-col px-4 py-6 sm:px-10">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <LoginForm
            next={next}
            google={oauthProviders.google}
            github={oauthProviders.github}
            devOutbox={emailMode === "dev-outbox"}
          />
        </div>
      </main>
    </div>
  );
}
