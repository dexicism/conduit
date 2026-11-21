import { expect, test, type APIRequestContext } from "@playwright/test";
import { signIn, uniqueEmail } from "./helpers";

// App APIs go to the local stand-in started by playwright.config.ts (CONDUIT_FAKE_APIS_URL).
const FAKE = "http://127.0.0.1:3199";
const TELEGRAM_TOKEN = "123456:FAKE-telegram-token-abcdefghij";
const SLACK_TOKEN = "xoxb-fake-slack-token-123";

test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

type N = { id: string; type: string; label?: string; parameters?: Record<string, unknown>; to?: Record<string, string[]> };

async function workflowWith(request: APIRequestContext, name: string, list: N[]) {
  const wf = await (await request.post("/api/workflows", { data: { name: `${name} ${Date.now()}` } })).json();
  const nodes = list.map((n, i) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    position: { x: i * 260, y: 0 },
    parameters: n.parameters ?? {},
    connections: Object.fromEntries(Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => ({ targetId: t }))])),
  }));
  const res = await request.put(`/api/workflows/${wf.id}/draft`, { data: { expectedRevision: 0, graph: { nodes } } });
  expect(res.status(), await res.text()).toBe(200);
  return wf.id as string;
}

async function connect(request: APIRequestContext, app: string, label: string, values: Record<string, string>) {
  const res = await request.post("/api/credentials", { data: { app, label: `${label} ${Date.now()}`, values } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; label: string };
}

async function fakeCalls(request: APIRequestContext): Promise<Array<{ host: string; path: string; body: Record<string, unknown> }>> {
  return (await request.get(`${FAKE}/__calls`)).json();
}

test.beforeEach(async ({ request }) => {
  await request.get(`${FAKE}/__reset`);
});

test.describe("Connected apps", () => {
  test("connects a Telegram bot after checking the token; secrets never come back", async ({ page }) => {
    await page.goto("/app/connections");
    await page.getByRole("list", { name: "Apps" }).getByRole("button", { name: /Telegram/ }).click();
    const form = page.getByRole("form", { name: "Connect Telegram" });
    const label = `My bot ${Date.now()}`;
    await form.getByLabel("Account name").fill(label);
    await form.getByLabel("Bot token").fill("999:wrong-token-zzzzzzzz");
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(form.getByRole("alert")).toHaveText("Couldn't connect: Telegram: Unauthorized");

    await form.getByLabel("Bot token").fill(TELEGRAM_TOKEN);
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(form).toBeHidden();
    const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: label });
    await expect(row).toContainText("@conduit_test_bot");
    await expect(row.getByTestId("credential-status")).toHaveText("Working");

    const list = await (await page.request.get("/api/credentials?app=telegram")).text();
    expect(list).toContain(label);
    expect(list).not.toContain(TELEGRAM_TOKEN);

    // Check, rename, remove.
    await row.getByRole("button", { name: `Check ${label}` }).click();
    await expect(page.getByText(`${label} works`)).toBeVisible();
    await row.getByRole("button", { name: `Rename ${label}` }).click();
    await page.getByLabel("Account name").fill(`${label} renamed`);
    await page.getByRole("button", { name: "Save" }).click();
    const renamed = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: `${label} renamed` });
    await expect(renamed).toBeVisible();
    await renamed.getByRole("button", { name: /^Remove/ }).click();
    await page.getByRole("button", { name: "Remove account" }).click();
    await expect(renamed).toBeHidden();
  });

  test("connects Google through OAuth sign-in in a new tab", async ({ page, context }) => {
    await page.goto("/app/connections");
    await page.getByRole("list", { name: "Apps" }).getByRole("button", { name: /Google/ }).click();
    const form = page.getByRole("form", { name: "Connect Google" });
    const label = `Work Google ${Date.now()}`;
    await form.getByLabel("Account name").fill(label);
    const [tab] = await Promise.all([context.waitForEvent("page"), form.getByRole("button", { name: /Sign in with Google/ }).click()]);
    // The stand-in approves immediately and redirects back; the tab confirms and closes itself.
    await tab.waitForURL(/\/app\/connections\/done\?id=/);
    await expect(page.getByRole("form", { name: "Connect Google" })).toBeHidden({ timeout: 15_000 });
    const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: label });
    await expect(row).toContainText("tester@example.com");
    await expect(page.getByText(`${label} connected`)).toHaveCount(1);

    // Real PKCE exchange happened.
    const calls = await fakeCalls(page.request);
    const token = calls.find((c) => c.host === "oauth2.googleapis.com");
    expect(token?.body).toMatchObject({ grant_type: "authorization_code", client_id: "fake-google-client-id" });
    expect(String(token?.body.code_verifier).length).toBeGreaterThanOrEqual(43);
  });

  test("a stale or foreign OAuth state is refused", async ({ page }) => {
    await page.goto("/api/credentials/oauth/callback?state=forged&code=abc");
    await expect(page.getByRole("heading", { name: "Couldn't connect the account" })).toBeVisible();
    await expect(page.getByText(/expired or wasn't started here/)).toBeVisible();
  });
});

