import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUTBOX = resolve(__dirname, "..", ".data", "outbox-e2e.jsonl");

export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
}

/** Polls the dev outbox for the newest sign-in code sent to `email` after `since`. */
export async function readCode(email: string, since: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(OUTBOX, "utf8")).split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        const e = JSON.parse(line) as { to: string; subject: string; sentAt: string };
        if (e.to === email && new Date(e.sentAt).getTime() >= since - 1000) {
          const m = e.subject.match(/\b(\d{6})\b/);
          if (m) return m[1]!;
        }
      }
    } catch {
      /* file not created yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in code found for ${email}`);
}

export async function requestCode(page: Page, email: string): Promise<number> {
  const since = Date.now();
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  return since;
}

export async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("Sign-in code").fill(code);
}

/** Full passwordless sign-in through the UI. Ends on the post-login destination. */
export async function signIn(page: Page, email: string, next = "/app/workflows"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const since = await requestCode(page, email);
  await enterCode(page, await readCode(email, since));
  await page.waitForURL((u) => u.pathname === next);
}

/** Polls the dev outbox for the newest email to `to` whose text contains `pattern`; returns the first match. */
export async function readEmailMatch(to: string, pattern: RegExp, since: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(OUTBOX, "utf8")).split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        const e = JSON.parse(line) as { to: string; text: string; sentAt: string };
        if (e.to === to && new Date(e.sentAt).getTime() >= since - 1000) {
          const m = e.text.match(pattern);
          if (m) return m[0];
        }
      }
    } catch {
      /* file not created yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No matching email to ${to}`);
}
