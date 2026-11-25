/**
 * Checks the real Google connection: creates a "Conduit test" spreadsheet in
 * your Drive, then runs the app's own Sheets steps: add a row, find it, update it, read it back.
 * Uses the Google account saved in Connections. Run with the database running:
 *
 *   npx tsx scripts/try-google-sheets.mts
 */
import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { createRuntime, integrationsFromEnv } from "@conduit/runtime";
import { MongoClient, ObjectId } from "mongodb";

const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0");
const db = client.db(process.env.MONGODB_DB ?? "conduit");
try {
  const cred = await db.collection("credentials").findOne({ app: "google" }, { sort: { createdAt: -1 } });
  if (!cred) throw new Error("No Google account saved. Connect one in Connections first.");
  const workspaceId = cred.workspaceId as ObjectId;
  const credential = String(cred._id);
  const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: false });

  // 1. A new spreadsheet with a header row.
  const { values } = await integrations.resolve(workspaceId, credential, "google");
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { authorization: `Bearer ${values.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      properties: { title: `Conduit test ${new Date().toISOString().slice(0, 16).replace("T", " ")}` },
      sheets: [{ properties: { title: "Leads" }, data: [{ rowData: [{ values: ["Name", "Email", "Note"].map((v) => ({ userEnteredValue: { stringValue: v } })) }] }] }],
    }),
  });
  const sheet = (await res.json()) as { spreadsheetId?: string; spreadsheetUrl?: string; error?: { message: string } };
  if (!res.ok || !sheet.spreadsheetId) throw new Error(`Creating the spreadsheet failed: ${sheet.error?.message ?? res.status}`);
  console.log(`Created: ${sheet.spreadsheetUrl}`);

  // 2. The app's own steps: add a row, find it by name, change one cell, read the rows.
  const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, next?: string) => ({
    id, type, label: id, position: { x, y: 0 },
    parameters: { ...defaultParameters(getDefinition(type)!), ...parameters },
    connections: next ? { main: [{ targetId: next }] } : {},
  });
  const graph = workflowGraphSchema.parse({
    nodes: [
      node("start", "trigger.manual", 0, {}, "add"),
      node("add", "app.sheets.append", 250, {
        credential, spreadsheetId: sheet.spreadsheetUrl, sheet: "Leads",
        columns: [{ key: "name", value: "Ana" }, { key: "Email", value: "ana@example.com" }, { key: "Note", value: "added by Conduit" }],
      }, "find"),
      node("find", "app.sheets.find", 500, { credential, spreadsheetId: sheet.spreadsheetId, sheet: "Leads", column: "Name", value: "ana", match: "equals" }, "update"),
      node("update", "app.sheets.update", 750, {
        credential, spreadsheetId: sheet.spreadsheetId, sheet: "Leads", findBy: "value", column: "Email", value: "ANA@example.com",
        columns: [{ key: "Note", value: "updated by Conduit" }], ifMissing: "fail", ifMany: "fail",
      }, "read"),
      node("read", "app.sheets.read", 1000, { credential, spreadsheetId: sheet.spreadsheetId, sheet: "Leads", limit: 10 }),
    ],
  });
  const runtime = createRuntime(db, {}, {}, { integrations });
  const workflowId = new ObjectId();
  const id = await runtime.createExecution(
    { workspaceId, workflowId, workflowName: "Google Sheets check", versionId: null, mode: "test", graph, triggerNodeId: "start", triggerItems: [{ json: {} }] },
    false,
  );
  const done = await runtime.processExecution(id);
  const steps = await runtime.collections.steps.find({ executionId: id }).sort({ index: 1 }).toArray();
  console.log(`Run: ${done.status}${done.error ? ` (${done.error.message})` : ""}`);
  for (const s of steps) console.log(`  ${s.nodeId}: ${s.status} ${JSON.stringify(s.output.main?.map((i) => i.json) ?? s.error)}`);
} finally {
  await client.close();
}
