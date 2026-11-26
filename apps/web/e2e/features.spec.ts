import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

// App APIs go to the local stand-in started by playwright.config.ts (CONDUIT_FAKE_APIS_URL).
const FAKE = "http://127.0.0.1:3199";
const WHATSAPP = { phoneNumberId: "1098765432", accessToken: "EAAG-fake-whatsapp-token" };

test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

type N = { id: string; type: string; label?: string; parameters?: Record<string, unknown>; to?: Record<string, string[]> };

async function workflowWith(request: APIRequestContext, name: string, list: N[]) {
  const wf = await (await request.post("/api/workflows", { data: { name: `${name} ${Date.now()}` } })).json();
  await saveGraph(request, wf.id, 0, list);
  return wf.id as string;
}

async function saveGraph(request: APIRequestContext, id: string, expectedRevision: number, list: N[]) {
  const nodes = list.map((n, i) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    position: { x: i * 260, y: 0 },
    parameters: n.parameters ?? {},
    connections: Object.fromEntries(Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => ({ targetId: t }))])),
  }));
  const res = await request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision, graph: { nodes } } });
  expect(res.status(), await res.text()).toBe(200);
}

const set = (field: string, value: string) => ({ assignments: [{ id: "a", name: field, value, type: "string" }], keepOthers: true });

test.beforeEach(async ({ request }) => {
  await request.get(`${FAKE}/__reset`);
});

test("home page counts live runs and lists the busiest workflows", async ({ page }) => {
  const path = `e2e-home-${Date.now()}`;
  const id = await workflowWith(page.request, "Home stats", [
    { id: "hook", type: "trigger.webhook", parameters: { method: "POST", path, respond: "immediately", auth: "none" }, to: { main: ["set"] } },
    { id: "set", type: "core.set", parameters: set("ok", "yes") },
  ]);
  expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);
  for (let i = 0; i < 2; i++) expect((await page.request.post(`/hook/${path}`, { data: { i } })).status()).toBeLessThan(300);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/home$/);
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  const busiest = page.getByRole("region", { name: "Busiest workflows" });
  await expect(busiest.getByRole("link", { name: /Home stats/ })).toContainText("2 runs", { timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Runs per day" }).getByRole("listitem").last()).toHaveAttribute("aria-label", /succeeded/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/\/app\/workflows$/);
});

test("version history restores an old publish into the editor", async ({ page }) => {
  const id = await workflowWith(page.request, "Versions", [
    { id: "start", type: "trigger.manual", to: { main: ["one"] } },
    { id: "one", type: "core.set", label: "First step", parameters: set("a", "1") },
  ]);
  expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);
  await saveGraph(page.request, id, 1, [
    { id: "start", type: "trigger.manual", to: { main: ["one"] } },
    { id: "one", type: "core.set", label: "First step", parameters: set("a", "1"), to: { main: ["two"] } },
    { id: "two", type: "core.set", label: "Second step", parameters: set("b", "2") },
  ]);
  expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);

  await page.goto(`/app/workflows/${id}`);
  await expect(page.getByTestId("node-two")).toBeVisible();
  await page.getByRole("button", { name: "Workflow options" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const versions = page.getByRole("list", { name: "Versions" }).getByRole("listitem");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Live");
  await expect(versions.last()).toContainText("2 steps");
  await versions.last().getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("node-two")).toBeHidden();
  await expect(page.getByTestId("node-one")).toBeVisible();

  // Undo brings the newer draft back.
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("node-two")).toBeVisible();
});

