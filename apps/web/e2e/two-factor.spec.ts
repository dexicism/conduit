import { expect, test, type Browser } from "@playwright/test";
import { createHmac } from "node:crypto";
import { signIn, uniqueEmail } from "./helpers";

function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "")) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP, the same as an authenticator app. */
function totp(key: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 30_000) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(key)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, "0");
}

async function context(browser: Browser) {
  // Own client address so sign-in rate limits don't collide with other tests.
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
  });
}

test("two-step verification: set up, required at the next sign-in, recovery code, turn off", async ({ browser }) => {
  const email = uniqueEmail("2fa");
  const a = await context(browser);
  const page = await a.newPage();
  await signIn(page, email);
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  const key = (await page.getByTestId("totp-key").textContent())!.trim();
  await page.getByLabel("Code from the app").fill(totp(key, 5)); // wrong (far future)
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText(/code isn't right/)).toBeVisible();
  await page.getByLabel("Code from the app").fill(totp(key));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(8);
  const codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(8);
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByText(/On · 8 recovery codes left/)).toBeVisible();
  // This session already passed the check.
  expect((await page.request.get("/api/workflows")).status()).toBe(200);

  // A new sign-in is held at /2fa: pages redirect and the API refuses.
  const b = await context(browser);
  const p2 = await b.newPage();
  await p2.goto("/login?next=/app/workflows");
  const { requestCode, readCode, enterCode } = await import("./helpers");
  const since = await requestCode(p2, email);
  await enterCode(p2, await readCode(email, since));
  await p2.waitForURL(/\/2fa\?next=/);
  expect((await p2.request.get("/api/workflows")).status()).toBe(401);
  await p2.getByLabel("Code").fill("000000");
  await p2.getByRole("button", { name: "Verify" }).click();
  await expect(p2.getByText("That code isn't right")).toBeVisible();
  // A recovery code works once.
  await p2.getByLabel("Code").fill(codes[0]!);
  await p2.getByRole("button", { name: "Verify" }).click();
  await p2.waitForURL("**/app/workflows");
  expect((await p2.request.get("/api/workflows")).status()).toBe(200);
  await b.close();

  // Turn it off with a current code (a fresh time step: the setup code can't be replayed).
  await page.reload();
  await expect(page.getByText(/7 recovery codes left/)).toBeVisible();
  await page.getByLabel("Code to turn off").fill(codes[1]!);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("button", { name: "Set up two-step verification" })).toBeVisible();
  await a.close();
});
