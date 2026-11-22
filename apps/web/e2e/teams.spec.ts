import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { readEmailMatch, signIn, uniqueEmail } from "./helpers";


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

    // Invite (no member limit).
    const ws = await (await owner.page.request.get("/api/workspace")).json();
    const invitee = uniqueEmail("member");
    await owner.page.getByLabel("Invite by email").fill(invitee);
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
