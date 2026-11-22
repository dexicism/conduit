/**
 * Checks Google Drive with the real account saved in Connections, through the
 * app's own steps: saves a text file and a CSV as a Google Sheet, finds them,
 * and reads both back. Reconnect Google first if it was connected before Drive
 * was added. Delete the "Conduit test" files afterwards.
 *
 *   npx tsx scripts/try-google-drive.mts
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
  const runtime = createRuntime(db, {}, {}, { integrations });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, next?: string[]) => ({
    id, type, label: id, position: { x, y: 0 },
    parameters: { ...defaultParameters(getDefinition(type)!), ...parameters },
    connections: next ? { main: next.map((targetId) => ({ targetId })) } : {},
  });
  async function run(nodes: ReturnType<typeof node>[]) {
    const graph = workflowGraphSchema.parse({ nodes });
    const id = await runtime.createExecution(
      { workspaceId, workflowId: new ObjectId(), workflowName: "Google Drive check", versionId: null, mode: "test", graph, triggerNodeId: "start", triggerItems: [{ json: {} }] },
      false,
    );
    const done = await runtime.processExecution(id);
    const steps = await runtime.collections.steps.find({ executionId: id }).sort({ index: 1 }).toArray();
    console.log(`Run: ${done.status}${done.error ? ` (${done.error.message})` : ""}`);
    for (const s of steps) console.log(`  ${s.nodeId}: ${s.status} ${JSON.stringify(s.output.main?.map((i) => i.json) ?? s.error).slice(0, 300)}`);
    return Object.fromEntries(steps.map((s) => [s.nodeId, s.output.main?.map((i) => i.json as Record<string, string>) ?? []]));
  }

  const saved = await run([
    node("start", "trigger.manual", 0, {}, ["note", "sheet"]),
    node("note", "app.drive.save", 250, { credential, fileName: `Conduit test ${stamp}.txt`, content: "Saved by Conduit.\nSecond line.", fileType: "text" }),
    node("sheet", "app.drive.save", 250, { credential, fileName: `Conduit test sheet ${stamp}`, content: "Name,Email\nAna,ana@example.com", fileType: "csv", convert: "sheet" }),
  ]);
  if (!saved.note?.[0] || !saved.sheet?.[0]) throw new Error("Saving failed; see above.");
  await run([
    node("start", "trigger.manual", 0, {}, ["find", "readNote", "readSheet"]),
    node("find", "app.drive.find", 250, { credential, nameContains: "Conduit test", limit: 10 }),
    node("readNote", "app.drive.read", 250, { credential, file: saved.note[0].link }),
    node("readSheet", "app.drive.read", 250, { credential, file: saved.sheet[0].id }),
  ]);
} finally {
  await client.close();
}
