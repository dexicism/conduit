/**
 * Creates and publishes "Telegram AI bot": a message to your bot -> the AI
 * writes a reply (remembering the chat) -> the bot sends it. Uses the first
 * Telegram account saved in Connections. Run with the app's database running:
 *
 *   npx tsx scripts/telegram-ai-bot.mts
 */
import { workflowGraphSchema } from "@conduit/core";
import { defaultParameters, getDefinition } from "@conduit/nodes";
import { createTriggerService, integrationsFromEnv } from "@conduit/runtime";
import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/?replicaSet=rs0";
const client = await MongoClient.connect(uri);
const db = client.db(process.env.MONGODB_DB ?? "conduit");
try {
  const cred = await db.collection("credentials").findOne({ app: "telegram" }, { sort: { createdAt: -1 } });
  if (!cred) throw new Error("No Telegram account saved. Add one in Connections first.");
  const workspaceId = cred.workspaceId as ObjectId;
  const ws = await db.collection("workspaces").findOne({ _id: workspaceId });
  const userId = String(ws?.ownerId ?? "script");
  const credential = String(cred._id);

  const node = (id: string, type: string, label: string, x: number, parameters: Record<string, unknown>, next?: string) => ({
    id,
    type,
    label,
    position: { x, y: 0 },
    parameters: { ...defaultParameters(getDefinition(type)!), ...parameters },
    connections: next ? { main: [{ targetId: next }] } : {},
  });
  const graph = workflowGraphSchema.parse({
    nodes: [
      node("tg", "trigger.telegram", "Message to the bot", 0, { credential }, "ai"),
      node(
        "ai",
        "ai.agent",
        "Write a reply",
        280,
        {
          instructions: "You are a friendly assistant chatting on Telegram. Reply briefly (1-3 sentences) in the language the person writes in.",
          prompt: "${['$input']['message']['text']}",
          effort: "low",
          memory: "window",
          sessionKey: "${['$input']['message']['chat']['id']}",
          memoryTurns: 10,
        },
        "reply",
      ),
      node("reply", "app.telegram.send", "Send the reply", 560, {
        credential,
        chatId: "${['tg']['message']['chat']['id']}",
        text: "${['$input']['output']}",
      }),
    ],
  });

  const name = "Telegram AI bot";
  const existing = await db.collection("workflows").findOne({ workspaceId, name, archivedAt: null });
  const now = new Date();
  const workflowId = (existing?._id as ObjectId | undefined) ?? new ObjectId();
  if (existing) {
    await db.collection("workflows").updateOne({ _id: workflowId }, { $set: { draft: graph, updatedAt: now }, $inc: { revision: 1 } });
  } else {
    await db.collection("workflows").insertOne({
      _id: workflowId, workspaceId, name, description: "Replies to Telegram messages with the AI.", revision: 1, draft: graph,
      publishedVersionId: null, archivedAt: null, createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now,
    });
  }

  const { integrations } = integrationsFromEnv(db, { allowPrivateNetwork: false });
  const triggers = createTriggerService(db, client, {
    telegram: {
      urlFor: (p) => p,
      register: (w, c) => integrations.telegram.deleteWebhook(w, c, true),
      unregister: async () => {},
    },
  });
  await triggers.publish(workspaceId, workflowId, userId);
  console.log(`Published "${name}" (${workflowId}). Message your bot to try it.`);
} finally {
  await client.close();
}
