/**
 * Adds an "ntfy: phone notification" step to the end of an existing workflow
 * and publishes it again. Everything already in the workflow stays as it is.
 *
 *   WORKFLOW="Telegram AI bot" TOPIC=my-topic MESSAGE="New message: ..." npx tsx scripts/add-phone-ping.mts
 */
import { workflowGraphSchema, type WorkflowGraph } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { createTriggerService, integrationsFromEnv, telegramModeFromEnv } from "@conduit/runtime";
import { MongoClient, ObjectId } from "mongodb";

const name = process.env.WORKFLOW;
const topic = process.env.TOPIC;
if (!name || !topic) throw new Error("Set WORKFLOW (its name) and TOPIC");

const client = await MongoClient.connect(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0");
const db = client.db(process.env.MONGODB_DB ?? "conduit");
try {
  const wf = await db.collection("workflows").findOne({ name, archivedAt: null });
  if (!wf) throw new Error(`No workflow called "${name}"`);
  const workspaceId = wf.workspaceId as ObjectId;
  const ntfy = await db.collection("credentials").findOne({ app: "ntfy", workspaceId });
  if (!ntfy) throw new Error("No ntfy connection in that workspace. Add one under Connections (or run scripts/try-ntfy.mts).");

  const graph = workflowGraphSchema.parse(wf.draft) as WorkflowGraph;
  if (graph.nodes.some((n) => n.type === "app.ntfy.send")) {
    console.log("It already has a phone ping. Nothing to do.");
  } else {
    // The last step: one with no outgoing connections (the end of the chain).
    const last = graph.nodes.filter((n) => !n.type.startsWith("trigger.") && !Object.values(n.connections ?? {}).some((c) => c?.length)).at(-1) ?? graph.nodes.at(-1)!;
    const id = "ping";
    graph.nodes.push({
      id,
      type: "app.ntfy.send",
      label: "Ping my phone",
      position: { x: last.position.x + 280, y: last.position.y },
      parameters: {
        ...defaultParameters(getDefinition("app.ntfy.send")!),
        credential: String(ntfy._id),
        topic,
        title: process.env.TITLE ?? name,
        message: process.env.MESSAGE ?? "Your workflow just ran.",
      },
      connections: {},
    } as WorkflowGraph["nodes"][number]);
    last.connections = { ...(last.connections ?? {}), main: [...((last.connections as { main?: Array<{ targetId: string }> })?.main ?? []), { targetId: id }] };

    const parsed = workflowGraphSchema.parse(graph);
    const owner = String((await db.collection("workspaces").findOne({ _id: workspaceId }))?.ownerId ?? "script");
    await db.collection("workflows").updateOne({ _id: wf._id }, { $set: { draft: parsed, updatedAt: new Date(), updatedBy: owner }, $inc: { revision: 1 } });

    if (wf.publishedVersionId) {
      const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: false });
      const polling = telegramModeFromEnv() === "polling";
      const triggers = createTriggerService(db, client, {
        telegram: polling
          ? { urlFor: (p) => p, register: (w, c) => integrations.telegram.deleteWebhook(w, c, true), unregister: async () => {} }
          : { urlFor: (p) => `${process.env.PUBLIC_URL}/hook/telegram/${p}`, register: (w, c, u, s) => integrations.telegram.setWebhook(w, c, u, s), unregister: (w, c) => integrations.telegram.deleteWebhook(w, c) },
      });
      await triggers.publish(workspaceId, wf._id as ObjectId, owner);
      console.log(`Added "Ping my phone" after "${last.label}" and published "${name}" again.`);
    } else {
      console.log(`Added "Ping my phone" after "${last.label}". The workflow isn't published, so publish it when you're ready.`);
    }
  }
} finally {
  await client.close();
}