test.describe("App steps in the editor", () => {
  test("connect an account from the step, pick a channel, and run it", async ({ page }) => {
    const id = await workflowWith(page.request, "Slack notify", [
      { id: "start", type: "trigger.manual", to: { main: ["slack"] } },
      { id: "slack", type: "app.slack.send", label: "Notify", parameters: { channel: "", text: "New order" } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByTestId("node-slack").click();
    await page.getByRole("button", { name: "Connect" }).click();
    const form = page.getByRole("form", { name: "Connect Slack" });
    await form.getByLabel("Bot token").fill(SLACK_TOKEN);
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(form).toBeHidden();
    await expect(page.getByLabel("Account*")).not.toHaveValue("");

    await page.getByRole("button", { name: "Show channels" }).click();
    await page.getByRole("list", { name: "Channel suggestions" }).getByRole("button", { name: "#general" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 15_000 });

    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = page.getByRole("region", { name: "Test run" });
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    const post = (await fakeCalls(page.request)).find((c) => c.path === "/api/chat.postMessage");
    expect(post?.body).toEqual({ channel: "C0GENERAL", text: "New order" });
  });

  test("the picker lists app steps under Apps", async ({ page }) => {
    const id = await workflowWith(page.request, "Picker", [{ id: "start", type: "trigger.manual" }]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a step after start" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Search steps" }).fill("sheets");
    await expect(dialog.getByRole("option", { name: /Google Sheets: add row/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /\(tool\)/ })).toHaveCount(0);
  });

  test("removing an account a live workflow uses needs confirmation", async ({ page }) => {
    const cred = await connect(page.request, "slack", "Live slack", { botToken: SLACK_TOKEN });
    const id = await workflowWith(page.request, "Live slack wf", [
      { id: "start", type: "trigger.manual", to: { main: ["slack"] } },
      { id: "slack", type: "app.slack.send", parameters: { credential: cred.id, channel: "C0GENERAL", text: "hi" } },
    ]);
    expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);
    const blocked = await page.request.delete(`/api/credentials/${cred.id}`);
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).message).toContain("Live slack wf");

    await page.goto("/app/connections");
    const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: cred.label });
    await row.getByRole("button", { name: /^Remove/ }).click();
    await page.getByRole("button", { name: "Remove account" }).click();
    await expect(page.getByText(/Published workflows use this account/)).toBeVisible();
    await page.getByRole("button", { name: "Remove anyway" }).click();
    await expect(row).toBeHidden();
  });

  test("another workspace's account can't be read, removed, or used in a run", async ({ page, browser }) => {
    const cred = await connect(page.request, "telegram", "Mine", { botToken: TELEGRAM_TOKEN });
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const other = await ctx.newPage();
    await signIn(other, uniqueEmail("creds"));
    expect((await other.request.get(`/api/credentials/${cred.id}`)).status()).toBe(404);
    expect((await other.request.delete(`/api/credentials/${cred.id}`)).status()).toBe(404);
    const list = await (await other.request.get("/api/credentials")).json();
    expect(list.credentials).toEqual([]);
    // Pointing a step at the id fails the run without calling Telegram.
    const id = await workflowWith(other.request, "Steal", [
      { id: "start", type: "trigger.manual", to: { main: ["send"] } },
      { id: "send", type: "app.telegram.send", parameters: { credential: cred.id, chatId: "1", text: "x" } },
    ]);
    const run = await (await other.request.post(`/api/workflows/${id}/test`, { data: {} })).json();
    await expect
      .poll(async () => (await (await other.request.get(`/api/executions/${run.executionId}`)).json()).status, { timeout: 15_000 })
      .toBe("failed");
    const detail = await (await other.request.get(`/api/executions/${run.executionId}`)).json();
    expect(JSON.stringify(detail)).toContain("doesn't exist in this workspace");
    expect((await fakeCalls(page.request)).some((c) => c.path.endsWith("/sendMessage"))).toBe(false);
    await ctx.close();
  });
});

test.describe("Telegram trigger", () => {
  test("publishing connects the bot; updates with the right secret start runs that reply", async ({ page, baseURL }) => {
    const cred = await connect(page.request, "telegram", "Support bot", { botToken: TELEGRAM_TOKEN });
    const id = await workflowWith(page.request, "Telegram echo", [
      { id: "tg", type: "trigger.telegram", parameters: { credential: cred.id }, to: { main: ["reply"] } },
      {
        id: "reply",
        type: "app.telegram.send",
        parameters: { credential: cred.id, chatId: "${['$input']['message']['chat']['id']}", text: "You said: ${['$input']['message']['text']}", parseMode: "none" },
      },
    ]);
    const pub = await page.request.post(`/api/workflows/${id}/publish`);
    expect(pub.status(), await pub.text()).toBe(200);
    expect((await pub.json()).triggers).toEqual([expect.objectContaining({ kind: "telegram" })]);

    const state = await (await page.request.get(`${FAKE}/__state`)).json();
    const hook = state.telegramWebhooks[TELEGRAM_TOKEN] as { url: string; secretToken: string };
    expect(hook.url).toMatch(new RegExp(`^${baseURL}/hook/telegram/`));
    const update = { update_id: 1, message: { message_id: 5, date: 1767258000, text: "hello", chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "Ana" } } };

    expect((await page.request.post(hook.url, { data: update, headers: { "x-telegram-bot-api-secret-token": "wrong" } })).status()).toBe(401);
    expect((await page.request.post(hook.url, { data: update, headers: { "x-telegram-bot-api-secret-token": hook.secretToken } })).status()).toBe(200);

    await expect
      .poll(async () => {
        const list = await (await page.request.get(`/api/executions?workflowId=${id}`)).json();
        return list.data[0]?.status;
      }, { timeout: 20_000 })
      .toBe("success");
    const send = (await fakeCalls(page.request)).find((c) => c.path.endsWith("/sendMessage"));
    expect(send?.body).toEqual({ chat_id: "4242", text: "You said: hello" });

    expect((await page.request.delete(`/api/workflows/${id}/publish`)).status()).toBe(204);
    const after = await (await page.request.get(`${FAKE}/__state`)).json();
    expect(after.telegramWebhooks[TELEGRAM_TOKEN]).toBeUndefined();
  });
});
