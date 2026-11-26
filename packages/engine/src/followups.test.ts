import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { describe, expect, it, vi } from "vitest";
import { initialState, runExecution } from "./runner";
import type { EngineServices, HttpRequest, Item, MemoryTurn } from "./types";

/** A tiny pretend Google Sheets: tabs of rows, read, append and set cells. */
function fakeSheets(tabs: Record<string, string[][]>) {
  const parse = (range: string) => {
    const m = /^'?(.+?)'?!([A-Z]*)(\d+)/.exec(decodeURIComponent(range));
    if (!m) throw new Error(`bad range ${range}`);
    const col = Math.max(0, [...m[2]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1);
    return { tab: m[1]!, col, row: Number(m[3]) - 1 };
  };
  const http = vi.fn(async (r: HttpRequest) => {
    const body = r.body ? JSON.parse(r.body) : {};
    if (r.url.includes("/values:batchUpdate")) {
      for (const d of body.data as Array<{ range: string; values: string[][] }>) {
        const { tab, col, row } = parse(d.range);
        const rows = tabs[tab]!;
        while (rows.length <= row) rows.push([]);
        rows[row]![col] = d.values[0]![0]!;
      }
      return { status: 200, headers: {}, body: {} };
    }
    const m = /\/values\/([^:?]+)(:append)?/.exec(r.url)!;
    const { tab } = parse(m[1]!);
    const rows = tabs[tab];
    if (!rows) return { status: 400, headers: {}, body: { error: { code: 400, message: `Unable to parse range: ${tab}` } } };
    if (m[2]) {
      rows.push((body.values[0] as Array<string | null>).map((v) => v ?? ""));
      return { status: 200, headers: {}, body: { updates: { updatedRange: `${tab}!A${rows.length}:J${rows.length}` } } };
    }
    return { status: 200, headers: {}, body: { values: rows } };
  });
  return { http, tabs };
}

function graph(nodes: Array<{ id: string; type: string; parameters?: Record<string, unknown>; to?: string[] }>): WorkflowGraph {
  return workflowGraphSchema.parse({
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      position: { x: i * 200, y: 0 },
      parameters: { ...defaultParameters(getDefinition(n.type)!), ...n.parameters },
      connections: n.to ? { main: n.to.map((t) => ({ targetId: t })) } : {},
    })),
  });
}

const FU_HEAD = ["ID", "Asked At", "Person", "Phone", "About", "Question", "Status", "Reminders", "Next Reminder", "Answer"];

