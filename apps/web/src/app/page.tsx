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
    title: "A canvas for real logic",
    body: "Branch, loop, filter and merge. Map any field from an earlier step into the next one.",
  },
  {
    icon: BotIcon,
    title: "AI as a step, not a sidecar",
    body: "Drop in agents that reason, classify and generate, with the tools you hand them.",
  },
  {
    icon: MessageSquareTextIcon,
    title: "Describe it, then refine it",
    body: "Tell the builder what you need. It drafts the workflow on your canvas for you to review.",
  },
  {
    icon: WebhookIcon,
    title: "Triggers that just work",
    body: "Webhooks, schedules and app events. Test freely in the editor, publish when ready.",
  },
];

export default async function HomePage() {
  const session = await getSession();
  const ctaHref = session ? "/app/workflows" : "/login";
  const ctaLabel = session ? "Open your workflows" : "Start building";

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
              Workflow automation with AI built in
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
              Wire your apps together.
              <br />
              <span className="text-primary">Let the busywork run itself.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
              Conduit connects the tools you already use and adds AI where it helps. Build visually, or describe the
              job and refine the draft.
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
          <span>Built for teams who would rather not copy and paste.</span>
        </div>
      </footer>
    </div>
  );
}
