import { expect, test, type APIRequestContext } from "@playwright/test";
import { createHash, createHmac, randomBytes } from "node:crypto";

const FAKE = "http://127.0.0.1:3199";

test.use({ storageState: "e2e/.auth/user.json", viewport: { width: 1440, height: 900 } });

type N = { id: string; type: string; label?: string; parameters?: Record<string, unknown>; to?: string[] };

async function workflowWith(request: APIRequestContext, name: string, list: N[]) {
  const wf = await (await request.post("/api/workflows", { data: { name: `${name} ${Date.now()}` } })).json();
  const nodes = list.map((n, i) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    position: { x: i * 260, y: 0 },
    parameters: n.parameters ?? {},
    connections: n.to ? { main: n.to.map((t) => ({ targetId: t })) } : {},
  }));
  const res = await request.put(`/api/workflows/${wf.id}/draft`, { data: { expectedRevision: 0, graph: { nodes } } });
  expect(res.status(), await res.text()).toBe(200);
  return wf.id as string;
}

const setStep = (id: string, name: string, value: string): N => ({
  id,
  type: "core.set",
  parameters: { assignments: [{ id: "a", name, value, type: "string" }] },
});

test.describe("API keys and the public API", () => {
  test("create a key in settings, use it with scopes, run a published workflow, revoke", async ({ page, playwright, baseURL }) => {
    await page.goto("/app/settings");
    const form = page.getByRole("form", { name: "Create an API key" });
    await form.getByLabel("Key name").fill(`CI ${Date.now()}`);
    await form.getByLabel("Edit workflow drafts").uncheck().catch(() => undefined);
    await form.getByRole("button", { name: "Create key" }).click();
    const key = await page.getByLabel("New API key").inputValue();
    expect(key).toMatch(/^cdt_[A-Za-z0-9_-]{8}_/);

    const none = { cookies: [], origins: [] };
    const api = await playwright.request.newContext({ baseURL, storageState: none, extraHTTPHeaders: { authorization: `Bearer ${key}` } });
    const anon = await playwright.request.newContext({ baseURL, storageState: none });
    expect((await api.get("/api/v1/workflows")).status()).toBe(200);
    expect((await anon.get("/api/v1/workflows")).status()).toBe(401);
    // A browser session doesn't work on the key-only API, and keys don't reach session routes.
    expect((await page.request.get("/api/v1/workflows")).status()).toBe(401);
    expect((await api.get("/api/credentials")).status()).toBe(401);
    expect((await api.get("/api/workspace/members")).status()).toBe(401);

    const id = await workflowWith(page.request, "API run", [{ id: "start", type: "trigger.manual", to: ["set"] }, setStep("set", "greeting", "Hi ${['$input']['name']}")]);
    expect((await api.post(`/api/v1/workflows/${id}/run`, { data: { input: { name: "Ana" } } })).status()).toBe(409); // not published
    expect((await page.request.post(`/api/workflows/${id}/publish`)).status()).toBe(200);
    const run = await api.post(`/api/v1/workflows/${id}/run`, { data: { input: { name: "Ana" } } });
    expect(run.status(), await run.text()).toBe(202);
    const { executionId } = await run.json();
    await expect.poll(async () => (await (await api.get(`/api/v1/executions/${executionId}`)).json()).status, { timeout: 20_000 }).toBe("success");
    const detail = await (await api.get(`/api/v1/executions/${executionId}`)).json();
    expect(JSON.stringify(detail.steps)).toContain("Hi Ana");

    // Revoke: the key stops working.
    await page.reload();
    const row = page.getByRole("list", { name: "API keys" }).getByRole("listitem").first();
    await row.getByRole("button", { name: /^Revoke/ }).click();
    await expect.poll(async () => (await api.get("/api/v1/workflows")).status()).toBe(401);
    await api.dispose();
    await anon.dispose();
  });

  test("a key without a scope is refused for that action", async ({ page, playwright, baseURL }) => {
    const created = await (await page.request.post("/api/workspace/api-keys", { data: { name: "read only", scopes: ["workflows:read"] } })).json();
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${created.key}` } });
    expect((await api.get("/api/v1/workflows")).status()).toBe(200);
    expect((await api.get("/api/v1/executions")).status()).toBe(403);
    // Tampered secret with a real prefix.
    const tampered = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${created.key.slice(0, -2)}xx` } });
    expect((await tampered.get("/api/v1/workflows")).status()).toBe(401);
    await api.dispose();
    await tampered.dispose();
  });
});

