import { expect, test as setup } from "@playwright/test";
import { signIn, uniqueEmail } from "./helpers";

export const STORAGE = "e2e/.auth/user.json";

setup("sign in once and save the session", async ({ page }) => {
  await signIn(page, uniqueEmail("main"));
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.context().storageState({ path: STORAGE });
});
