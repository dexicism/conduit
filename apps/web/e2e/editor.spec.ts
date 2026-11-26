import { expect, test, type Page } from "@playwright/test";

test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

interface DraftNode {
  id: string;
  type: string;
  label: string;
  parameters: Record<string, unknown>;
  position: { x: number; y: number };
  connections: Record<string, Array<{ targetId: string; targetHandle?: string }>>;
}
interface Detail {
  id: string;
  revision: number;
  draft: { nodes: DraftNode[]; stickyNotes: Array<{ id: string; text: string }>; orientation: string };
}

async function createWorkflow(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/workflows", { data: { name } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function getDraft(page: Page, id: string): Promise<Detail> {
  return (await (await page.request.get(`/api/workflows/${id}`)).json()) as Detail;
}

/** Waits until the editor has persisted everything (status reads "Saved" after a save). */
async function waitSaved(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 15_000 });
}

async function pick(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Search steps" }).fill(name);
  await dialog.getByRole("option", { name: new RegExp(`^${name}`) }).first().click();
  await expect(dialog).toHaveCount(0);
}

async function closePanel(page: Page) {
  await page.getByRole("button", { name: "Close panel" }).click();
}

test.describe("workflow editor", () => {
  test("empty state, add trigger and a connected step, configure, persist", async ({ page }) => {
    const id = await createWorkflow(page, `Editor basics ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);

    await expect(page.getByText("Start with a trigger")).toBeVisible();
    await page.getByRole("button", { name: "Add a trigger" }).click();
    const options = page.getByRole("dialog").getByRole("option");
    await expect(options.filter({ hasText: /^HTTP request/ })).toHaveCount(0); // triggers only
    await pick(page, "Webhook");

    // Config panel opens with a generated path.
    const panel = page.getByRole("complementary", { name: "Configure Webhook" });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Path")).toHaveValue(/^[a-z0-9]{16}$/);
    await closePanel(page);

    // Add a step from the node's "+" handle: connects automatically, triggers are not offered.
    await page.getByRole("button", { name: "Add a step after Webhook" }).click();
    await expect(page.getByRole("dialog").getByRole("option").filter({ hasText: /^Schedule/ })).toHaveCount(0);
    await pick(page, "HTTP request");
    const http = page.getByRole("complementary", { name: "Configure HTTP request" });

    // Validation: bad URL shows an error and an issue badge on the node.
    await http.getByLabel("URL*").fill("not a url");
    await expect(http.getByText("Enter a full URL starting with http:// or https://")).toBeVisible();
    await expect(page.getByTestId("node-node-http-request").getByTestId("node-issues")).toBeVisible();

    // Insert data from the webhook via the variable picker; preview resolves the example.
    await http.getByLabel("URL*").fill("https://api.example.com/leads?email=");
    await http.getByRole("button", { name: "Insert data into URL" }).click();
    // body.email is offered under "Previous step" ($input) and under the Webhook by ID; take the first.
    await page.getByTitle("Insert body.email").first().click();
    await expect(http.getByLabel("URL*")).toHaveValue("https://api.example.com/leads?email=${['$input']['body']['email']}");
    await expect(http.getByText("Example:")).toBeVisible();
    await expect(http.getByText("https://api.example.com/leads?email=lead@example.com")).toBeVisible();
    await expect(page.getByTestId("node-node-http-request").getByTestId("node-issues")).toHaveCount(0);

    // Conditional fields: body appears only for methods that send one.
    await expect(http.getByLabel("Body", { exact: true })).toHaveCount(0);
    await expect(http.getByRole("textbox", { name: "JSON body" })).toHaveCount(0);
    await http.getByLabel("Method").selectOption("POST");
    await expect(http.getByLabel("Body", { exact: true })).toBeVisible();
    await expect(http.getByRole("textbox", { name: "JSON body" })).toBeVisible();

    // Rename the step.
    await http.getByLabel("Step name").fill("Look up lead");
    await waitSaved(page);

    const saved = await getDraft(page, id);
    expect(saved.draft.nodes.map((n) => n.type)).toEqual(["trigger.webhook", "core.http"]);
    const [hook, req] = saved.draft.nodes;
    expect(hook!.connections.main).toEqual([{ targetId: req!.id }]);
    expect(req!.label).toBe("Look up lead");
    expect(req!.parameters.method).toBe("POST");
    expect(req!.parameters.url).toBe("https://api.example.com/leads?email=${['$input']['body']['email']}");

    await page.reload();
    await expect(page.getByTestId(`node-${req!.id}`)).toContainText("Look up lead");
    await expect(page.getByText("Start with a trigger")).toHaveCount(0);
  });

  test("branching handles, undo/redo, duplicate, delete", async ({ page }) => {
    const id = await createWorkflow(page, `Editor branches ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Manual start");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after Manual start" }).click();
    await pick(page, "If");
    await closePanel(page);

    // If has separate true/false outputs, each with its own add button.
    await page.getByRole("button", { name: "Add a step after If (true)" }).click();
    await pick(page, "Set fields");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after If (false)" }).click();
    await pick(page, "Text");
    await closePanel(page);
    await waitSaved(page);

    let d = await getDraft(page, id);
    const ifNode = d.draft.nodes.find((n) => n.type === "flow.if")!;
    expect(Object.keys(ifNode.connections).sort()).toEqual(["false", "true"]);

    // Delete the Text step with the keyboard, then undo and redo.
    await page.getByTestId("node-node-text").click();
    await closePanel(page);
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("node-node-text")).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("node-node-text")).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByTestId("node-node-text")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByTestId("node-node-text")).toBeVisible();
    await waitSaved(page);
    d = await getDraft(page, id);
    expect(d.draft.nodes.find((n) => n.type === "flow.if")!.connections.false).toEqual([{ targetId: "node-text" }]);

    // Duplicate with Ctrl+D keeps parameters but gets a new ID and label.
    await page.getByTestId("node-node-set-fields").click();
    await closePanel(page);
    await page.keyboard.press("Control+d");
    await expect(page.getByTestId("node-node-set-fields-2")).toBeVisible();
    await waitSaved(page);
    d = await getDraft(page, id);
    expect(d.draft.nodes.map((n) => n.label)).toContain("Set fields 2");
  });

  test("switch cases create matching outputs; removing a case drops its edge", async ({ page }) => {
    const id = await createWorkflow(page, `Editor switch ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Manual start");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after Manual start" }).click();
    await pick(page, "Switch");
    const panel = page.getByRole("complementary", { name: "Configure Switch" });
    await panel.getByLabel("Case 1 value").fill("admin");
    await panel.getByRole("button", { name: "Add case" }).click();
    await panel.getByLabel("Case 2 value").fill("guest");
    await closePanel(page);

    await page.getByRole("button", { name: "Add a step after Switch (guest)" }).click();
    await pick(page, "JSON");
    await closePanel(page);
    await waitSaved(page);
    let d = await getDraft(page, id);
    let sw = d.draft.nodes.find((n) => n.type === "flow.switch")!;
    expect(Object.keys(sw.connections)).toHaveLength(1);

    await page.getByTestId(`node-${sw.id}`).click();
    await page.getByRole("button", { name: "Remove case 2" }).click();
    await closePanel(page);
    await waitSaved(page);
    d = await getDraft(page, id);
    sw = d.draft.nodes.find((n) => n.type === "flow.switch")!;
    expect(sw.connections).toEqual({});
  });

  test("sticky notes, orientation and tidy-up persist", async ({ page }) => {
    const id = await createWorkflow(page, `Editor layout ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Schedule");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after Schedule" }).click();
    await pick(page, "Wait");
    await closePanel(page);

    await page.getByRole("button", { name: "Add note" }).click();
    await page.getByLabel("Note text").fill("Runs every hour, then waits");
    await page.getByLabel("Note text").press("Escape");
    await expect(page.getByText("Runs every hour, then waits")).toBeVisible();

    await page.getByRole("button", { name: "Switch to vertical layout" }).click();
    await expect(page.getByRole("button", { name: "Switch to horizontal layout" })).toBeVisible();
    await waitSaved(page);
    let d = await getDraft(page, id);
    expect(d.draft.orientation).toBe("vertical");
    expect(d.draft.stickyNotes[0]?.text).toBe("Runs every hour, then waits");
    const [a, b] = d.draft.nodes;
    expect(b!.position.y).toBeGreaterThan(a!.position.y + 40); // stacked vertically

    await page.getByRole("button", { name: "Switch to horizontal layout" }).click();
    await expect(page.getByRole("button", { name: "Switch to vertical layout" })).toBeVisible();
    await waitSaved(page);
    d = await getDraft(page, id);
    const [a2, b2] = d.draft.nodes;
    expect(d.draft.orientation).toBe("horizontal");
    expect(b2!.position.x).toBeGreaterThan(a2!.position.x + 100);

    await page.reload();
    await expect(page.getByText("Runs every hour, then waits")).toBeVisible();
  });

  test("drawing a connection by drag, and the cycle rule", async ({ page }) => {
    const id = await createWorkflow(page, `Editor drag ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Manual start");
    await closePanel(page);
    // A free-standing step (added from the toolbar, not connected).
    await page.getByRole("button", { name: "Add step", exact: true }).first().click();
    await pick(page, "Math");
    await closePanel(page);
    await page.getByRole("button", { name: "Tidy up layout" }).click();

    const out = page.getByTestId("node-node-manual-start").getByLabel("Output main");
    const into = page.getByTestId("node-node-math").getByLabel("Input");
    await out.dragTo(into);
    await waitSaved(page);
    let d = await getDraft(page, id);
    expect(d.draft.nodes.find((n) => n.id === "node-manual-start")!.connections.main).toEqual([{ targetId: "node-math" }]);

    // Triggers can't receive connections: dragging Math -> trigger does nothing.
    await page.getByTestId("node-node-math").getByLabel("Output main").dragTo(page.getByTestId("node-node-manual-start"));
    await page.waitForTimeout(300);
    d = await getDraft(page, id);
    expect(d.draft.nodes.find((n) => n.id === "node-math")!.connections).toEqual({});
  });

  test("copy and paste steps through the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await createWorkflow(page, `Editor clipboard ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Manual start");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after Manual start" }).click();
    await pick(page, "Date & time");
    await closePanel(page);

    await page.getByTestId("node-node-date-time").click();
    await closePanel(page);
    await page.keyboard.press("Control+c");
    await expect(page.getByText("Copied 1 item(s)")).toBeVisible();
    await page.keyboard.press("Control+v");
    await expect(page.getByTestId("node-node-date-time-2")).toBeVisible();
    await waitSaved(page);
    const d = await getDraft(page, id);
    expect(d.draft.nodes.filter((n) => n.type === "transform.date")).toHaveLength(2);
  });

  test("conflicting edits in two tabs are detected and resolvable", async ({ page, context }) => {
    const id = await createWorkflow(page, `Editor conflict ${Date.now()}`);
    const other = await context.newPage();
    await page.goto(`/app/workflows/${id}`);
    await other.goto(`/app/workflows/${id}`);

    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Webhook");
    await waitSaved(page);

    await other.getByRole("button", { name: "Add a trigger" }).click();
    await pick(other, "Schedule");
    await expect(other.getByRole("alert").filter({ hasText: "changed in another tab" })).toBeVisible();
    await expect(other.getByTestId("save-status")).toHaveText("Not saved");

    await other.getByRole("button", { name: "Load latest version" }).click();
    await expect(other.getByTestId("node-node-webhook")).toBeVisible();
    await expect(other.getByTestId("node-node-schedule")).toHaveCount(0);

    // "Keep my version" path: make page stale, then keep its edit.
    await other.getByRole("button", { name: "Add a step after Webhook" }).click();
    await pick(other, "Code");
    await waitSaved(other);
    await page.getByRole("button", { name: "Add a step after Webhook" }).click();
    await pick(page, "Filter");
    await page.getByRole("button", { name: "Keep my version" }).click();
    await waitSaved(page);
    const d = await getDraft(page, id);
    expect(d.draft.nodes.map((n) => n.type).sort()).toEqual(["flow.filter", "trigger.webhook"]);
    await other.close();
  });
});