test.describe("Outbound webhooks", () => {
  test("test delivery, then a live run delivers a signed event", async ({ page }) => {
    await page.request.get(`${FAKE}/__reset`);
    await page.goto("/app/settings");
    await page.getByLabel("Endpoint URL").fill(`${FAKE}/echo.test/conduit-${Date.now()}`);
    await page.getByRole("button", { name: "Add webhook" }).click();
    const secret = await page.getByLabel("Signing secret").inputValue();
    expect(secret).toMatch(/^whsec_/);
    await page.getByRole("button", { name: "Done" }).click();
    const item = page.getByRole("list", { name: "Webhooks" }).getByRole("listitem").first();
    await item.getByRole("button", { name: /Send a test event/ }).click();
    await expect(page.getByText("Test event delivered")).toBeVisible();

    const id = await workflowWith(page.request, "Hooked", [{ id: "start", type: "trigger.manual" }]);
    await page.request.post(`/api/workflows/${id}/publish`);
    const key = (await (await page.request.post("/api/workspace/api-keys", { data: { name: "hook run", scopes: ["executions:run"] } })).json()).key;
    await page.request.post(`/api/v1/workflows/${id}/run`, { data: {}, headers: { authorization: `Bearer ${key}` } });

    await expect
      .poll(async () => {
        const calls = (await (await page.request.get(`${FAKE}/__calls`)).json()) as Array<{ host: string; headers: Record<string, string>; body: { type?: string; data?: { workflowId?: string } } }>;
        return calls.filter((c) => c.host === "echo.test" && c.body?.data?.workflowId === id).length;
      }, { timeout: 20_000 })
      .toBe(1);
    const calls = (await (await page.request.get(`${FAKE}/__calls`)).json()) as Array<{ host: string; headers: Record<string, string>; body: { type: string; data: { workflowId?: string } } }>;
    const delivery = calls.find((c) => c.host === "echo.test" && c.body?.data?.workflowId === id)!;
    expect(delivery.body.type).toBe("execution.completed");
    const sig = delivery.headers["conduit-signature"]!;
    const t = /t=(\d+)/.exec(sig)![1]!;
    const body = JSON.stringify(delivery.body);
    expect(sig).toBe(`t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`);

    // Clean up so later runs don't deliver here.
    await page.reload();
    await page.getByRole("list", { name: "Webhooks" }).getByRole("listitem").first().getByRole("button", { name: /^Remove/ }).click();
  });
});

test.describe("Form trigger", () => {
  test("a published form validates input and starts a run with the answers", async ({ page, browser }) => {
    const path = `e2e-form-${Date.now()}`;
    const id = await workflowWith(page.request, "Lead form", [
      {
        id: "form",
        type: "trigger.form",
        parameters: {
          title: "Request a demo",
          path,
          submitLabel: "Send",
          successMessage: "Thanks, we'll be in touch.",
          questions: [
            { id: "1", name: "email", label: "Work email", type: "email", required: true },
            { id: "2", name: "size", label: "Team size", type: "select", required: true, options: "1-10, 11-50, 51+" },
            { id: "3", name: "notes", label: "Anything else?", type: "textarea", required: false },
          ],
        },
        to: ["set"],
      },
      setStep("set", "lead", "${['$input']['fields']['email']}"),
    ]);
    const pub = await (await page.request.post(`/api/workflows/${id}/publish`)).json();
    expect(pub.triggers[0]).toMatchObject({ kind: "form" });

    // A visitor (not signed in).
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const vp = await visitor.newPage();
    await vp.goto(`/form/${path}`);
    await expect(vp.getByRole("heading", { name: "Request a demo" })).toBeVisible();
    await vp.getByLabel("Work email").fill("not-an-email");
    await vp.getByRole("button", { name: "Send" }).click();
    await expect(vp.getByText("Enter a valid email address")).toBeVisible();
    await expect(vp.getByText("This is required")).toBeVisible();
    await vp.getByLabel("Work email").fill("lead@example.com");
    await vp.getByLabel("Team size").selectOption("11-50");
    await vp.getByRole("button", { name: "Send" }).click();
    await expect(vp.getByRole("status")).toHaveText("Thanks, we'll be in touch.");
    await visitor.close();

    await expect
      .poll(async () => (await (await page.request.get(`/api/executions?workflowId=${id}`)).json()).data[0]?.status, { timeout: 20_000 })
      .toBe("success");
    const list = await (await page.request.get(`/api/executions?workflowId=${id}`)).json();
    const detail = await (await page.request.get(`/api/executions/${list.data[0].id}`)).json();
    expect(JSON.stringify(detail)).toContain("lead@example.com");
    expect(JSON.stringify(detail)).toContain("11-50");

    // Unpublished forms disappear.
    await page.request.delete(`/api/workflows/${id}/publish`);
    await page.goto(`/form/${path}`);
    await expect(page.getByRole("heading", { name: "This form isn't available" })).toBeVisible();
  });
});