test("download a workflow as a file and import it again, without the accounts", async ({ page }) => {
  const cred = await (
    await page.request.post("/api/credentials", { data: { app: "whatsapp", label: `WA ${Date.now()}`, values: WHATSAPP } })
  ).json();
  const id = await workflowWith(page.request, "Export me", [
    { id: "start", type: "trigger.webhook", parameters: { method: "POST", path: `e2e-export-${Date.now()}`, respond: "immediately", auth: "header", authHeaderName: "x-api-key", authHeaderValue: "s3cret-typed-in" }, to: { main: ["send"] } },
    { id: "send", type: "app.whatsapp.send", parameters: { credential: cred.id, to: "+15550001111", messageType: "text", text: "hi" }, to: { main: ["http"] } },
    {
      id: "http",
      type: "core.http",
      parameters: { method: "GET", url: "https://example.com", headers: [{ key: "Authorization", value: "Bearer typed-token-1" }, { key: "X-Key", value: "${['$vars']['KEY']}" }, { key: "Accept", value: "text/plain" }] },
    },
  ]);
  const res = await page.request.get(`/api/workflows/${id}/export`);
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename=".+\.conduit\.json"/);
  const file = await res.json();
  expect(file.format).toBe("conduit-workflow");
  const node = (nodeId: string) => file.graph.nodes.find((n: { id: string }) => n.id === nodeId).parameters;
  expect(node("send").credential).toBe("");
  expect(node("start").authHeaderValue).toBe("");
  expect(node("http").headers).toEqual([
    { key: "Authorization", value: "" },
    { key: "X-Key", value: "${['$vars']['KEY']}" },
    { key: "Accept", value: "text/plain" },
  ]);
  expect(JSON.stringify(file)).not.toMatch(/s3cret-typed-in|typed-token-1/);
  const path = join(tmpdir(), `conduit-e2e-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(file));

  await page.goto("/app/workflows");
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(page).toHaveURL(/\/app\/workflows\/[a-f0-9]{24}$/);
  await expect(page.getByTestId("node-send")).toBeVisible();
  const newId = page.url().split("/").pop()!;
  const imported = await (await page.request.get(`/api/workflows/${newId}`)).json();
  // Not guaranteed to be the only WhatsApp account in the shared test workspace, so it may or may not be picked.
  expect(imported.draft.nodes.find((n: { id: string }) => n.id === "send").parameters.to).toBe("+15550001111");

  await writeFile(path, JSON.stringify({ hello: "world" }));
  await page.goto("/app/workflows");
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(page.getByText("That isn't a Conduit workflow file")).toBeVisible();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hello: "world" });
});

test("workspace variables: add in settings, use in a step, secrets stay hidden", async ({ page }) => {
  const name = `GREETING_${Date.now()}`;
  const secretName = `TOKEN_${Date.now()}`;
  await page.goto("/app/settings");
  const form = page.getByRole("form", { name: "Add a variable" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Value").fill("Hello there");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Variables" })).toContainText(name);
  await form.getByLabel("Name").fill(secretName);
  await form.getByLabel("Value").fill("very-secret-value-123");
  await form.getByRole("switch", { name: "Secret" }).click();
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Variables" })).toContainText(secretName);
  expect(await (await page.request.get("/api/workspace/variables")).text()).not.toContain("very-secret-value-123");

  const id = await workflowWith(page.request, "Vars", [
    { id: "start", type: "trigger.manual", to: { main: ["set"] } },
    { id: "set", type: "core.set", parameters: { assignments: [
      { id: "a", name: "text", value: `\${['$vars']['${name}']}`, type: "string" },
      { id: "b", name: "auth", value: `Bearer \${['$vars']['${secretName}']}`, type: "string" },
    ], keepOthers: true } },
  ]);
  await page.goto(`/app/workflows/${id}`);
  await page.getByRole("button", { name: "Test workflow" }).click();
  await expect(page.getByTestId("run-status").first()).toHaveText("Succeeded", { timeout: 20_000 });
  await page.getByTestId("node-set").click();
  await page.getByRole("tab", { name: "Output" }).click();
  await expect(page.getByTestId("step-output")).toContainText('"text": "Hello there"');
  await expect(page.getByTestId("step-output")).toContainText('"auth": "Bearer [hidden]"');
});

test("WhatsApp: add the receive keys, verify the callback, and a signed message starts the live workflow", async ({ page, baseURL }) => {
  const label = `WA bot ${Date.now()}`;
  const cred = await (await page.request.post("/api/credentials", { data: { app: "whatsapp", label, values: WHATSAPP } })).json();
  const hook = `/hook/whatsapp/${cred.id}`;
  const verify = (token: string) => page.request.get(`${hook}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=777`);
  expect((await verify("my-token")).status()).toBe(403);

  const id = await workflowWith(page.request, "WA bot", [
    { id: "wa", type: "trigger.whatsapp", parameters: { credential: cred.id }, to: { main: ["reply"] } },
    { id: "reply", type: "app.whatsapp.send", parameters: { credential: cred.id, to: "${['wa']['from']}", messageType: "text", text: "Got: ${['wa']['text']}" } },
  ]);
  const refused = await page.request.post(`/api/workflows/${id}/publish`);
  expect(refused.status()).toBe(400);
  expect((await refused.json()).message).toMatch(/app secret/);

  await page.goto("/app/connections");
  const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: label });
  await row.getByRole("button", { name: "Receive messages" }).click();
  const dialog = page.getByRole("dialog", { name: "Receive WhatsApp messages" });
  await expect(dialog).toContainText(`${baseURL}${hook}`);
  await expect(dialog).toContainText("Meta can't reach");
  await dialog.getByRole("button", { name: "Done" }).click();

  await row.getByRole("button", { name: `Update keys for ${label}` }).click();
  const form = page.getByRole("form", { name: "Connect WhatsApp Business" });
  await form.getByLabel("App secret (to receive messages)").fill("e2e-app-secret");
  await form.getByLabel("Verify token (to receive messages)").fill("my-token");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  expect(await (await verify("my-token")).text()).toBe("777");
  expect((await verify("wrong")).status()).toBe(403);
  expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);

  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: WHATSAPP.phoneNumberId }, contacts: [{ wa_id: "15551234567", profile: { name: "Ana" } }], messages: [{ from: "15551234567", id: `wamid.e2e${Date.now()}`, timestamp: "1767258000", type: "text", text: { body: "hello there" } }] } }] }],
  });
  const sig = `sha256=${createHmac("sha256", "e2e-app-secret").update(body).digest("hex")}`;
  expect((await page.request.post(hook, { data: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } })).status()).toBe(401);
  expect((await page.request.post(hook, { data: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } })).status()).toBe(200);

  await expect
    .poll(async () => {
      const calls = (await (await page.request.get(`${FAKE}/__calls`)).json()) as Array<{ host: string; method: string; body: { text?: { body?: string } } }>;
      return calls.find((c) => c.host === "graph.facebook.com" && c.method === "POST")?.body?.text?.body ?? null;
    }, { timeout: 20_000 })
    .toBe("Got: hello there");
  await page.request.delete(`/api/workflows/${id}/publish`);
});

test("WhatsApp (linked phone): add a number, see the link screen, and one live workflow per number", async ({ page }) => {
  const label = `Shop phone ${Date.now()}`;
  await page.goto("/app/connections");
  await page.getByRole("list", { name: "Apps" }).getByRole("button", { name: /WhatsApp \(linked phone\)/ }).click();
  const form = page.getByRole("form", { name: "Connect WhatsApp (linked phone)" });
  await form.getByLabel("Account name").fill(label);
  await form.getByRole("button", { name: "Connect" }).click();
  // Straight into linking. The test server runs without the WhatsApp worker, so it waits.
  const dialog = page.getByRole("dialog", { name: label });
  await expect(dialog).toContainText("Waiting for Conduit's worker");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: label });
  await expect(row.getByRole("button", { name: "Link phone" })).toBeVisible();
  // Its one setting is the country code for numbers written without one.
  await expect(row.getByRole("button", { name: `Update keys for ${label}` })).toBeVisible();

  const creds = (await (await page.request.get("/api/credentials?app=whatsappWeb")).json()).credentials as Array<{ id: string; label: string }>;
  const cred = creds.find((c) => c.label === label)!.id;
  const flow = (name: string) =>
    workflowWith(page.request, name, [
      { id: "wa", type: "trigger.whatsappWeb", parameters: { credential: cred, chats: "all", groupMode: "all" }, to: { main: ["reply"] } },
      { id: "reply", type: "app.whatsappWeb.send", parameters: { credential: cred, to: "${['wa']['chatId']}", text: "hi", fileSource: "none" } },
    ]);
  const a = await flow("Phone bot A");
  const b = await flow("Phone bot B");
  expect((await page.request.post(`/api/workflows/${a}/publish`)).status()).toBe(200);
  const clash = await page.request.post(`/api/workflows/${b}/publish`);
  expect(clash.status()).toBe(409);
  expect((await clash.json()).message).toMatch(/already starts the live workflow "Phone bot A/);
  await page.request.delete(`/api/workflows/${a}/publish`);
});