function setup() {
  const sheets = fakeSheets({
    Team: [["Name", "Phone"], ["Ravi", "+91 98000 00001"], ["Shadab", "+91 98000 00009"]],
    "Follow-ups": [FU_HEAD],
    Activity: [["When", "Who", "Tab", "Row", "Name", "Change"]],
    Enquiries: [["Owner Name", "Phone No.", "Status", "Notes"], ["Mohan", "9800000101", "Site Visit Done", "old note"]],
    "Bot Rules": [["Rule"], ["Quotations go out within 2 days of a site visit"], [""], ["No customer messages after 8 pm"]],
  });
  let now = new Date("2026-11-26T08:00:00Z");
  const sent: Array<{ to: string; text?: string | null }> = [];
  const store = new Map<string, MemoryTurn[]>();
  const services: EngineServices = {
    http: sheets.http,
    runCode: vi.fn(),
    executeWorkflow: vi.fn(),
    now: () => now,
    memory: {
      load: async (n, k) => store.get(`${n}:${k}`) ?? [],
      append: async (n, k, turns) => void store.set(`${n}:${k}`, [...(store.get(`${n}:${k}`) ?? []), ...turns]),
    },
    integrations: {
      apiUrl: (u: string) => u,
      credential: async () => ({ accessToken: "t" }),
      whatsappWeb: {
        send: async (_id: string, m: { to: string; text?: string | null }) => {
          sent.push(m);
          return { messageId: `M${sent.length}`, chatId: `91${m.to.replace(/\D/g, "").slice(-10)}@s.whatsapp.net` };
        },
      },
    } as unknown as EngineServices["integrations"],
  };
  const step = async (type: string, parameters: Record<string, unknown>, input: Record<string, unknown> = {}) => {
    const g = graph([
      { id: "t", type: "trigger.manual", to: ["s"] },
      { id: "s", type, parameters: { credential: "g", spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", ...parameters } },
    ]);
    const outputs: Record<string, Item[]> = {};
    const r = await runExecution({ graph: g, state: initialState(g, "t", [{ json: input }]), services, hooks: { onStep: (s) => void (outputs[s.nodeId] = s.output?.main ?? []) } });
    if (r.status !== "success") throw new Error(r.status === "failed" ? r.error.message : r.status);
    return (outputs.s ?? []).map((i) => i.json);
  };
  return { sheets, sent, store, step, later: (min: number) => (now = new Date(now.getTime() + min * 60_000)) };
}

describe("follow-ups", () => {
  it("asks once, reminds after the wait, gives up after the reminders, and marks answers", async () => {
    const { sheets, sent, store, step, later } = setup();
    const ask = { sheet: "Follow-ups", whatsapp: "wa", person: "Ravi", phonesFrom: "Team", about: "Mohan", question: "Is the quotation for Mohan ready?", waitMinutes: 60 };
    expect(await step("app.followups.ask", ask)).toEqual([expect.objectContaining({ status: "asked", id: "F1", phone: "+91 98000 00001" })]);
    expect(sent).toEqual([{ to: "+91 98000 00001", text: "Is the quotation for Mohan ready?" }]);
    // In Ravi's shared memory, so the assistant understands "done".
    expect(store.get("__shared:919800000001")).toEqual([{ role: "assistant", text: "[Checker asked] Is the quotation for Mohan ready?" }]);
    // Asking the same thing again while waiting does nothing.
    expect((await step("app.followups.ask", ask))[0]).toMatchObject({ status: "already_waiting", id: "F1" });
    expect(sent).toHaveLength(1);

    const remind = { sheet: "Follow-ups", whatsapp: "wa", maxReminders: 2, waitMinutes: 60 };
    expect(await step("app.followups.remind", remind)).toEqual([{ none: true }]); // not yet
    later(61);
    expect((await step("app.followups.remind", remind))[0]).toMatchObject({ action: "reminded", person: "Ravi", reminders: 1 });
    expect(sent.at(-1)!.text).toBe("Reminder: Is the quotation for Mohan ready?");
    later(61);
    expect((await step("app.followups.remind", remind))[0]).toMatchObject({ action: "reminded", reminders: 2 });
    later(61);
    expect((await step("app.followups.remind", remind))[0]).toMatchObject({ action: "gave_up", person: "Ravi", about: "Mohan" });
    expect(sheets.tabs["Follow-ups"]![1]![6]).toBe("No reply");
    expect(sent).toHaveLength(3);

    // A new question, answered when Ravi writes in.
    await step("app.followups.ask", { ...ask, about: "Kiran", question: "When is the site visit at Kiran's?" });
    const marked = await step("app.followups.answered", { sheet: "Follow-ups", phone: "919800000001", answer: "Tomorrow 11 am" });
    expect(marked).toEqual([{ marked: 1, about: ["Kiran"] }]);
    expect(sheets.tabs["Follow-ups"]![2]!.slice(6, 7).concat(sheets.tabs["Follow-ups"]![2]![9]!)).toEqual(["Answered", "Tomorrow 11 am"]);
    // Someone with nothing waiting, or no tab: nothing happens.
    expect(await step("app.followups.answered", { sheet: "Follow-ups", phone: "919800000009", answer: "hi" })).toEqual([{ marked: 0, about: [] }]);
    expect(await step("app.followups.answered", { sheet: "Nope", phone: "919800000009", answer: "hi" })).toEqual([{ marked: 0, about: [] }]);
  });

  it("logs sheet changes to an activity tab, and reads a tab of rules as text", async () => {
    const { sheets, step } = setup();
    await step("app.sheets.update", {
      sheet: "Enquiries",
      column: "Phone No.",
      value: "98000 00101",
      match: "phone",
      columns: [{ key: "Status", value: "Quotation Sent" }, { key: "Notes", value: "" }],
      emptyValues: "keep",
      activitySheet: "Activity",
      activityBy: "Ravi",
    });
    await step("app.sheets.append", { sheet: "Enquiries", columns: [{ key: "Owner Name", value: "Kiran" }, { key: "Phone No.", value: "9800000102" }], activitySheet: "Activity", activityBy: "Shadab" });
    const log = sheets.tabs.Activity!.slice(1).map((r) => [r[1], r[2], r[3], r[4], r[5]]);
    expect(log).toEqual([
      ["Ravi", "Enquiries", "2", "Mohan", "Status: Site Visit Done -> Quotation Sent"],
      ["Shadab", "Enquiries", "3", "Kiran", "Added: Owner Name=Kiran; Phone No.=9800000102"],
    ]);
    expect(sheets.tabs.Activity![1]![0]).toMatch(/^\d{2}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const rules = await step("app.sheets.text", { sheet: "Bot Rules" });
    expect(rules).toEqual([{ text: "Rule:\n- Quotations go out within 2 days of a site visit\n- No customer messages after 8 pm", lines: 2, missing: false }]);
    // Kept for a while: a change isn't seen until the time is up.
    sheets.tabs["Bot Rules"]!.push(["New rule"]);
    expect((await step("app.sheets.text", { sheet: "Bot Rules" }))[0]!.lines).toBe(2);
    expect((await step("app.sheets.text", { sheet: "Bot Rules", cacheMinutes: 0 }))[0]!.lines).toBe(3);
    expect(await step("app.sheets.text", { sheet: "No such tab", cacheMinutes: 0 })).toEqual([{ text: "", lines: 0, missing: true }]);
  });
});