test.describe("MCP server", () => {
  test("OAuth (DCR + PKCE + consent), tools, draft-only edits, test run, refresh rotation", async ({ page, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    // Discovery.
    const unauth = await anon.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(unauth.status()).toBe(401);
    expect(unauth.headers()["www-authenticate"]).toContain("/.well-known/oauth-protected-resource");
    const prm = await (await anon.get("/.well-known/oauth-protected-resource")).json();
    expect(prm.resource).toBe(`${baseURL}/api/mcp`);
    const asm = await (await anon.get("/.well-known/oauth-authorization-server")).json();
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);

    // Register a client and authorize in the browser.
    const redirect = "http://127.0.0.1:59999/callback";
    const reg = await (await anon.post(asm.registration_endpoint.replace(baseURL!, ""), { data: { client_name: "Test Assistant", redirect_uris: [redirect] } })).json();
    expect((await anon.post("/api/oauth/register", { data: { redirect_uris: ["http://evil.example.com/cb"] } })).status()).toBe(400);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st8", scope: "workflows:read workflows:write executions:run" });
    // Approving answers with a 303 to the client's redirect URI; read it from the response.
    const approve = async () => {
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/oauth/authorize") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Allow" }).click(),
      ]);
      expect(res.status()).toBe(303);
      return new URL(res.headers()["location"]!);
    };
    await page.goto(`/oauth/authorize?${q}`);
    await expect(page.getByRole("heading", { name: /Allow “Test Assistant”/ })).toBeVisible();
    const cb = await approve();
    expect(cb.origin + cb.pathname).toBe(redirect);
    expect(cb.searchParams.get("state")).toBe("st8");

    const token = (form: Record<string, string>) => anon.post("/api/oauth/token", { form });
    const bad = await token({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, redirect_uri: redirect, client_id: reg.client_id, code_verifier: "wrong".padEnd(43, "x") });
    expect(bad.status()).toBe(400); // and the code is now burned
    // Fresh code for the real exchange.
    await page.goto(`/oauth/authorize?${q}`);
    const cb2 = await approve();
    const tok = await (await token({ grant_type: "authorization_code", code: cb2.searchParams.get("code")!, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier })).json();
    expect(tok.access_token).toMatch(/^mcp_at_/);

    const mcp = (accessToken: string, method: string, params: Record<string, unknown> = {}, id = 1) =>
      anon.post("/api/mcp", { data: { jsonrpc: "2.0", id, method, params }, headers: { authorization: `Bearer ${accessToken}` } });
    const init = await (await mcp(tok.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await anon.post("/api/mcp", { data: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { authorization: `Bearer ${tok.access_token}` } })).status()).toBe(202);
    const tools = (await (await mcp(tok.access_token, "tools/list")).json()).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_workflows", "get_workflow", "find_steps", "describe_step", "create_workflow", "apply_changes", "test_workflow"]));
    expect(tools).not.toContain("get_execution"); // executions:read wasn't granted

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await (await mcp(tok.access_token, "tools/call", { name, arguments: args })).json();
      return { isError: Boolean(r.result.isError), data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
    };
    const created = await call("create_workflow", { name: `From MCP ${Date.now()}` });
    const bad1 = await call("apply_changes", { workflowId: created.data.id, expectedRevision: created.data.revision, nodes: [{ id: "x", type: "no.such", label: "x" }] });
    expect(bad1.data.saved).toBe(false);
    const ok = await call("apply_changes", {
      workflowId: created.data.id,
      expectedRevision: created.data.revision,
      nodes: [
        { id: "start", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 }, connections: { main: [{ targetId: "set" }] } },
        { id: "set", type: "core.set", label: "Set", position: { x: 260, y: 0 }, parameters: { assignments: [{ id: "a", name: "via", value: "mcp", type: "string" }] } },
      ],
    });
    expect(ok.data).toMatchObject({ saved: true, revision: created.data.revision + 1 });
    const stale = await call("apply_changes", { workflowId: created.data.id, expectedRevision: 0, deleted: ["set"] });
    expect(stale.isError).toBe(true);
    const run = await call("test_workflow", { workflowId: created.data.id });
    expect(run.data.status).toBe("success");
    expect(JSON.stringify(run.data.steps)).toContain('"via":"mcp"');
    // Draft only: still unpublished.
    expect((await (await page.request.get(`/api/workflows/${created.data.id}`)).json()).status).toBe("draft");

    // Refresh rotates; reusing the old refresh token revokes the grant.
    const r1 = await (await token({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
    expect(r1.access_token).not.toBe(tok.access_token);
    expect((await token({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).status()).toBe(400);
    expect((await mcp(r1.access_token, "ping")).status()).toBe(401);
    await anon.dispose();
  });
});
