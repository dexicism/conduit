import Link from "next/link";
import { ArrowRightIcon, BotIcon, GitBranchIcon, MessageSquareTextIcon, WebhookIcon } from "lucide-react";
import { Logo } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const features = [
  {
    icon: GitBranchIcon,
    title: "Proper logic, not just A to B",
    body: "Branch, loop, filter and merge. Grab any field from an earlier step and use it later.",
  },
  {
    icon: BotIcon,
    title: "AI is just another step",
    body: "Classify a message, pull data out of an email, or let an agent use your apps. Runs on a local model, so it's free.",
  },
  {
    icon: MessageSquareTextIcon,
    title: "Or just describe it",
    body: "Type what you want and the builder sketches the workflow on the canvas. Then you fix it up.",
  },
  {
    icon: WebhookIcon,
    title: "Lots of ways to kick things off",
    body: "Webhooks, schedules, forms, a chat page, Telegram messages. Test in the editor, publish when it works.",
  },
];

export default async function HomePage() {
  const session = await getSession();
  const ctaHref = session ? "/app/workflows" : "/login";
  const ctaLabel = session ? "Open your workflows" : "Get started";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1">
          <ThemeToggle />
          <Link href={ctaHref} className={buttonVariants({ variant: session ? "default" : "outline", size: "sm" })}>
            {session ? "Dashboard" : "Sign in"}
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="bg-dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
          <div className="relative mx-auto max-w-3xl px-4 pt-20 pb-24 text-center sm:px-6 sm:pt-28">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
              <span className="size-1.5 rounded-full bg-signal" />
              Free, self-hosted, runs on your laptop
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
              Hook your apps together.
              <br />
              <span className="text-primary">Stop doing the boring stuff by hand.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
              Drag a few steps onto a canvas, connect Telegram, Gmail or Sheets, add some AI if you want, and let it run.
              No subscriptions, no per-task pricing.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link href={ctaHref} className={cn(buttonVariants({ size: "lg" }), "h-10 px-4")}>
                {ctaLabel}
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-5">
              <f.icon className="mb-4 size-5 text-primary" aria-hidden />
              <h2 className="font-medium">{f.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© {new Date().getFullYear()} Conduit</span>
          <span>Made because I got tired of paying for Zapier.</span>
        </div>
      </footer>
    </div>
  );
}
