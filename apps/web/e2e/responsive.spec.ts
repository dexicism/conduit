import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("mobile layout (360px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("public pages fit without horizontal scroll", async ({ page }) => {
    for (const path of ["/", "/login"]) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
  });

  test.describe("signed in", () => {
    test.use({ storageState: "e2e/.auth/user.json" });

    test("dashboard fits and the mobile nav opens", async ({ page }) => {
      await page.goto("/app/workflows");
      await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("dialog").getByRole("link", { name: "Workflows" })).toBeVisible();
    });
  });
});
