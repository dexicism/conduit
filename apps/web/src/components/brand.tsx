import Link from "next/link";
import { cn } from "@/lib/utils";

/** Conduit mark: two nodes joined by a curved edge. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7", className)}>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path d="M10 21c0-6 12-4 12-10" fill="none" strokeWidth="2.4" strokeLinecap="round" className="stroke-primary-foreground" />
      <circle cx="10" cy="21.5" r="3" className="fill-signal" />
      <circle cx="22" cy="10.5" r="3" className="fill-primary-foreground" />
    </svg>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span className="text-[15px]">Conduit</span>
    </Link>
  );
}
