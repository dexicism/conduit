/**
 * Takes the README screenshots against the running app on :3000 with a fresh demo account.
 *   npx tsx e2e/take-screenshots.mts (from apps/web, with the app running)
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

const BASE = "http://localhost:3000";
const OUT = "../../docs/screenshots";
const email = `demo-${Date.now()}@example.test`;

async function code(since: number): Promise<string> {
  for (let i = 0; i < 180; i++) {
    const lines = (await readFile(".data/outbox.jsonl", "utf8").catch(() => "")).split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      const e = JSON.parse(l) as { to: string; subject: string; sentAt: string };
      if (e.to === email && new Date(e.sentAt).getTime() >= since - 1000) {
        const m = e.subject.match(/\b(\d{6})\b/);
        if (m) return m[1]!;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no code");
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await ctx.newPage();
await page.goto(`${BASE}/login?next=/app/home`);
const since = Date.now();
await page.getByLabel("Work email").fill(email);
await page.getByRole("button", { name: "Email me a sign-in code" }).click();
await page.getByLabel("Sign-in code").fill(await code(since));
await page.waitForURL((u) => u.pathname === "/app/home", { timeout: 60_000 });
const api = page.request;

// A few workflows from templates, and one live webhook workflow with some runs.
const made: Record<string, string> = {};
for (const t of ["whatsapp-ai-bot", "form-to-sheet", "rss-to-phone"]) {
  const r = await api.post(`/api/templates/${t}`);
  made[t] = (await r.json()).id;
}
const wfRes = await api.post("/api/workflows", { data: { name: "New lead to CRM" } });
const wf = await wfRes.json();
const path = `lead-${Date.now()}`;
const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, to: string[] = []) => ({
  id, type, label: id, position: { x, y: 0 }, parameters, connections: to.length ? { main: to.map((t) => ({ targetId: t })) } : {},
});
await api.put(`/api/workflows/${wf.id}/draft`, {
  data: {
    expectedRevision: 0,
    graph: {
      nodes: [
        { ...node("hook", "trigger.webhook", 0, { method: "POST", path, respond: "immediately", auth: "none" }, ["check"]), label: "New lead" },
        { ...node("check", "core.set", 300, { assignments: [{ id: "a", name: "source", value: "website", type: "string" }], keepOthers: true }, ["tidy"]), label: "Tag the source" },
        { ...node("tidy", "core.set", 600, { assignments: [{ id: "a", name: "name", value: "${['$input']['body']['name']}", type: "string" }], keepOthers: true }), label: "Clean it up" },
      ],
    },
  },
});
const pub = await api.post(`/api/workflows/${wf.id}/publish`);
if (!pub.ok()) throw new Error(await pub.text());
for (let i = 0; i < 7; i++) await api.post(`/hook/${path}`, { data: { name: `Lead ${i}`, email: i === 3 ? "" : `lead${i}@example.com` } });
await page.waitForTimeout(4000);

await page.goto(`${BASE}/app/home`);
await page.getByRole("heading", { name: "Home" }).waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/home.png` });

await page.goto(`${BASE}/app/workflows`);
await page.getByRole("list", { name: "Workflows" }).waitFor();
await page.waitForTimeout(800);
await page.getByRole("button", { name: "Templates" }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/templates.png` });
await page.keyboard.press("Escape");

const bot = { id: made["whatsapp-ai-bot"] };
await page.goto(`${BASE}/app/workflows/${bot.id}`);
await page.getByTestId("node-ai").waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/editor.png` });

await browser.close();
console.log("done", email);
