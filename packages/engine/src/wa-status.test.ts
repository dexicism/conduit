import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { describe, expect, it, vi } from "vitest";
import { initialState, runExecution } from "./runner";
import type { EngineServices, Item } from "./types";

function check(state: { status: string; since: string | null; workerRunning: boolean }, nowIso: string, alertAfterMinutes = 10) {
  const g = workflowGraphSchema.parse({
    nodes: [
      { id: "t", type: "trigger.manual", label: "t", position: { x: 0, y: 0 }, parameters: {}, connections: { main: [{ targetId: "s" }] } },
      { id: "s", type: "app.whatsappWeb.status", label: "s", position: { x: 200, y: 0 }, parameters: { ...defaultParameters(getDefinition("app.whatsappWeb.status")!), credential: "wa", alertAfterMinutes }, connections: {} },
    ],
  });
  const services = {
    http: vi.fn(),
    runCode: vi.fn(),
    executeWorkflow: vi.fn(),
    now: () => new Date(nowIso),
    integrations: { apiUrl: (u: string) => u, whatsappWeb: { status: async () => ({ phone: "919800000009", error: null, ...state }) } },
  } as unknown as EngineServices;
  let out: Item[] = [];
  return runExecution({ graph: g, state: initialState(g, "t", [{ json: {} }]), services, hooks: { onStep: (s) => void (s.nodeId === "s" && (out = s.output?.main ?? [])) } }).then(() => out[0]!.json);
}

describe("WhatsApp connection status", () => {
  it("is ok when connected, waits before alerting, and keeps one key per outage", async () => {
    expect(await check({ status: "open", since: "2026-11-27T01:00:00Z", workerRunning: true }, "2026-11-27T03:00:00Z")).toMatchObject({ ok: true, alert: false, outageKey: null, text: "WhatsApp +919800000009 is connected." });
    // Reconnecting for 4 minutes: not yet.
    const short = await check({ status: "reconnecting", since: "2026-11-27T02:56:00Z", workerRunning: true }, "2026-11-27T03:00:00Z");
    expect(short).toMatchObject({ ok: false, alert: false, downMinutes: 4 });
    // Logged out for 25 minutes: alert, and the same key on the next check.
    const long = await check({ status: "logged_out", since: "2026-11-27T02:35:00Z", workerRunning: true }, "2026-11-27T03:00:00Z");
    expect(long).toMatchObject({ ok: false, alert: true, downMinutes: 25, outageKey: "logged_out|2026-11-27T02:35:00Z" });
    expect(long.text).toMatch(/logged out .*for 25 min/);
    const later = await check({ status: "logged_out", since: "2026-11-27T02:35:00Z", workerRunning: true }, "2026-11-27T03:15:00Z");
    expect(later.outageKey).toBe(long.outageKey);
    // Connected but no worker holding the number: not ok.
    expect(await check({ status: "open", since: "2026-11-27T01:00:00Z", workerRunning: false }, "2026-11-27T03:00:00Z", 0)).toMatchObject({ ok: false, alert: true });
  });
});
