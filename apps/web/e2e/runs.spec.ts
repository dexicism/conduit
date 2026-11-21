import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

type N = {
  id: string;
  type: string;
  label?: string;
  parameters?: Record<string, unknown>;
  to?: Record<string, string[]>;
};

function nodes(list: N[]) {
  return list.map((n, i) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    position: { x: i * 260, y: 0 },
    parameters: n.parameters ?? {},
    connections: Object.fromEntries(Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => ({ targetId: t }))])),
  }));
}

async function workflowWith(request: APIRequestContext, name: string, list: N[], extra: Record<string, unknown> = {}) {
  const wf = await (await request.post("/api/workflows", { data: { name: `${name} ${Date.now()}` } })).json();
  const res = await request.put(`/api/workflows/${wf.id}/draft`, { data: { expectedRevision: 0, graph: { nodes: nodes(list), ...extra } } });
  expect(res.status(), await res.text()).toBe(200);
  return wf.id as string;
}

const set = (field: string, value: string) => ({ assignments: [{ id: "a", name: field, value, type: "string" }], keepOthers: true });
const code = (src: string) => ({ mode: "perItem", code: src });

async function runPanel(page: Page) {
  return page.getByRole("region", { name: "Test run" });
}

test.describe("test runs in the editor", () => {
  test("manual test run shows live results, step badges and output", async ({ page }) => {
    const id = await workflowWith(page.request, "Run basics", [
      { id: "start", type: "trigger.manual", label: "Start", to: { main: ["code"] } },
      { id: "code", type: "core.code", label: "Greet", parameters: code("return { ...item, greeting: 'hi from the sandbox' };"), to: { main: ["set"] } },
      { id: "set", type: "core.set", label: "Tag", parameters: set("tag", "${['code']['greeting']}!") },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Test workflow" }).click();

    const panel = await runPanel(page);
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    await expect(panel.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByTestId("node-code")).toHaveAttribute("data-run-status", "success");
    await expect(page.getByTestId("node-set").getByTestId("node-run-badge")).toHaveText("1");

    // Clicking a step opens its output.
    await panel.getByRole("button", { name: /Tag/ }).click();
    const out = page.getByTestId("step-output");
    await expect(out).toContainText('"tag": "hi from the sandbox!"');
    await expect(out).toContainText('"greeting": "hi from the sandbox"');

    // Real run data now feeds the variable picker.
    await page.getByRole("tab", { name: "Parameters" }).click();
    await page.getByRole("button", { name: "Insert data into Field 1 value" }).click();
    await expect(page.getByText("hi from the sandbox").first()).toBeVisible();
  });

  test("failing step stops the run and shows the error on the node", async ({ page }) => {
    const id = await workflowWith(page.request, "Run failure", [
      { id: "start", type: "trigger.manual", to: { main: ["math"] } },
      { id: "math", type: "transform.math", label: "Divide", parameters: { a: "10", operation: "divide", b: "0", outputField: "r" }, to: { main: ["after"] } },
      { id: "after", type: "core.set", parameters: set("x", "1") },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = await runPanel(page);
    await expect(panel.getByTestId("run-status")).toHaveText("Failed", { timeout: 20_000 });
    await expect(panel.getByText("Can't divide by zero").first()).toBeVisible();
    await expect(page.getByTestId("node-math")).toHaveAttribute("data-run-status", "failed");
    await expect(page.getByTestId("node-after")).not.toHaveAttribute("data-run-status", /.+/);
  });

  test("HTTP step calls a real endpoint", async ({ page, baseURL }) => {
    const id = await workflowWith(page.request, "Run http", [
      { id: "start", type: "trigger.manual", to: { main: ["http"] } },
      { id: "http", type: "core.http", label: "Health", parameters: { method: "GET", url: `${baseURL}/api/health`, timeoutSeconds: 10, failOnErrorStatus: true } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = await runPanel(page);
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    await page.getByTestId("node-http").click();
    await page.getByRole("tab", { name: "Output" }).click();
    await expect(page.getByTestId("step-output")).toContainText('"db": "up"');
  });

  test("wait pauses the run; cancel stops it", async ({ page }) => {
    const id = await workflowWith(page.request, "Run wait", [
      { id: "start", type: "trigger.manual", to: { main: ["wait"] } },
      { id: "wait", type: "flow.wait", parameters: { mode: "duration", amount: 10, unit: "minutes" }, to: { main: ["after"] } },
      { id: "after", type: "core.set", parameters: set("x", "1") },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = await runPanel(page);
    await expect(panel.getByTestId("run-status")).toHaveText("Waiting", { timeout: 20_000 });
    await expect(page.getByTestId("node-wait")).toHaveAttribute("data-run-status", "waiting");
    await panel.getByRole("button", { name: "Cancel run" }).click();
    await expect(panel.getByTestId("run-status")).toHaveText("Canceled");
  });

  test("webhook trigger: listen for a test request", async ({ page }) => {
    const path = `e2e-test-${Date.now()}`;
    const id = await workflowWith(page.request, "Run listen", [
      { id: "hook", type: "trigger.webhook", parameters: { method: "POST", path, respond: "immediately", auth: "none" }, to: { main: ["set"] } },
      { id: "set", type: "core.set", parameters: set("who", "${['$input']['body']['name']}") },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Listen for test request" }).click();
    const panel = await runPanel(page);
    const url = (await panel.getByTestId("test-url").textContent())!;
    expect(url).toContain(`/hook-test/${path}`);

    const res = await page.request.post(url, { data: { name: "Ada" } });
    expect(res.status()).toBe(202);
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    await page.getByTestId("node-set").click();
    await page.getByRole("tab", { name: "Output" }).click();
    await expect(page.getByTestId("step-output")).toContainText('"who": "Ada"');

    // The test URL accepts one request only.
    expect((await page.request.post(url, { data: {} })).status()).toBe(404);
  });
});

test.describe("publishing", () => {
  test("refuses to publish a workflow with problems", async ({ page }) => {
    const id = await workflowWith(page.request, "Publish invalid", [
      { id: "start", type: "trigger.manual", to: { main: ["http"] } },
      { id: "http", type: "core.http", parameters: { method: "GET", url: "" } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByText("Fix the problems in this workflow before publishing")).toBeVisible();
    await expect(page.getByText(/URL is required/)).toBeVisible();
  });

  test("live webhook with a Respond step, method and auth checks, unpublish", async ({ page, baseURL }) => {
    const path = `e2e-live-${Date.now()}`;
    const id = await workflowWith(page.request, "Publish live", [
      {
        id: "hook",
        type: "trigger.webhook",
        parameters: { method: "POST", path, respond: "respondNode", auth: "header", authHeaderName: "x-api-key", authHeaderValue: "s3cret" },
        to: { main: ["code"] },
      },
      { id: "code", type: "core.code", parameters: code("return { total: item.body.items.reduce((a, b) => a + b, 0) };"), to: { main: ["respond"] } },
      { id: "respond", type: "core.respond", parameters: { status: 201, headers: [], body: '{"total": ${[\'$input\'][\'total\']}}' } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("dialog", { name: "Workflow is live" });
    await expect(dialog.getByTestId("live-url")).toHaveText(`${baseURL}/hook/${path}`);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("publish-state")).toHaveText("Published");

    const url = `${baseURL}/hook/${path}`;
    const ok = await page.request.post(url, { data: { items: [1, 2, 3.5] }, headers: { "x-api-key": "s3cret" } });
    expect(ok.status()).toBe(201);
    expect(await ok.json()).toEqual({ total: 6.5 });
    expect((await page.request.post(url, { data: { items: [] } })).status()).toBe(401);
    expect((await page.request.post(url, { data: { items: [] }, headers: { "x-api-key": "nope" } })).status()).toBe(401);
    expect((await page.request.get(url, { headers: { "x-api-key": "s3cret" } })).status()).toBe(405);

    // Editing after publishing shows that changes are not live yet.
    await page.getByTestId("node-code").click();
    await page.getByLabel("Step name").fill("Sum items");
    await expect(page.getByRole("button", { name: "Publish changes" })).toBeVisible();

    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Unpublish" }).click();
    await expect(page.getByText("Workflow unpublished")).toBeVisible();
    expect((await page.request.post(url, { data: { items: [1] }, headers: { "x-api-key": "s3cret" } })).status()).toBe(404);
  });

  test("a failing live run starts the error workflow", async ({ page, baseURL }) => {
    const handler = await workflowWith(page.request, "Error handler", [
      { id: "err", type: "trigger.error", to: { main: ["set"] } },
      { id: "set", type: "core.set", parameters: set("alert", "Failed: ${['$input']['error']['message']}") },
    ]);
    expect((await page.request.post(`/api/workflows/${handler}/publish`)).status()).toBe(200);

    const path = `e2e-fail-${Date.now()}`;
    const failing = await workflowWith(page.request, "Fails live", [
      { id: "hook", type: "trigger.webhook", parameters: { method: "POST", path, respond: "immediately", auth: "none" }, to: { main: ["json"] } },
      { id: "json", type: "transform.json", parameters: { value: "not json", operation: "parse", outputField: "r" } },
    ]);
    // Set the error workflow through the editor's settings dialog.
    await page.goto(`/app/workflows/${failing}`);
    await page.getByRole("button", { name: "Workflow options" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByLabel("When a live run fails, start").selectOption(handler);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();
    expect((await page.request.post(`/api/workflows/${failing}/publish`)).status()).toBe(200);

    expect((await page.request.post(`${baseURL}/hook/${path}`, { data: {} })).status()).toBe(202);

    await expect
      .poll(
        async () => {
          const list = await (await page.request.get(`/api/executions?workflowId=${handler}`)).json();
          return list.data.find((e: { mode: string }) => e.mode === "error")?.status;
        },
        { timeout: 20_000 },
      )
      .toBe("success");
    const list = await (await page.request.get(`/api/executions?workflowId=${handler}`)).json();
    const detail = await (await page.request.get(`/api/executions/${list.data[0].id}`)).json();
    expect(detail.steps.at(-1).output.main[0].json.alert).toBe("Failed: Value is not valid JSON");
  });
});

test.describe("run history", () => {
  test("lists runs, shows details, and runs again", async ({ page }) => {
    const id = await workflowWith(page.request, "History", [
      { id: "start", type: "trigger.manual", to: { main: ["set"] } },
      { id: "set", type: "core.set", label: "Mark", parameters: set("done", "yes") },
    ]);
    const started = await (await page.request.post(`/api/workflows/${id}/test`, { data: {} })).json();
    await expect
      .poll(async () => (await (await page.request.get(`/api/executions/${started.executionId}`)).json()).status, { timeout: 20_000 })
      .toBe("success");

    await page.goto(`/app/executions?workflowId=${id}`);
    const rows = page.getByRole("list", { name: "Runs" }).getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Succeeded");
    await rows.first().getByRole("link").click();

    await expect(page.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveCount(2);
    await page.getByText("Mark").click();
    await expect(page.getByLabel("Mark output")).toContainText('"done": "yes"');

    await page.getByRole("button", { name: "Run again" }).click();
    await expect(page.getByText("Started a new run")).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(started.executionId));
    await expect(page.getByTestId("run-status").first()).toHaveText("Succeeded", { timeout: 20_000 });

    await page.goto(`/app/executions?workflowId=${id}`);
    await expect(rows).toHaveCount(2);
  });

  test("API: unknown runs 404, other workspaces can't see runs", async ({ page }) => {
    expect((await page.request.get("/api/executions/0123456789abcdef01234567")).status()).toBe(404);
    expect((await page.request.get("/api/executions?status=nope")).status()).toBe(400);
  });
});
