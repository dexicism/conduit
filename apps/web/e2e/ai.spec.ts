import { expect, test, type APIRequestContext } from "@playwright/test";

// Runs against AI_PROVIDER=fake (see playwright.config.ts): rule-based, deterministic answers.
test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

type N = {
  id: string;
  type: string;
  label?: string;
  parameters?: Record<string, unknown>;
  to?: Record<string, Array<string | { targetId: string; targetHandle: string }>>;
};

async function workflowWith(request: APIRequestContext, name: string, list: N[]) {
  const wf = await (await request.post("/api/workflows", { data: { name: `${name} ${Date.now()}` } })).json();
  const nodes = list.map((n, i) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    position: { x: i * 260, y: 0 },
    parameters: n.parameters ?? {},
    connections: Object.fromEntries(
      Object.entries(n.to ?? {}).map(([h, ts]) => [h, ts.map((t) => (typeof t === "string" ? { targetId: t } : t))]),
    ),
  }));
  const res = await request.put(`/api/workflows/${wf.id}/draft`, { data: { expectedRevision: 0, graph: { nodes } } });
  expect(res.status(), await res.text()).toBe(200);
  return wf.id as string;
}

async function getDraft(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/workflows/${id}`)).json()) as {
    revision: number;
    draft: { nodes: Array<{ id: string; type: string; connections: Record<string, Array<{ targetId: string; targetHandle?: string }>> }> };
  };
}

test.describe("AI steps", () => {
  test("agent calls its calculator tool during a test run", async ({ page }) => {
    const id = await workflowWith(page.request, "Agent calc", [
      { id: "start", type: "trigger.manual", to: { main: ["agent"] } },
      {
        id: "agent",
        type: "ai.agent",
        label: "Assistant",
        parameters: { model: "claude-opus-5-5", prompt: "What is 6 * 7?", effort: "low", maxIterations: 5, memory: "none" },
        to: { tool: [{ targetId: "calc", targetHandle: "agent" }] },
      },
      { id: "calc", type: "tool.calculator", parameters: { toolName: "calculator", toolDescription: "Exact arithmetic" } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await expect(page.getByLabel("Tool port")).toBeVisible();
    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = page.getByRole("region", { name: "Test run" });
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    // The tool never runs as its own step; the agent's step shows the call in its console.
    await expect(panel.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveCount(2);
    await panel.getByRole("button", { name: /Assistant/ }).click();
    const out = page.getByTestId("step-output");
    await expect(out).toContainText('"output": "Result: {\\"result\\":42}"');
    await expect(out).toContainText('"toolCalls": 1');
    await expect(out).toContainText("calculator(");
  });

  test("tools attach from the agent's tool port; the picker offers only tools there", async ({ page }) => {
    const id = await workflowWith(page.request, "Tool port", [
      { id: "start", type: "trigger.manual", to: { main: ["agent"] } },
      { id: "agent", type: "ai.agent", label: "Assistant", parameters: { prompt: "hi" } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByTestId("node-agent").hover();
    await page.getByRole("button", { name: "Add a tool to Assistant" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a tool" });
    await expect(dialog.getByRole("option").filter({ hasText: /^HTTP request\b(?! tool)/ })).toHaveCount(0);
    await expect(dialog.getByRole("option").filter({ hasText: /^If\b/ })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Search steps" }).fill("Calculator");
    await dialog.getByRole("option", { name: /^Calculator/ }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 15_000 });
    const d = await getDraft(page.request, id);
    const agent = d.draft.nodes.find((n) => n.id === "agent")!;
    expect(agent.connections.tool).toEqual([{ targetId: "node-calculator", targetHandle: "agent" }]);
    // Tools are not offered from ordinary outputs.
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("button", { name: "Add a step after Assistant" }).click();
    await expect(page.getByRole("dialog").getByRole("option").filter({ hasText: /^Calculator/ })).toHaveCount(0);
  });

  test("classifier routes items to the matching branch", async ({ page }) => {
    const id = await workflowWith(page.request, "Classify", [
      { id: "start", type: "trigger.manual", to: { main: ["cls"] } },
      {
        id: "cls",
        type: "ai.classify",
        parameters: {
          model: "claude-opus-5-5",
          text: "I was charged twice, this is a billing problem",
          categories: [{ id: "b", value: "billing" }, { id: "s", value: "support" }],
          allowOther: true,
        },
        to: { "case-b": ["bill"], other: ["misc"] },
      },
      { id: "bill", type: "core.set", parameters: { assignments: [{ id: "1", name: "queue", value: "finance", type: "string" }] } },
      { id: "misc", type: "core.set", parameters: { assignments: [] } },
    ]);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Test workflow" }).click();
    const panel = page.getByRole("region", { name: "Test run" });
    await expect(panel.getByTestId("run-status")).toHaveText("Succeeded", { timeout: 20_000 });
    await expect(page.getByTestId("node-bill")).toHaveAttribute("data-run-status", "success");
    await expect(page.getByTestId("node-misc")).not.toHaveAttribute("data-run-status", /.+/);
  });
});

test.describe("AI builder", () => {
  test("builds from a prompt, highlights, undoes, and keeps the conversation", async ({ page }) => {
    const wf = await (await page.request.post("/api/workflows", { data: { name: `Builder ${Date.now()}` } })).json();
    await page.goto(`/app/workflows/${wf.id}`);
    await page.getByRole("button", { name: "Build with AI" }).click();
    const panel = page.getByRole("complementary", { name: "Build with AI" });
    await expect(panel.getByText("test model")).toBeVisible();

    await panel.getByLabel("Message to the builder").fill("When a webhook arrives, check the sentiment and respond");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.getByTestId("builder-summary")).toHaveText("3 added", { timeout: 20_000 });
    await expect(panel.getByTestId("builder-reply").last()).toContainText("Built the workflow");

    const nodes = page.locator('[data-testid^="node-node-"]');
    await expect(nodes).toHaveCount(3);
    await expect(page.locator('[data-testid^="node-node-webhook"]')).toBeVisible();
    let d = await getDraft(page.request, wf.id);
    expect(d.draft.nodes.map((n) => n.type)).toEqual(["trigger.webhook", "ai.sentiment", "core.respond"]);
    expect(d.revision).toBe(1);

    // Undo reverts the canvas and autosave persists it.
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(nodes).toHaveCount(0);
    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 15_000 });
    d = await getDraft(page.request, wf.id);
    expect(d.draft.nodes).toHaveLength(0);

    // Conversation history survives a reload.
    await page.reload();
    await page.getByRole("button", { name: "Build with AI" }).click();
    await expect(panel.getByText("When a webhook arrives, check the sentiment and respond")).toBeVisible();
    await panel.getByRole("button", { name: "Clear conversation" }).click();
    await expect(panel.getByText("Describe what the workflow should do.")).toBeVisible();
  });

  test("builder API validates input and rejects stale revisions", async ({ page }) => {
    const wf = await (await page.request.post("/api/workflows", { data: { name: `Builder API ${Date.now()}` } })).json();
    expect((await page.request.post(`/api/workflows/${wf.id}/builder`, { data: { message: "", expectedRevision: 0 } })).status()).toBe(400);
    expect((await page.request.post(`/api/workflows/${wf.id}/builder`, { data: { message: "x", expectedRevision: 5 } })).status()).toBe(409);
  });
});
