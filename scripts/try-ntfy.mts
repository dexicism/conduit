/**
 * Sends a real push notification through ntfy.sh using the app's own ntfy step.
 * Uses your saved ntfy connection, or makes one (it has no secrets) if there isn't one.
 * Then reads the topic back from ntfy.sh to prove the message arrived.
 *
 *   TOPIC=my-hard-to-guess-topic npx tsx scripts/try-ntfy.mts
 */
import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { createRuntime, integrationsFromEnv } from "@conduit/runtime";
import { MongoClient, ObjectId } from "mongodb";

const topic = process.env.TOPIC;
if (!topic) throw new Error("Set TOPIC to the topic you subscribed to in the ntfy app");

const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0");
const db = client.db(process.env.MONGODB_DB ?? "conduit");
try {
  const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: false });
  let cred = await db.collection("credentials").findOne({ app: "ntfy" }, { sort: { createdAt: -1 } });
  if (!cred) {
    // Put it in the same workspace as your other connections.
    const any = await db.collection("credentials").findOne({}, { sort: { createdAt: -1 } });
    const ws = any?.workspaceId ?? (await db.collection("workspaces").findOne({}))?._id;
    if (!ws) throw new Error("Sign in to Conduit once first, so there's a workspace");
    const owner = (await db.collection("workspaces").findOne({ _id: ws }))?.ownerId;
    const doc = await integrations.create({ workspaceId: ws, userId: String(owner ?? "script"), app: "ntfy", label: "ntfy", values: { server: "https://ntfy.sh" } });
    cred = await db.collection("credentials").findOne({ _id: doc._id });
    console.log("Made an ntfy connection (server https://ntfy.sh).");
  }
  const workspaceId = cred!.workspaceId as ObjectId;
  console.log(`Account check: ${await integrations.check("ntfy", { server: "https://ntfy.sh" })}`);

  const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, next?: string) => ({
    id, type, label: id, position: { x, y: 0 },
    parameters: { ...defaultParameters(getDefinition(type)!), ...parameters },
    connections: next ? { main: [{ targetId: next }] } : {},
  });
  const graph = workflowGraphSchema.parse({
    nodes: [
      node("start", "trigger.manual", 0, {}, "ping"),
      node("ping", "app.ntfy.send", 250, {
        credential: String(cred!._id),
        topic,
        title: "Hello from Conduit",
        message: `It works! Sent at ${new Date().toLocaleTimeString()}.`,
        priority: "4",
        tags: "tada",
        click: "http://localhost:3000",
      }),
    ],
  });
  const runtime = createRuntime(db, {}, {}, { integrations });
  const id = await runtime.createExecution(
    { workspaceId, workflowId: new ObjectId(), workflowName: "ntfy check", versionId: null, mode: "test", graph, triggerNodeId: "start", triggerItems: [{ json: {} }] },
    false,
  );
  const done = await runtime.processExecution(id);
  const step = await runtime.collections.steps.findOne({ executionId: id, nodeId: "ping" });
  console.log(`Run: ${done.status}${done.error ? ` (${done.error.message})` : ""}`);
  console.log(`Step output: ${JSON.stringify(step?.output.main?.map((i) => i.json) ?? step?.error)}`);

  // Read the topic's recent messages straight from ntfy.sh.
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=5m`);
  const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; title?: string; message?: string });
  const mine = lines.find((m) => m.id === (step?.output.main?.[0]?.json as { id?: string } | undefined)?.id);
  console.log(mine ? `ntfy.sh has it: "${mine.title}" / "${mine.message}"` : "ntfy.sh doesn't show the message yet");
} finally {
  await client.close();
}
