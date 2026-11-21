import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readEmailMatch, signIn, uniqueEmail } from "./helpers";

const WEBHOOK_SECRET = "whsec_e2e_secret";

/** Signs a Stripe event the way Stripe does: `t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<body>")`. */
function stripeSignature(body: string, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function freshUser(browser: Browser, tag: string) {
  // Own client address: sign-in codes are rate limited per IP.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { "x-forwarded-for": ip } });
  const page = await ctx.newPage();
  const email = uniqueEmail(tag);
  await signIn(page, email);
  return { ctx, page, email };
}

async function createTeam(request: APIRequestContext, name: string) {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

test.describe("Teams", () => {
  test("create a team, invite by email, accept, change roles, remove", async ({ browser }) => {
    const owner = await freshUser(browser, "owner");
    // Create the team from the workspace menu.
    await owner.page.getByRole("button", { name: "Switch workspace" }).click();
    await owner.page.getByRole("menuitem", { name: "Create a team" }).click();
    const teamName = `Ops ${Date.now()}`;
    await owner.page.getByLabel("Team name").fill(teamName);
    await owner.page.getByRole("button", { name: "Create team" }).click();
    await owner.page.waitForURL("**/app/settings");
    await expect(owner.page.getByRole("button", { name: "Switch workspace" })).toContainText(teamName);

    // A workflow in the team.
    const wf = await (await owner.page.request.post("/api/workflows", { data: { name: "Team flow" } })).json();

    // Invite. Free plan allows one member, so the invite is refused until the plan allows more.
    const invitee = uniqueEmail("member");
    await owner.page.getByLabel("Invite by email").fill(invitee);
    await owner.page.getByRole("button", { name: "Send invite" }).click();
    await expect(owner.page.getByText(/Free plan allows 1 member/)).toBeVisible();

    // Upgrade through a verified webhook (no UI payment in tests), then invite.
    const ws = await (await owner.page.request.get("/api/workspace")).json();
    const event = JSON.stringify({ id: `evt_${Date.now()}`, type: "checkout.session.completed", data: { object: { metadata: { workspaceId: ws.id, plan: "starter" }, customer: "cus_team", subscription: "sub_team" } } });
    expect((await owner.page.request.post("/api/billing/webhook", { data: event, headers: { "content-type": "application/json", "stripe-signature": stripeSignature(event) } })).status()).toBe(200);

    const since = Date.now();
    await owner.page.getByRole("button", { name: "Send invite" }).click();
    await expect(owner.page.getByRole("list", { name: "Pending invitations" })).toContainText(invitee);
    const link = await readEmailMatch(invitee, /http\S+\/invite\/[A-Za-z0-9_-]+/, since);

    // Someone else can't use the link.
    const stranger = await freshUser(browser, "stranger");
    await stranger.page.goto(link);
    await expect(stranger.page.getByText(`Sign out and sign in with ${invitee} to accept.`)).toBeVisible();
    await stranger.ctx.close();

    // The invitee accepts.
    const member = await browser.newContext({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": "10.250.1.2" } });
    const mp = await member.newPage();
    await signIn(mp, invitee);
    await mp.goto(link);
    await mp.getByRole("button", { name: "Accept and join" }).click();
    await mp.waitForURL("**/app/workflows");
    await expect(mp.getByRole("button", { name: "Switch workspace" })).toContainText(teamName);
    expect((await mp.request.get(`/api/workflows/${wf.id}`)).status()).toBe(200);
    // Used links don't work again.
    await mp.goto(link);
    await expect(mp.getByRole("heading", { name: "This invitation isn't valid" })).toBeVisible();

    // Owner makes them a viewer: they can read but not create.
    await owner.page.reload();
    await owner.page.getByLabel(`Role for ${invitee}`).selectOption("viewer");
    await expect.poll(async () => (await (await mp.request.get("/api/workspace")).json()).role).toBe("viewer");
    expect((await mp.request.post("/api/workflows", { data: { name: "nope" } })).status()).toBe(403);

    // The last owner can't leave.
    await owner.page.getByRole("button", { name: "Leave workspace" }).click();
    await expect(owner.page.getByText(/needs at least one owner/)).toBeVisible();

    // Removing the member cuts access at once.
    await owner.page.getByRole("button", { name: `Remove ${invitee}` }).click();
    await expect(owner.page.getByRole("list", { name: "Members" })).not.toContainText(invitee);
    expect((await mp.request.get(`/api/workflows/${wf.id}`)).status()).toBe(404);
    expect((await mp.request.get("/api/workflows", { headers: { "x-workspace-id": ws.id } })).status()).toBe(403);

    await member.close();
    await owner.ctx.close();
  });

  test("switching workspaces scopes workflows to the current one", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const u = { ctx, page: await ctx.newPage() };
    const personal = await (await u.page.request.post("/api/workflows", { data: { name: `Personal only ${Date.now()}` } })).json();
    const team = await createTeam(u.page.request, `Team ${Date.now()}`);
    // The cookie set by creating the team makes it current.
    expect((await (await u.page.request.get("/api/workspace")).json()).id).toBe(team.id);
    expect((await u.page.request.get(`/api/workflows/${personal.id}`)).status()).toBe(404);
    await u.page.goto("/app/workflows");
    await u.page.getByRole("button", { name: "Switch workspace" }).click();
    const personalName = (await (await u.page.request.get("/api/workspaces")).json()).workspaces[0].name as string;
    await u.page.getByRole("menuitem", { name: personalName }).click();
    await expect(u.page.getByRole("button", { name: "Switch workspace" })).toContainText(personalName);
    expect((await u.page.request.get(`/api/workflows/${personal.id}`)).status()).toBe(200);
    // Switching to a workspace you don't belong to is refused.
    expect((await u.page.request.post("/api/workspaces/switch", { data: { workspaceId: "5f0000000000000000000000" } })).status()).toBe(403);
    await u.ctx.close();
  });
});

test.describe("Plans and billing", () => {
  test.use({ storageState: "e2e/.auth/user.json" });

  test("credits meter, Stripe checkout, signed webhooks (once only), invoices", async ({ browser }) => {
    // A fresh team of the main test user, so the plan change doesn't leak into other tests.
    const ctx = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const u = { ctx, page: await ctx.newPage() };
    await createTeam(u.page.request, `Billing ${Date.now()}`);
    await u.page.goto("/app/billing");
    await expect(u.page.getByRole("heading", { name: "Free plan" })).toBeVisible();
    await expect(u.page.getByTestId("meter-Credits")).toContainText("500");

    // Checkout goes to Stripe (the stand-in returns its URL); the plan doesn't change yet.
    const checkout = await u.page.request.post("/api/billing/checkout", { data: { plan: "pro" } });
    expect(checkout.status(), await checkout.text()).toBe(200);
    expect((await checkout.json()).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect((await (await u.page.request.get("/api/billing")).json()).plan).toBe("free");

    // Webhook: bad signature, stale timestamp, then valid.
    const ws = await (await u.page.request.get("/api/workspace")).json();
    const id = `evt_${Date.now()}`;
    const body = JSON.stringify({ id, type: "checkout.session.completed", data: { object: { metadata: { workspaceId: ws.id, plan: "pro" }, customer: "cus_123", subscription: "sub_123" } } });
    const post = (sig: string) => u.page.request.post("/api/billing/webhook", { data: body, headers: { "content-type": "application/json", "stripe-signature": sig } });
    expect((await post(stripeSignature(body, "whsec_wrong"))).status()).toBe(400);
    expect((await post(stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600))).status()).toBe(400);
    const ok = await post(stripeSignature(body));
    expect(await ok.json()).toEqual({ received: true, result: "applied" });
    expect(await (await post(stripeSignature(body))).json()).toEqual({ received: true, result: "duplicate" });

    await u.page.reload();
    await expect(u.page.getByRole("heading", { name: "Pro plan" })).toBeVisible();
    await expect(u.page.getByTestId("meter-Credits")).toContainText("30,000");
    await expect(u.page.getByRole("list", { name: "Invoices" })).toContainText("CONDUIT-0001");
    await expect(u.page.getByRole("button", { name: /Manage billing/ })).toBeVisible();

    // Cancelling the subscription drops back to Free.
    const cancel = JSON.stringify({ id: `${id}_del`, type: "customer.subscription.deleted", data: { object: { id: "sub_123", customer: "cus_123", status: "canceled", metadata: { workspaceId: ws.id } } } });
    await u.page.request.post("/api/billing/webhook", { data: cancel, headers: { "content-type": "application/json", "stripe-signature": stripeSignature(cancel) } });
    expect((await (await u.page.request.get("/api/billing")).json()).plan).toBe("free");
    await u.ctx.close();
  });

  test("live runs spend credits; test runs don't; the canvas shows step costs", async ({ page }) => {
    const wf = await (await page.request.post("/api/workflows", { data: { name: `Credits ${Date.now()}` } })).json();
    const nodes = [
      { id: "start", type: "trigger.manual", label: "start", position: { x: 0, y: 0 }, parameters: {}, connections: { main: [{ targetId: "code" }] } },
      { id: "code", type: "core.code", label: "code", position: { x: 260, y: 0 }, parameters: { mode: "all", code: "return [{ ok: true }]" }, connections: {} },
    ];
    await page.request.put(`/api/workflows/${wf.id}/draft`, { data: { expectedRevision: 0, graph: { nodes } } });
    const billing = await page.request.get("/api/billing");
    expect(billing.status(), await billing.text()).toBe(200);
    const before = (await billing.json()).balance.plan as number;
    const run = await (await page.request.post(`/api/workflows/${wf.id}/test`, { data: {} })).json();
    await expect.poll(async () => (await (await page.request.get(`/api/executions/${run.executionId}`)).json()).status).toBe("success");
    expect((await (await page.request.get("/api/billing")).json()).balance.plan).toBe(before);

    await page.goto(`/app/workflows/${wf.id}`);
    await expect(page.getByTestId("node-code").getByTestId("node-credits")).toHaveText("1 cr");
    await expect(page.getByTestId("node-start").getByTestId("node-credits")).toHaveCount(0);
  });
});
