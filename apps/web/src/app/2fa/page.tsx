import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { getSession } from "@/lib/session";
import { sessionNeedsTwoFactor } from "@/lib/two-factor";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Two-step verification" };
export const dynamic = "force-dynamic";

function safeNext(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/app/workflows";
}

export default async function TwoFactorPage(props: PageProps<"/2fa">) {
  const next = safeNext((await props.searchParams).next);
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!(await sessionNeedsTwoFactor(session.user.id, session.session.id))) redirect(next);
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-sm content-center gap-6 px-4 py-12">
      <Logo href="/" />
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">Two-step verification</h1>
        <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app for {session.user.email}, or a recovery code.</p>
      </div>
      <VerifyForm next={next} />
    </main>
  );
}
