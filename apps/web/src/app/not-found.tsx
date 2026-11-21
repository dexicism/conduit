import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">We couldn&apos;t find that page</h1>
      <p className="mt-2 text-sm text-muted-foreground">It may have been deleted, or the link is wrong.</p>
      <Link href="/app/workflows" className={buttonVariants({ className: "mt-6" })}>
        Go to workflows
      </Link>
    </main>
  );
}
