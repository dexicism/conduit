import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import { emailMode, env } from "@/lib/env";
import { outboxFile, type OutboxEntry } from "@/lib/email";

export const metadata: Metadata = { title: "Local outbox" };
export const dynamic = "force-dynamic";

async function readOutbox(): Promise<OutboxEntry[]> {
  try {
    const raw = await readFile(outboxFile(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as OutboxEntry)
      .reverse()
      .slice(0, 50);
  } catch {
    return [];
  }
}

/** Development-only inbox for emails sent while no provider is configured. */
export default async function DevOutboxPage() {
  if (env.isProd || emailMode !== "dev-outbox") notFound();
  const entries = await readOutbox();
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-xl font-semibold">Local outbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Emails are written here because no email provider is configured. Newest first. Refresh to update.
      </p>
      {entries.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing sent yet.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {entries.map((e, i) => (
            <li key={i} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>To {e.to}</span>
                <time dateTime={e.sentAt}>{new Date(e.sentAt).toLocaleString()}</time>
              </div>
              <p className="mt-1 font-medium">{e.subject}</p>
              <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">{e.text}</pre>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
