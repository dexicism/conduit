import { expect, test, type Page } from "@playwright/test";
import { signIn, uniqueEmail } from "./helpers";

test.use({ storageState: "e2e/.auth/user.json" });

// Match the row by its exact link name: "X" must not also match "X (copy)".
const row = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Workflows" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });

async function openRowMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
}

test.describe("workflows dashboard", () => {
  test("create with validation, open, and persist across reload", async ({ page }) => {
    await page.goto("/app/workflows");
    await page.getByRole("button", { name: "New workflow" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create workflow" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Name is required");

    const name = `Lead router ${Date.now()}`;
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel(/Description/).fill("Send new leads to the right rep");
    await dialog.getByRole("button", { name: "Create workflow" }).click();

    // Creating a workflow opens it in the editor.
    await page.waitForURL(/\/app\/workflows\/[a-f0-9]{24}$/);
    await expect(page.getByLabel("Workflow name")).toHaveValue(name);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Start with a trigger")).toBeVisible();

    await page.goto("/app/workflows");
    await expect(row(page, name)).toBeVisible();
    await page.reload();
    await expect(row(page, name)).toContainText("Send new leads to the right rep");
  });

  test("rename, search, duplicate, archive, restore, delete", async ({ page }) => {
    const stamp = Date.now();
    const original = `Invoice sync ${stamp}`;
    const renamed = `Invoice sync v2 ${stamp}`;
    const res = await page.request.post("/api/workflows", { data: { name: original } });
    expect(res.status()).toBe(201);

    await page.goto("/app/workflows");
    await openRowMenu(page, original);
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Name")).toHaveValue(original);
    await dialog.getByLabel("Name").fill(renamed);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Workflow updated")).toBeVisible();
    await expect(row(page, renamed)).toBeVisible();

    // Search narrows the list; clearing restores it.
    await page.getByLabel("Search workflows").fill(`v2 ${stamp}`);
    await expect(page.getByRole("list", { name: "Workflows" }).getByRole("listitem")).toHaveCount(1);
    await page.getByLabel("Search workflows").fill(`no-such-workflow-${stamp}`);
    await expect(page.getByText("No workflows match your search")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).first().click();
    await expect(row(page, renamed)).toBeVisible();

    await openRowMenu(page, renamed);
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await expect(row(page, `${renamed} (copy)`)).toBeVisible();

    await openRowMenu(page, renamed);
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Workflow archived")).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${renamed}`, exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: "Archived" }).click();
    await expect(row(page, renamed)).toContainText("Edited");
    await openRowMenu(page, renamed);
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText("Workflow restored")).toBeVisible();
    await page.getByRole("tab", { name: "Active" }).click();
    await expect(row(page, renamed)).toBeVisible();

    await openRowMenu(page, `${renamed} (copy)`);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete workflow" }).click();
    await expect(page.getByText("Workflow deleted")).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${renamed} (copy)`, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(row(page, renamed)).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${renamed} (copy)`, exact: true })).toHaveCount(0);
  });

  test("editor top bar renames, edits details, archives and deletes", async ({ page }) => {
    const name = `Detail ${Date.now()}`;
    const wf = await (await page.request.post("/api/workflows", { data: { name } })).json();
    await page.goto(`/app/workflows/${wf.id}`);

    // Inline rename commits on Enter; an empty name is rejected and reverted.
    await page.getByLabel("Workflow name").fill(`${name} renamed`);
    await page.getByLabel("Workflow name").press("Enter");
    await expect.poll(async () => (await (await page.request.get(`/api/workflows/${wf.id}`)).json()).name).toBe(`${name} renamed`);
    await page.getByLabel("Workflow name").fill("   ");
    await page.getByLabel("Workflow name").press("Enter");
    await expect(page.getByText("Name is required")).toBeVisible();
    await expect(page.getByLabel("Workflow name")).toHaveValue(`${name} renamed`);

    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Edit details" }).click();
    await page.getByRole("dialog").getByLabel(/Description/).fill("Updated from the editor");
    await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await (await page.request.get(`/api/workflows/${wf.id}`)).json()).description).toBe("Updated from the editor");

    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Delete workflow" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete workflow" }).click();
    await page.waitForURL(/\/app\/workflows$/);
    const res = await page.request.get(`/api/workflows/${wf.id}`);
    expect(res.status()).toBe(404);
  });

  test("pagination loads the next page", async ({ page }) => {
    const tag = `Bulk ${Date.now()}`;
    for (let i = 0; i < 23; i++) {
      const r = await page.request.post("/api/workflows", { data: { name: `${tag} #${String(i).padStart(2, "0")}` } });
      expect(r.ok()).toBe(true);
    }
    await page.goto("/app/workflows");
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
    // Wait for the debounced, filtered request itself: the unfiltered first page can look identical.
    const filtered = page.waitForResponse(
      (r) => r.url().includes("/api/workflows?") && new URL(r.url()).searchParams.get("q") === tag,
    );
    await page.getByLabel("Search workflows").fill(tag);
    await filtered;
    const items = page.getByRole("list", { name: "Workflows" }).getByRole("listitem");
    await expect(items).toHaveCount(20);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(items).toHaveCount(23);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("unknown workflow shows the 404 page", async ({ page }) => {
    await page.goto("/app/workflows/0123456789abcdef01234567");
    await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
  });
});

