import { expect, test } from "@playwright/test";
import { enterCode, readCode, requestCode, uniqueEmail } from "./helpers";

test.describe("authentication", () => {
  test("signed-out visitors are sent to login and returned afterwards", async ({ page }) => {
    await page.goto("/app/workflows");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fworkflows/);
    await expect(page.getByRole("heading", { name: "Sign in to Conduit" })).toBeVisible();
  });

  test("API rejects anonymous requests with a JSON 401", async ({ request }) => {
    const res = await request.get("/api/workflows");
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  test("social buttons are hidden when providers are not configured", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Continue with (Google|GitHub)/ })).toHaveCount(0);
  });

  test("invalid email is rejected client-side", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in code" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toHaveCount(0);
  });

  test("wrong code errors, right code signs in, sign out ends the session", async ({ page }) => {
    const email = uniqueEmail("auth");
    await page.goto("/login?next=%2Fapp%2Fworkflows");
    const since = await requestCode(page, email);
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Resend in")).toBeVisible();

    const code = await readCode(email, since);
    const wrong = code === "000000" ? "111111" : "000000";
    await enterCode(page, wrong);
    await expect(page.getByText("That code is incorrect or has expired.")).toBeVisible();

    await enterCode(page, code);
    await page.waitForURL("**/app/workflows");
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();

    // Visiting /login while signed in goes straight to the app.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/app\/workflows$/);

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
    await page.goto("/app/workflows");
    await expect(page).toHaveURL(/\/login/);
  });
});