test.describe("draft API", () => {
  test("rejects stale revisions and invalid graphs", async ({ page }) => {
    const id = await createWorkflow(page, `Draft API ${Date.now()}`);
    const graph = {
      nodes: [
        { id: "a", type: "core.set", label: "A", position: { x: 0, y: 0 }, connections: { main: [{ targetId: "b" }] } },
        { id: "b", type: "core.set", label: "B", position: { x: 200, y: 0 } },
      ],
    };
    const ok = await page.request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision: 0, graph } });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).revision).toBe(1);

    const stale = await page.request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision: 0, graph } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "revision_conflict" });

    const cyclic = { nodes: [graph.nodes[0], { ...graph.nodes[1], connections: { main: [{ targetId: "a" }] } }] };
    const bad = await page.request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision: 1, graph: cyclic } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).message).toMatch(/cycle/);

    const unknown = { nodes: [{ id: "x", type: "evil.node", label: "X", position: { x: 0, y: 0 } }] };
    expect((await page.request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision: 1, graph: unknown } })).status()).toBe(400);
    const dangling = { nodes: [{ ...graph.nodes[0] }] };
    expect((await page.request.put(`/api/workflows/${id}/draft`, { data: { expectedRevision: 1, graph: dangling } })).status()).toBe(400);
  });

  test("file and team steps: add Make Excel, its fields follow the source; a Checker template opens", async ({ page }) => {
    const id = await createWorkflow(page, `Editor files ${Date.now()}`);
    await page.goto(`/app/workflows/${id}`);
    await page.getByRole("button", { name: "Add a trigger" }).click();
    await pick(page, "Manual start");
    await closePanel(page);
    await page.getByRole("button", { name: "Add a step after Manual start" }).click();
    await pick(page, "Make Excel file");
    const panel = page.getByRole("complementary", { name: "Configure Make Excel file" });
    await expect(panel.getByLabel("Table", { exact: true })).toBeVisible();
    await expect(panel.getByText("Spreadsheet", { exact: true })).toHaveCount(0);
    await panel.getByLabel("Rows from").selectOption("sheet");
    await expect(panel.getByLabel("Table", { exact: true })).toHaveCount(0);
    await expect(panel.getByLabel("Only rows where column", { exact: true })).toBeVisible();
    await closePanel(page);
    await waitSaved(page);
    const d = await getDraft(page, id);
    expect(d.draft.nodes.find((n) => n.type === "doc.excel")!.parameters.source).toBe("sheet");

    // The checker template: an AI agent with a tracked "ask someone" tool.
    const res = await page.request.post("/api/templates/lead-checker");
    expect(res.status()).toBe(201);
    const wf = await res.json();
    expect(wf.draft.nodes.map((n: { type: string }) => n.type)).toEqual(["trigger.schedule", "app.sheets.text", "app.tasks.due", "app.sheets.text", "ai.agent", "tool.app.followups.ask", "app.whatsappWeb.send"]);
    await page.goto(`/app/workflows/${wf.id}`);
    await expect(page.getByText("Ask someone (tracked)")).toBeVisible();
    await expect(page.getByText("Follow-up questions")).toBeVisible();
  });
});