test.describe("workflows API", () => {
  test("validation, idempotent create, and error shapes", async ({ page }) => {
    const bad = await page.request.post("/api/workflows", { data: { name: "   " } });
    expect(bad.status()).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "validation_failed", message: "Name is required" });

    const notJson = await page.request.post("/api/workflows", {
      data: "name=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(notJson.status()).toBe(400);

    const requestId = crypto.randomUUID();
    const first = await page.request.post("/api/workflows", { data: { name: "Idempotent", requestId } });
    const second = await page.request.post("/api/workflows", { data: { name: "Idempotent", requestId } });
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);
    expect((await first.json()).id).toBe((await second.json()).id);

    expect((await page.request.get("/api/workflows/not-an-id")).status()).toBe(404);
    expect((await page.request.get("/api/workflows?limit=500")).status()).toBe(400);
    expect((await page.request.get("/api/workflows?cursor=garbage")).status()).toBe(400);
    expect((await page.request.patch(`/api/workflows/${(await first.json()).id}`, { data: {} })).status()).toBe(400);
  });

  test("workspaces are isolated between users", async ({ page, browser }) => {
    const mine = await (await page.request.post("/api/workflows", { data: { name: `Private ${Date.now()}` } })).json();

    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const other = await ctx.newPage();
    await signIn(other, uniqueEmail("other"));
    expect((await other.request.get(`/api/workflows/${mine.id}`)).status()).toBe(404);
    expect((await other.request.patch(`/api/workflows/${mine.id}`, { data: { name: "hijack" } })).status()).toBe(404);
    expect((await other.request.delete(`/api/workflows/${mine.id}`)).status()).toBe(404);
    const list = await (await other.request.get("/api/workflows")).json();
    expect(list.data.some((w: { id: string }) => w.id === mine.id)).toBe(false);
    await ctx.close();

    expect((await page.request.get(`/api/workflows/${mine.id}`)).status()).toBe(200);
  });
});

test.describe("Templates", () => {
  test("pick a template from the workflows page and land in the editor with it", async ({ page }) => {
    await page.goto("/app/workflows");
    await page.getByRole("button", { name: "Templates" }).click();
    const list = page.getByRole("list", { name: "Templates" });
    await expect(list.getByRole("listitem")).toHaveCount(9);
    const card = list.getByRole("listitem").filter({ hasText: "New blog posts to your phone" });
    await expect(card).toContainText("ntfy");
    await expect(card).toContainText("After creating: Put the feed URL");
    await card.getByRole("button", { name: "Use New blog posts to your phone" }).click();
    await page.waitForURL(/\/app\/workflows\/[a-f0-9]{24}$/);
    const id = page.url().split("/").pop()!;
    const wf = await (await page.request.get(`/api/workflows/${id}`)).json();
    expect(wf.name).toBe("New blog posts to your phone");
    expect(wf.draft.nodes.map((n: { type: string }) => n.type)).toEqual(["trigger.schedule", "app.rss.read", "flow.onlyNew", "app.ntfy.send"]);
    // The canvas shows the steps.
    await expect(page.getByText("Only new posts")).toBeVisible();
    // Unknown templates are a clean 404.
    expect((await page.request.post("/api/templates/nope")).status()).toBe(404);
  });
});
