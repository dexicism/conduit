/**
 * Checks Gmail and Calendar with the real Google account saved in Connections:
 * sends one email to TO (your own address) and creates one event tomorrow
 * 10:00-10:30 in TZ, with no invitations. Both are real, so delete them after.
 *
 *   TO=you@gmail.com TZ_NAME=Asia/Kolkata npx tsx scripts/try-google-mail-calendar.mts
 */
import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { createRuntime, integrationsFromEnv } from "@conduit/runtime";
import { MongoClient, ObjectId } from "mongodb";

const to = process.env.TO;
if (!to) throw new Error("Set TO to your own email address");
const tz = process.env.TZ_NAME ?? "UTC";
const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0");
const db = client.db(process.env.MONGODB_DB ?? "conduit");
try {
  const cred = await db.collection("credentials").findOne({ app: "google" }, { sort: { createdAt: -1 } });
  if (!cred) throw new Error("No Google account saved. Connect one in Connections first.");
  const workspaceId = cred.workspaceId as ObjectId;
  const credential = String(cred._id);
  const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: false });
  const day = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });

  const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, next?: string) => ({
    id, type, label: id, position: { x, y: 0 },
    parameters: { ...defaultParameters(getDefinition(type)!), ...parameters },
    connections: next ? { main: [{ targetId: next }] } : {},
  });
  const graph = workflowGraphSchema.parse({
    nodes: [
      node("start", "trigger.manual", 0, {}, "mail"),
      node("mail", "app.gmail.send", 250, {
        credential, to, subject: "Conduit test",
        body: "This email was sent by your Conduit app through Gmail, to check the Google connection. You can delete it.",
      }, "event"),
      node("event", "app.calendar.create", 500, {
        credential, calendarId: "primary", summary: "Conduit test",
        start: `${day}T10:00:00`, end: `${day}T10:30:00`, timeZone: tz,
        description: "Created by Conduit to check the Google connection. You can delete it.",
      }),
    ],
  });
  const runtime = createRuntime(db, {}, {}, { integrations });
  const id = await runtime.createExecution(
    { workspaceId, workflowId: new ObjectId(), workflowName: "Gmail and Calendar check", versionId: null, mode: "test", graph, triggerNodeId: "start", triggerItems: [{ json: {} }] },
    false,
  );
  const done = await runtime.processExecution(id);
  const steps = await runtime.collections.steps.find({ executionId: id }).sort({ index: 1 }).toArray();
  console.log(`Run: ${done.status}${done.error ? ` (${done.error.message})` : ""}`);
  for (const s of steps) console.log(`  ${s.nodeId}: ${s.status} ${JSON.stringify(s.output.main?.map((i) => i.json) ?? s.error)}`);
} finally {
  await client.close();
}
