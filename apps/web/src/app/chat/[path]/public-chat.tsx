"use client";

import { ArrowUpIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Msg {
  from: "visitor" | "bot";
  text: string;
  error?: boolean;
}

const POLL_MS = 1000;
const WAIT_MS = 180_000;

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One id per browser and chat, so the workflow (e.g. an agent's memory) can tell conversations apart. */
function sessionFor(path: string): string {
  const key = `conduit-chat-${path}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    const id = newSessionId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newSessionId();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function PublicChat({ path, title, welcomeMessage, placeholder }: { path: string; title: string; welcomeMessage: string; placeholder: string }) {
  const [messages, setMessages] = useState<Msg[]>(welcomeMessage ? [{ from: "bot", text: welcomeMessage }] : []);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [website, setWebsite] = useState("");
  const session = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  async function send() {
    const message = text.trim();
    if (!message || pending) return;
    session.current ??= sessionFor(path);
    setText("");
    setMessages((m) => [...m, { from: "visitor", text: message }]);
    setPending(true);
    const fail = (t: string) => setMessages((m) => [...m, { from: "bot", text: t, error: true }]);
    try {
      const res = await fetch(`/api/chat/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.current, message, website }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return fail(data?.message ?? "Something went wrong. Please try again.");
      if (!data?.runId) return;
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const r = await fetch(`/api/chat/${path}?run=${data.runId}&session=${session.current}`, { cache: "no-store" });
        const d = await r.json().catch(() => null);
        if (!r.ok) return fail(d?.message ?? "Something went wrong. Please try again.");
        if (d?.status === "done") {
          setMessages((m) => [...m, { from: "bot", text: d.reply ?? "(No reply)" }]);
          return;
        }
        if (d?.status === "failed") return fail("Sorry, something went wrong on our side. Please try again.");
      }
      fail("This is taking too long. Please try again.");
    } catch {
      fail("Network error. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card" aria-label={title}>
      <h1 className="border-b px-4 py-3 font-semibold">{title}</h1>
      <div role="log" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.from === "visitor" ? "justify-end" : "justify-start")}>
            <p
              data-testid={m.from === "bot" ? "chat-bot-message" : "chat-visitor-message"}
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap",
                m.from === "visitor" ? "bg-primary text-primary-foreground" : "bg-muted",
                m.error && "text-destructive",
              )}
            >
              {m.text}
            </p>
          </div>
        ))}
        {pending && (
          <div className="flex justify-start" role="status">
            <span className="flex items-center gap-2 rounded-2xl bg-muted px-3.5 py-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              Typing…
            </span>
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="hidden"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
        <Textarea
          aria-label="Message"
          rows={1}
          maxLength={4000}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-40 min-h-10 resize-none"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={pending || !text.trim()}>
          <ArrowUpIcon />
        </Button>
      </form>
    </section>
  );
}
